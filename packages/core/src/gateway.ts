// Gateway: central session registry + approval broker + event fanout.
// One gateway serves every client surface (web/tui/cli/gui) over a single
// normalized protocol. Writers are serialized per session (single active
// driver per gatewayId) — the failure mode cross-agent_mcp hit (two
// concurrent resumes forking one session) is structurally prevented here.

import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeDriver } from './agents/claude.ts';
import { CodexDriver } from './agents/codex.ts';
import { MockDriver } from './agents/mock.ts';
import { discoverClaudeSessions, discoverCodexSessions } from './discovery.ts';
import { discoverOpenCodeSessions, OpenCodeDriver } from './agents/opencode.ts';
import type { AgentDriver, ApprovalDecision, ApprovalRequest, SessionEvent, SessionRef } from './types.ts';

export interface GatewayEvents {
  event: (sessionId: string, event: SessionEvent) => void;
  approval: (request: ApprovalRequest) => void;
  sessionsChanged: () => void;
}

export type ApprovalPolicy = 'interactive' | 'allow' | 'deny';

export interface GatewayOptions {
  /** Extra env passed to spawned claude processes (model provider overrides). */
  claudeEnv?: Record<string, string>;
  /** OpenCode server URL for the opencode driver + discovery. */
  opencodeUrl?: string;
  /** How gateway-brokered approvals resolve without a human:
   *  interactive (default: wait for a client) | allow | deny. */
  approvalPolicy?: ApprovalPolicy;
  /** Auto-deny interactive approvals after this long (ms). 0 = wait forever. */
  approvalTimeoutMs?: number;
}

export class Gateway {
  readonly bus = new EventEmitter();
  private drivers = new Map<string, AgentDriver>();
  private sessionIndex = new Map<string, SessionRef>();
  private approvals = new Map<string, { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void }>();
  private claudeEnv?: Record<string, string>;
  private opencodeUrl: string;
  private approvalPolicy: ApprovalPolicy;
  private approvalTimeoutMs: number;
  private opening = new Map<string, Promise<SessionRef>>();

  constructor(opts: GatewayOptions = {}) {
    this.claudeEnv = opts.claudeEnv;
    this.opencodeUrl = opts.opencodeUrl ?? 'http://127.0.0.1:4096';
    this.approvalPolicy = opts.approvalPolicy ?? 'interactive';
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 0;
  }

  on<K extends keyof GatewayEvents>(ev: K, cb: GatewayEvents[K]): void {
    this.bus.on(ev, cb);
  }

  /** Refresh the session index from every discoverable agent. */
  async refreshSessions(): Promise<SessionRef[]> {
    const [claude, codex, opencode] = await Promise.all([
      discoverClaudeSessions().catch(() => [] as SessionRef[]),
      discoverCodexSessions().catch(() => [] as SessionRef[]),
      discoverOpenCodeSessions(this.opencodeUrl).catch(() => [] as SessionRef[]),
    ]);
    for (const s of [...claude, ...codex, ...opencode]) {
      const prev = this.sessionIndex.get(s.gatewayId);
      this.sessionIndex.set(s.gatewayId, { ...s, active: this.drivers.has(s.gatewayId) || Boolean(prev?.active) });
    }
    this.bus.emit('sessionsChanged');
    return this.listSessions();
  }

  listSessions(): SessionRef[] {
    return [...this.sessionIndex.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  // ---- discovery auto-refresh --------------------------------------------
  private watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;

  /** Watch native session stores and refresh the index as they change.
   *  Native sessions are append-only files; every write is a session update. */
  startWatching(): void {
    const roots = [
      path.join(homedir(), '.claude', 'projects'),
      path.join(homedir(), '.codex', 'sessions'),
    ];
    for (const root of roots) {
      try {
        const w = watch(root, { recursive: true }, () => this.#scheduleRefresh());
        this.watchers.push(w);
      } catch {
        /* store not present on this machine */
      }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
  }

  /** Debounced: claude/codex append continuously during turns — coalesce. */
  #scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSessions().catch(() => { /* transient */ });
    }, 800);
  }

  getSession(gatewayId: string): SessionRef | undefined {
    return this.sessionIndex.get(gatewayId);
  }

  upsertSession(ref: SessionRef): void {
    this.sessionIndex.set(ref.gatewayId, ref);
    this.bus.emit('sessionsChanged');
  }

  /**
   * Open a live driver for a session. One writer per gatewayId: an already
   * active driver is reused (second client just subscribes to its events).
   * Concurrent first-opens coalesce onto a single in-flight open (mutex).
   */
  openSession(gatewayId: string): Promise<SessionRef> {
    const inflight = this.opening.get(gatewayId);
    if (inflight) return inflight;
    const p = this.#openSessionLocked(gatewayId).finally(() => this.opening.delete(gatewayId));
    this.opening.set(gatewayId, p);
    return p;
  }

  async #openSessionLocked(gatewayId: string): Promise<SessionRef> {
    const existing = this.drivers.get(gatewayId);
    if (existing) return this.sessionIndex.get(gatewayId)!;
    const [agent, nativeId] = this.#parseId(gatewayId);
    const ref = this.sessionIndex.get(gatewayId) ?? {
      gatewayId, agent, nativeId, title: nativeId, cwd: process.cwd(), updatedAtMs: Date.now(), active: false,
    };
    const driver = this.#createDriver(agent, nativeId, ref);
    this.#wireDriver(gatewayId, agent, driver);
    await driver.start();
    this.drivers.set(gatewayId, driver);
    this.upsertSession({ ...ref, active: true });
    return this.sessionIndex.get(gatewayId)!;
  }

  #wireDriver(gatewayId: string, agent: 'claude' | 'codex' | 'mock' | 'opencode', driver: AgentDriver): void {
    driver.events.on('data', (event: SessionEvent) => {
      this.bus.emit('event', gatewayId, event);
    });
    // Approval fanout — the gateway core value-add.
    driver.events.on('approval', (raw: { requestId: string; tool: string; input: unknown; options: unknown }) => {
      const request: ApprovalRequest = {
        requestId: raw.requestId,
        sessionId: gatewayId,
        agent,
        tool: raw.tool,
        input: raw.input,
        options: raw.options as ApprovalRequest['options'],
        createdAtMs: Date.now(),
      };
      const resolveAndAudit = (optionId: string, note: string) => {
        this.approvals.delete(raw.requestId);
        void driver.resolveApproval(raw.requestId, optionId).catch(() => { /* driver may be gone */ });
        this.bus.emit('event', gatewayId, {
          type: 'status', status: 'busy', detail: note } as SessionEvent,
        );
      };
      const policy = this.approvalPolicy;
      if (policy === 'allow') {
        resolveAndAudit('allow_once', 'approval auto-allowed (policy=allow)');
        return;
      }
      if (policy === 'deny') {
        resolveAndAudit('deny_once', 'approval auto-denied (policy=deny)');
        return;
      }
      const entry: { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void; timer?: NodeJS.Timeout } = {
        request,
        resolve: (decision) => {
          if (entry.timer) clearTimeout(entry.timer);
          this.approvals.delete(raw.requestId);
          void driver.resolveApproval(decision.requestId, decision.optionId);
          this.bus.emit('event', gatewayId, {
            type: 'status', status: 'busy', detail: `approval ${decision.optionId}` } as SessionEvent,
          );
        },
      };
      if (this.approvalTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.approvals.has(raw.requestId)) {
            entry.resolve({ requestId: raw.requestId, optionId: 'deny_once' });
          }
        }, this.approvalTimeoutMs);
      }
      this.approvals.set(raw.requestId, entry);
      this.bus.emit('approval', request);
    });
  }

  /**
   * Create a brand-new Claude session (resume:false) and open its driver.
   * Returns the session ref once the driver is live.
   */
  async createClaudeSession(cwd: string, title?: string): Promise<SessionRef> {
    const nativeId = randomUUID();
    const gatewayId = `claude:${nativeId}`;
    this.upsertSession({
      gatewayId, agent: 'claude', nativeId,
      title: title ?? nativeId, cwd,
      updatedAtMs: Date.now(), active: false,
    });
    const driver = new ClaudeDriver({ sessionId: nativeId, cwd, resume: false, env: this.claudeEnv });
    this.#wireDriver(gatewayId, 'claude', driver);
    await driver.start();
    this.drivers.set(gatewayId, driver);
    const ref = this.sessionIndex.get(gatewayId)!;
    this.upsertSession({ ...ref, active: true });
    return this.sessionIndex.get(gatewayId)!;
  }

  async prompt(gatewayId: string, text: string): Promise<void> {
    const driver = this.drivers.get(gatewayId);
    if (!driver) throw new Error(`session not open: ${gatewayId}`);
    await driver.prompt(text);
  }

  async interrupt(gatewayId: string): Promise<void> {
    const driver = this.drivers.get(gatewayId);
    if (!driver) throw new Error(`session not open: ${gatewayId}`);
    await driver.interrupt();
  }

  listApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((a) => a.request);
  }

  resolveApproval(decision: ApprovalDecision): void {
    const entry = this.approvals.get(decision.requestId);
    if (!entry) throw new Error(`unknown approval request: ${decision.requestId}`);
    entry.resolve(decision);
  }

  async closeSession(gatewayId: string): Promise<void> {
    const driver = this.drivers.get(gatewayId);
    if (!driver) return;
    await driver.stop();
    this.drivers.delete(gatewayId);
    const ref = this.sessionIndex.get(gatewayId);
    if (ref) this.upsertSession({ ...ref, active: false });
  }

  #parseId(gatewayId: string): [ 'claude' | 'codex' | 'mock' | 'opencode', string ] {
    const idx = gatewayId.indexOf(':');
    if (idx < 0) throw new Error(`invalid gatewayId: ${gatewayId}`);
    const agent = gatewayId.slice(0, idx);
    const nativeId = gatewayId.slice(idx + 1);
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'mock' && agent !== 'opencode') throw new Error(`unknown agent: ${agent}`);
    return [agent, nativeId];
  }

  #createDriver(agent: 'claude' | 'codex' | 'mock' | 'opencode', nativeId: string, ref: SessionRef): AgentDriver {
    switch (agent) {
      case 'claude':
        return new ClaudeDriver({ sessionId: nativeId, cwd: ref.cwd || process.cwd(), resume: true, env: this.claudeEnv });
      case 'codex':
        return new CodexDriver({ threadId: nativeId, cwd: ref.cwd || process.cwd() });
      case 'mock':
        return new MockDriver(nativeId);
      case 'opencode':
        return new OpenCodeDriver({ sessionId: nativeId, baseUrl: this.opencodeUrl });
    }
  }
}

export function newRequestId(): string {
  return randomUUID();
}
