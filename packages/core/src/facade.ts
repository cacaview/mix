// Codex App Server facade: speaks the Codex app-server JSON-RPC protocol so
// NATIVE Codex clients (TUI `--remote`, future GUI) can browse and drive
// sessions that actually live in other runtimes (Claude Code today).
//
// Design (preserves the project rule "sessions stay in their native runtime"):
//  - thread/list = union of upstream Codex threads + claude threads
//    (claude threadIds are prefixed `claude:` and treated as opaque).
//  - requests targeting claude:* are handled locally via the Gateway
//    (ClaudeDriver prompt/events); everything else proxies to a real
//    `codex app-server` child so Codex-native sessions keep working.
//  - SessionEvent from claude drivers is mapped into app-server
//    notifications (turn/started, item/started, item/completed,
//    turn/completed, thread/status/changed) and broadcast to facade clients.
//  - Approvals go to the gateway approval broker (web/tui clients answer);
//    the codex client's turn simply stays in progress until resolved.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { tokenOk } from './auth.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Gateway } from './gateway.ts';
import type { SessionEvent, SessionRef } from './types.ts';

export interface FacadeOptions {
  port: number;
  host?: string;
  /** Bearer token required on WS upgrades (Authorization header or ?token=). */
  token?: string;
  codexPath?: string;
  /** When false, no upstream codex app-server is spawned (claude-only list). */
  upstream?: boolean;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

function threadListItemFromRef(ref: SessionRef): Record<string, unknown> {
  const nowSec = Math.floor(ref.updatedAtMs / 1000);
  return {
    id: ref.gatewayId,
    environments: [{ environmentId: 'gateway', cwd: ref.cwd }],
    extra: null,
    sessionId: ref.gatewayId,
    forkedFromId: null,
    parentThreadId: null,
    preview: ref.title,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'legacy',
    modelProvider: 'gateway',
    model: ref.agent,
    reasoningEffort: null,
    createdAt: nowSec,
    updatedAt: nowSec,
    recencyAt: nowSec,
    status: { type: ref.active ? 'idle' : 'notLoaded' },
    cwd: ref.cwd,
    cliVersion: 'gateway',
    originator: 'mix',
    source: 'gateway',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: ref.title,
    daybreakEnabled: null,
    turns: [],
  };
}

export function serveFacade(gateway: Gateway, opts: FacadeOptions): { close(): Promise<void>; port: number } {
  const httpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!tokenOk(req, opts.token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  // ---- upstream codex app-server child (proxy target) --------------------
  let upstream: ChildProcessWithoutNullStreams | null = null;
  let upBuf = '';
  const upPending = new Map<number, Pending>();
  let upNextId = 1;

  function upCall(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!upstream?.stdin.writable) return reject(new Error('upstream codex app-server unavailable'));
      const id = upNextId++;
      upPending.set(id, { resolve, reject });
      upstream.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (upPending.has(id)) { upPending.delete(id); reject(new Error(`upstream timeout: ${method}`)); }
      }, 30_000);
    });
  }

  function startUpstream(): void {
    if (opts.upstream === false) return;
    try {
      upstream = spawn(opts.codexPath ?? 'codex', ['app-server'], {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      upstream = null;
      return;
    }
    // Missing codex binary must not take the facade down — degrade to
    // claude-only service (spawn failures surface asynchronously as 'error').
    upstream.on('error', () => {
      console.error('[facade] upstream codex unavailable; serving gateway-hosted threads only');
      upstream = null;
    });
    upstream.stdout.setEncoding('utf8');
    upstream.stdout.on('data', (chunk: string) => {
      upBuf += chunk;
      let idx: number;
      while ((idx = upBuf.indexOf('\n')) >= 0) {
        const line = upBuf.slice(0, idx).trim();
        upBuf = upBuf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && upPending.has(msg.id)) {
          const p = upPending.get(msg.id)!;
          upPending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'upstream error'));
          else p.resolve(msg.result);
        } else if (msg.method) {
          // Upstream notifications (codex thread events) flow to facade clients.
          broadcast(msg);
        }
      }
    });
    upstream.on('exit', () => { upstream = null; });
    void upCall('initialize', {
      clientInfo: { name: 'mix-facade', title: 'ASG Facade', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).catch(() => { /* upstream optional */ });
  }

  // ---- claude driver event → app-server notification mapping -------------
  gateway.on('event', (gatewayId: string, event: SessionEvent) => {
    if (!gatewayId.startsWith('claude:')) return;
    const threadId = gatewayId;
    const notifications: unknown[] = [];
    switch (event.type) {
      case 'turn.started':
        notifications.push({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
        notifications.push({ method: 'turn/started', params: { threadId, turn: { id: event.turnId, rootTurnId: event.turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null } } });
        break;
      case 'message.completed':
        if (event.role === 'assistant') {
          const itemId = `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
          notifications.push({ method: 'item/started', params: { threadId, item: { type: 'agentMessage', id: itemId, content: [] } } });
          notifications.push({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', id: itemId, content: [{ type: 'text', text: event.text }] } } });
        }
        break;
      case 'tool.started':
        notifications.push({ method: 'item/started', params: { threadId, item: { type: 'toolCall', id: event.toolCallId, tool: event.tool, input: event.input, status: 'inProgress' } } });
        break;
      case 'tool.completed':
        notifications.push({ method: 'item/completed', params: { threadId, item: { type: 'toolCall', id: event.toolCallId, tool: 'tool', output: event.output, status: event.isError ? 'error' : 'completed' } } });
        break;
      case 'turn.completed':
        notifications.push({ method: 'turn/completed', params: { threadId, turn: { id: event.turnId, status: event.error ? 'failed' : 'completed', error: event.error ?? null } } });
        notifications.push({ method: 'thread/status/changed', params: { threadId, status: { type: event.error ? 'systemError' : 'idle' } } });
        break;
      case 'status':
        notifications.push({ method: 'thread/status/changed', params: { threadId, status: { type: event.status === 'busy' ? 'active' : event.status === 'idle' ? 'idle' : 'systemError' } } });
        break;
      default:
        break;
    }
    for (const n of notifications) broadcast(n);
  });

  // ---- facade request handling -------------------------------------------
  wss.on('connection', (ws) => {
    console.error('[facade] client connected');
    clients.add(ws);
    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const { id, method, params } = msg;
      if (id === undefined) return; // ignore client notifications in v0
      console.error(`[facade] -> ${method}`);
      try {
        const result = await handleRequest(method, params);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch (err) {
        console.error(`[facade] ${method} failed: ${err instanceof Error ? err.message : err}`);
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }));
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  async function handleRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          userAgent: 'mix-facade/0.1.0',
          codexHome: '',
          platformFamily: 'node',
          platformOs: process.platform,
        };
      case 'account/read':
        // The facade answers identity locally so native clients don't block
        // on upstream auth for gateway-hosted threads.
        return { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
      case 'thread/list': {
        let upstreamData: any[] = [];
        if (upstream) {
          try {
            const res: any = await upCall('thread/list', params ?? {});
            upstreamData = res?.data ?? [];
          } catch { /* upstream optional */ }
        }
        const claude = gateway.listSessions().filter((s) => s.agent === 'claude').map(threadListItemFromRef);
        const seen = new Set(claude.map((t) => t.id));
        return { data: [...claude, ...upstreamData.filter((t) => !seen.has(t.id))] };
      }
      case 'thread/start': {
        // "New chat" from a native codex client creates a Claude session on
        // this host (the mix default; runtime selection lands later).
        const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : process.cwd();
        const ref = await gateway.createClaudeSession(cwd, params?.title ?? 'New chat (via facade)');
        return { thread: threadListItemFromRef({ ...ref, active: true }) };
      }
      case 'thread/resume': {
        const threadId = String(params?.threadId ?? '');
        if (!threadId.startsWith('claude:')) return upCall(method, params);
        const ref = await gateway.openSession(threadId);
        return { thread: threadListItemFromRef({ ...ref, active: true }) };
      }
      case 'turn/start': {
        const threadId = String(params?.threadId ?? '');
        if (!threadId.startsWith('claude:')) return upCall(method, params);
        if (!gateway.getSession(threadId)) await gateway.openSession(threadId);
        const text = (params?.input ?? []).filter((i: any) => i?.type === 'text').map((i: any) => i.text).join('\n');
        await gateway.prompt(threadId, text);
        return { turn: { id: 'pending', status: 'inProgress' } };
      }
      case 'turn/interrupt': {
        const threadId = String(params?.threadId ?? '');
        if (!threadId.startsWith('claude:')) return upCall(method, params);
        await gateway.interrupt(threadId);
        return {};
      }
      case 'thread/loaded/list': {
        const loaded = gateway.listSessions().filter((s) => s.active && s.agent === 'claude').map((s) => s.gatewayId);
        let upstreamLoaded: string[] = [];
        if (upstream) {
          try {
            const res: any = await upCall('thread/loaded/list', {});
            upstreamLoaded = res?.data ?? [];
          } catch { /* optional */ }
        }
        return { data: [...loaded, ...upstreamLoaded] };
      }
      default:
        if (upstream) return upCall(method, params);
        throw new Error(`facade: no upstream for method ${method}`);
    }
  }

  wss.on('error', (err) => console.error('[facade] server error:', err.message));

  startUpstream();

  httpServer.listen(opts.port, opts.host ?? '127.0.0.1');

  return {
    port: opts.port,
    close: () => new Promise<void>((done) => {
      try { upstream?.kill(); } catch { /* ignore */ }
      wss.close();
      httpServer.close(() => done());
    }),
  };
}
