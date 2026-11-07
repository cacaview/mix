// Codex driver: connects to `codex app-server` over stdio (JSON-RPC).
//
// Verified protocol surface (codex 0.167.0, exp02/03):
//   initialize / thread/list / thread/resume / thread/start /
//   turn/start / turn/interrupt + broadcast notifications
//   (thread/started, thread/status/changed, turn/started, item/started, ...)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentDriver, SessionEvent } from '../types.ts';

export interface CodexDriverOptions {
  threadId: string;
  cwd: string;
  codexPath?: string;
}

export class CodexDriver implements AgentDriver {
  readonly agent = 'codex' as const;
  readonly nativeId: string;
  readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private opts: CodexDriverOptions;

  constructor(opts: CodexDriverOptions) {
    this.opts = opts;
    this.nativeId = opts.threadId;
  }

  async start(): Promise<void> {
    const bin = this.opts.codexPath ?? 'codex';
    this.child = spawn(bin, ['app-server'], {
      cwd: this.opts.cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Surface spawn failures (missing binary) as a rejected start() instead of
    // an unhandled 'error' event that would kill the gateway process.
    const spawnFailure = new Promise<never>((_, reject) => {
      this.child!.on('error', (err) => reject(new Error(`codex spawn failed: ${err.message}`)));
    });
    this.child.stdout.setEncoding('utf8');
    let buf = '';
    this.child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.#handleMessage(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    });
    const init = this.#call('initialize', {
      clientInfo: { name: 'mix', title: 'Agent Session Gateway', version: '0.1.0' },
    });
    await Promise.race([init, spawnFailure]);
    // Attach to the thread: memory-first, rollout fallback (verified exp03b).
    await this.#call('thread/resume', { threadId: this.opts.threadId });
  }

  #handleMessage(msg: any): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    const { method, params } = msg;
    switch (method) {
      case 'turn/started':
        this.lastTurnId = params?.turn?.id ?? this.lastTurnId;
        this.events.emit('data', { type: 'turn.started', turnId: params?.turn?.id ?? '' } satisfies SessionEvent);
        break;
      case 'item/started': {
        const item = params?.item ?? {};
        if (item.type === 'toolCall' || item.type === 'tool_call') {
          this.events.emit('data', { type: 'tool.started', toolCallId: item.id, tool: item.tool ?? item.name ?? 'tool', input: item.input ?? item.arguments } satisfies SessionEvent);
        } else if (item.type === 'agentMessage' || item.type === 'AgentMessage') {
          // content streams separately via item/completed in v2 exp; deltas not present.
        }
        break;
      }
      case 'item/completed': {
        const item = params?.item ?? {};
        if (item.type === 'agentMessage' || item.type === 'AgentMessage') {
          const text = (item.content ?? []).filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('\n');
          if (text) this.events.emit('data', { type: 'message.completed', role: 'assistant', text } satisfies SessionEvent);
        } else if (item.type === 'toolCall' || item.type === 'tool_call') {
          this.events.emit('data', { type: 'tool.completed', toolCallId: item.id, output: item.output ?? item.result } satisfies SessionEvent);
        } else if (item.type === 'reasoning' || item.type === 'Reasoning') {
          const text = (item.summary_text ?? []).join('\n');
          if (text) this.events.emit('data', { type: 'reasoning.delta', text } satisfies SessionEvent);
        }
        break;
      }
      case 'turn/completed':
        this.events.emit('data', { type: 'turn.completed', turnId: params?.turn?.id ?? '', error: params?.turn?.error ? String(params.turn.error) : undefined } satisfies SessionEvent);
        break;
      case 'thread/status/changed':
        this.events.emit('data', { type: 'status', status: params?.status?.type === 'active' ? 'busy' : params?.status?.type === 'idle' ? 'idle' : 'error' } satisfies SessionEvent);
        break;
      case 'error':
        this.events.emit('data', { type: 'status', status: 'error', detail: params?.error?.message } satisfies SessionEvent);
        break;
      default:
        break;
    }
  }

  #call(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('codex app-server not running'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  async prompt(text: string): Promise<void> {
    await this.#call('turn/start', {
      threadId: this.nativeId,
      input: [{ type: 'text', text }],
    });
  }

  async interrupt(): Promise<void> {
    // turn/interrupt needs threadId + turnId; without a tracked turnId we ask
    // the server to interrupt the latest turn via turn/steer's sibling API.
    // v0: interrupt is only enabled when the gateway saw turn/started.
    const turnId = this.lastTurnId;
    if (!turnId) throw new Error('no active turn observed');
    await this.#call('turn/interrupt', { threadId: this.nativeId, turnId });
  }

  private lastTurnId: string | null = null;

  async resolveApproval(): Promise<void> {
    throw new Error('codex approvals are handled by the app-server client, not the driver');
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }
}
