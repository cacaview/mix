// OpenCode driver: talks to a local `opencode serve` HTTP API.
//
// API surface (extracted from harness-remote's server.js usage — see
// investigation/repos/harness-remote/bridge/src/server.js:407-502):
//   GET  /global/health          → { healthy, version? }
//   GET  /session                → list sessions
//   POST /session                → create session  { title? }
//   GET  /session/:id/message    → messages page { messages? } or array
//   POST /session/:id/message    → send prompt { text | parts }, responds when done
//   POST /session/:id/abort      → stop running turn
//   GET  /global/event           → SSE global bus (session.updated, message.updated, ...)
//
// STATUS: 代码支持但未运行 — live verification pending opencode install.
// The driver maps SSE events into the gateway SessionEvent stream.

import { EventEmitter } from 'node:events';
import type { AgentDriver, SessionEvent } from '../types.ts';

export interface OpenCodeDriverOptions {
  sessionId: string;
  baseUrl: string; // e.g. http://127.0.0.1:4096
  username?: string;
  password?: string;
}

function authHeader(opts: OpenCodeDriverOptions): Record<string, string> {
  if (!opts.username || !opts.password) return {};
  const token = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

export class OpenCodeDriver implements AgentDriver {
  readonly agent = 'opencode' as const;
  readonly nativeId: string;
  readonly events = new EventEmitter();
  private opts: OpenCodeDriverOptions;
  private eventSource: EventSource | null = null;
  private lastTurnId: string | null = null;
  private stopped = false;

  constructor(opts: OpenCodeDriverOptions) {
    this.opts = opts;
    this.nativeId = opts.sessionId;
  }

  private url(p: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}${p}`;
  }

  async #fetch(p: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.url(p), {
      ...init,
      headers: { 'content-type': 'application/json', ...authHeader(this.opts), ...(init.headers ?? {}) },
    });
  }

  async start(): Promise<void> {
    const health = await this.#fetch('/global/health');
    if (!health.ok) throw new Error(`opencode not reachable at ${this.opts.baseUrl}`);
    this.#subscribeEvents();
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  /** Subscribe to the OpenCode global SSE bus and filter to this session.
   * Optional enhancement: prompt() parses the synchronous response, so the
   * driver works without SSE (EventSource unavailable in some runtimes). */
  #subscribeEvents(): void {
    if (typeof globalThis.EventSource !== 'function') return;
    const es = new globalThis.EventSource(this.url('/global/event'), {
      headers: authHeader(this.opts),
    } as EventSourceInit);
    this.eventSource = es;
    es.onmessage = (ev) => {
      if (this.stopped) return;
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg.type ?? '';
      const props = msg.properties ?? msg;
      if (props.sessionID !== this.nativeId) return;
      switch (type) {
        case 'session.updated':
          this.events.emit('data', { type: 'status', status: props.info?.status ?? 'idle' } satisfies SessionEvent);
          break;
        case 'message.updated': {
          const role = props.info?.role;
          const parts = props.parts ?? [];
          for (const part of parts) {
            if (part.type === 'text' && role === 'assistant') {
              this.events.emit('data', { type: 'message.completed', role: 'assistant', text: part.text } satisfies SessionEvent);
            } else if (part.type === 'reasoning') {
              this.events.emit('data', { type: 'reasoning.delta', text: part.text } satisfies SessionEvent);
            } else if (part.type === 'tool') {
              const se: SessionEvent = part.state?.status === 'completed'
                ? { type: 'tool.completed', toolCallId: part.id ?? part.callID ?? '', output: part.state?.output, isError: part.state?.status === 'error' }
                : { type: 'tool.started', toolCallId: part.id ?? part.callID ?? '', tool: part.tool, input: part.state?.input };
              this.events.emit('data', se);
            }
          }
          break;
        }
        case 'session.idle':
          this.events.emit('data', { type: 'turn.completed', turnId: this.lastTurnId ?? '' } satisfies SessionEvent);
          this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
          break;
        case 'session.error':
          this.events.emit('data', { type: 'turn.completed', turnId: this.lastTurnId ?? '', error: String(props.error ?? 'error') } satisfies SessionEvent);
          break;
        default:
          break;
      }
    };
    es.onerror = () => {
      if (this.stopped) return;
      this.events.emit('data', { type: 'status', status: 'error', detail: 'event stream error; reconnecting' } satisfies SessionEvent);
    };
  }

  async prompt(text: string): Promise<void> {
    this.lastTurnId = `oc-${Date.now()}`;
    this.events.emit('data', { type: 'turn.started', turnId: this.lastTurnId } satisfies SessionEvent);
    // Verified live (opencode 1.19.5): body takes a `parts` array; the POST
    // blocks until the turn finishes and returns the completed assistant
    // message with its parts (step-start / text / tool / step-finish).
    const res = await this.#fetch(`/session/${this.nativeId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.events.emit('data', { type: 'turn.completed', turnId: this.lastTurnId, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` } satisfies SessionEvent);
      return;
    }
    const msg: any = await res.json().catch(() => null);
    for (const part of msg?.parts ?? []) {
      if (part.type === 'text' && part.text) {
        this.events.emit('data', { type: 'message.completed', role: 'assistant', text: part.text } satisfies SessionEvent);
      } else if (part.type === 'reasoning' && part.text) {
        this.events.emit('data', { type: 'reasoning.delta', text: part.text } satisfies SessionEvent);
      } else if (part.type === 'tool') {
        const done = part.state?.status === 'completed' || part.state?.status === 'error';
        const se: SessionEvent = done
          ? { type: 'tool.completed', toolCallId: part.id ?? part.callID ?? part.tool ?? '', output: part.state?.output, isError: part.state?.status === 'error' }
          : { type: 'tool.started', toolCallId: part.id ?? part.callID ?? part.tool ?? '', tool: part.tool ?? 'tool', input: part.state?.input };
        this.events.emit('data', se);
      }
    }
    this.events.emit('data', { type: 'turn.completed', turnId: this.lastTurnId } satisfies SessionEvent);
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  async interrupt(): Promise<void> {
    await this.#fetch(`/session/${this.nativeId}/abort`, { method: 'POST' });
  }

  async resolveApproval(): Promise<void> {
    // OpenCode asks questions via its own /question API; v0 gateway does not
    // map OpenCode approvals (harness-remote also skips this).
    throw new Error('opencode approvals not mapped in gateway v0');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.eventSource?.close();
    this.eventSource = null;
  }
}

/** List OpenCode sessions from a running server. */
export async function discoverOpenCodeSessions(baseUrl: string, username?: string, password?: string): Promise<import('../types.ts').SessionRef[]> {
  const headers = authHeader({ baseUrl, sessionId: '', username, password });
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/session`, { headers });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data: unknown = await res.json().catch(() => []);
  const items: any[] = Array.isArray(data) ? data : (data as any)?.data ?? [];
  return items.map((s: any) => ({
    gatewayId: `opencode:${s.id}`,
    agent: 'opencode' as const,
    nativeId: s.id,
    title: s.title ?? s.id,
    cwd: s.directory ?? s.cwd ?? '',
    updatedAtMs: typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(s.updatedAt ?? '') || 0,
    active: false,
  }));
}
