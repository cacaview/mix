// Generic ACP (Agent Client Protocol) stdio driver.
//
// One driver, many agents: any process speaking ACP v1 over stdio becomes a
// mix-supported agent — Gemini CLI (--experimental-acp), Qwen Code, Pi/OMP via
// their adapters, Claude Code via @agentclientprotocol/claude-agent-acp, etc.
//
// Mapping (ACP v1):
//   initialize                        -> handshake (fs capabilities off)
//   session/new {cwd, mcpServers}     -> new native session id
//   session/prompt {sessionId, prompt}-> blocking until stopReason
//   session/update (notification)     -> SessionEvent stream
//   session/request_permission (req)  -> gateway approval broker (this is the
//                                        capability harness-remote skips)
//   session/cancel                    -> interrupt

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentDriver, ApprovalOption, SessionEvent } from '../types.ts';

export interface AcpAgentProfile {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AcpDriverOptions {
  profile: AcpAgentProfile;
  cwd: string;
  env?: Record<string, string>;
}

const FALLBACK_OPTIONS: ApprovalOption[] = [
  { id: 'allow_once', label: 'Allow once', kind: 'allow' },
  { id: 'deny_once', label: 'Deny', kind: 'deny' },
];

export class AcpDriver implements AgentDriver {
  readonly agent = 'acp' as const;
  readonly nativeId: string;
  readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private opts: AcpDriverOptions;
  private acpSessionId: string | null = null;
  private toolCalls = new Map<string, { tool: string; input: unknown }>();

  constructor(opts: AcpDriverOptions) {
    this.opts = opts;
    // nativeId starts as the profile name; session/new replaces it with the
    // real ACP session id (surfaced through nativeId mutation).
    this.nativeId = opts.profile.name;
  }

  async start(): Promise<void> {
    const profile = this.opts.profile;
    this.child = spawn(profile.command, profile.args ?? [], {
      cwd: this.opts.cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env, ...profile.env },
    });
    const spawnFailure = new Promise<never>((_, reject) => {
      this.child!.on('error', (err) => reject(new Error(`acp spawn failed (${profile.command}): ${err.message}`)));
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.events.emit('data', { type: 'status', status: 'busy', detail: `[${profile.name}] ${chunk.trim().slice(0, 300)}` } satisfies SessionEvent);
    });
    const init = this.#call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await Promise.race([init, spawnFailure]);
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  #onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#handleMessage(msg);
    }
  }

  #handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const method: string = msg.method ?? '';
    if (method === 'session/update') {
      const update = msg.params?.update ?? {};
      const kind: string = update.sessionUpdate ?? '';
      switch (kind) {
        case 'agent_message_chunk': {
          const text = update.content?.text ?? update.content?.data ?? '';
          if (text) this.events.emit('data', { type: 'message.delta', role: 'assistant', text } satisfies SessionEvent);
          break;
        }
        case 'agent_thought_chunk': {
          const text = update.content?.text ?? '';
          if (text) this.events.emit('data', { type: 'reasoning.delta', text } satisfies SessionEvent);
          break;
        }
        case 'tool_call': {
          const id = update.toolCallId ?? randomUUID();
          this.toolCalls.set(id, { tool: update.title ?? update.kind ?? 'tool', input: update.rawInput ?? update.content });
          this.events.emit('data', { type: 'tool.started', toolCallId: id, tool: update.title ?? update.kind ?? 'tool', input: update.rawInput ?? update.content } satisfies SessionEvent);
          break;
        }
        case 'tool_call_update': {
          const id = update.toolCallId ?? '';
          const meta = this.toolCalls.get(id);
          const status: string = update.status ?? 'completed';
          const output = update.rawOutput ?? update.content ?? '';
          this.events.emit('data', {
            type: 'tool.completed',
            toolCallId: id,
            output,
            isError: status === 'failed',
          } satisfies SessionEvent);
          if (meta) this.toolCalls.delete(id);
          break;
        }
        case 'plan':
          this.events.emit('data', { type: 'status', status: 'busy', detail: `plan: ${update.entries?.length ?? 0} items` } satisfies SessionEvent);
          break;
        default:
          break;
      }
      return;
    }
    if (method === 'session/request_permission') {
      // msg.id is the JSON-RPC request id; use it verbatim as the broker
      // requestId so resolveApproval can answer the exact request.
      const requestId = String(msg.id);
      const params = msg.params ?? {};
      const options: ApprovalOption[] = Array.isArray(params.options)
        ? params.options.map((o: any) => ({
            id: o.optionId ?? o.name ?? 'allow_once',
            label: o.name ?? o.optionId ?? 'option',
            kind: (o.kind ?? '').startsWith('allow') ? 'allow' : 'deny',
          }))
        : FALLBACK_OPTIONS;
      this.pendingPermission = { requestId, params };
      this.events.emit('approval', {
        requestId,
        tool: params.toolCall?.title ?? 'tool',
        input: params.toolCall?.rawInput ?? params.toolCall,
        options,
      });
      return;
    }
    // Unsupported agent→client requests: fail politely so the agent continues.
    if (msg.id !== undefined && method) {
      this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `mix does not implement ${method}` } });
    }
  }

  private pendingPermission: { requestId: string; params: any } | null = null;

  #call(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('acp agent not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`acp timeout: ${method}`)); }
      }, 120_000);
    });
  }

  #send(obj: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('acp agent not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Create the native ACP session (called instead of resume semantics). */
  async newSession(): Promise<void> {
    const result = await this.#call('session/new', { cwd: this.opts.cwd, mcpServers: [] });
    this.acpSessionId = result?.sessionId ?? null;
    (this as { nativeId: string }).nativeId = this.acpSessionId ?? this.nativeId;
  }

  async prompt(text: string): Promise<void> {
    if (!this.acpSessionId) await this.newSession();
    const sessionId = this.acpSessionId;
    const turnId = `acp-${Date.now()}`;
    this.events.emit('data', { type: 'turn.started', turnId } satisfies SessionEvent);
    this.events.emit('data', { type: 'status', status: 'busy' } satisfies SessionEvent);
    try {
      const result = await this.#call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      const stopReason: string = result?.stopReason ?? 'end_turn';
      this.events.emit('data', {
        type: 'turn.completed',
        turnId,
        error: stopReason === 'refused' ? 'agent refused' : undefined,
      } satisfies SessionEvent);
    } catch (err) {
      this.events.emit('data', { type: 'turn.completed', turnId, error: String(err instanceof Error ? err.message : err) } satisfies SessionEvent);
    }
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  async interrupt(): Promise<void> {
    if (!this.acpSessionId) return;
    this.#send({ jsonrpc: '2.0', id: this.nextId++, method: 'session/cancel', params: { sessionId: this.acpSessionId } });
  }

  async resolveApproval(requestId: string, optionId: string): Promise<void> {
    // Answer the pending session/request_permission by its JSON-RPC id.
    if (!this.pendingPermission || this.pendingPermission.requestId !== requestId) return;
    const params = this.pendingPermission.params;
    const optionIds = (params.options ?? []).map((o: any) => o.optionId ?? o.name);
    const chosen = optionIds.includes(optionId) ? optionId : undefined;
    const outcome = chosen
      ? { outcome: 'selected', optionId: chosen }
      : { outcome: 'cancelled' };
    this.#send({ jsonrpc: '2.0', id: requestId, result: { outcome } });
    this.pendingPermission = null;
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }
}
