// Claude Code driver: spawns `claude -p` with bidirectional stream-json.
//
// Verified CLI surface (claude 2.1.224, exp04):
//   claude -p --input-format stream-json --output-format stream-json
//          --include-partial-messages --verbose [--resume <id> | --session-id <id>]
//
// Approval requests arrive as control_request (canUseTool); we forward them to
// the gateway and answer with control_response — this is PoC-1 (approval
// forwarding), the capability no existing project implements correctly.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentDriver, ApprovalOption, SessionEvent } from '../types.ts';

export interface ClaudeDriverOptions {
  sessionId: string;
  cwd: string;
  /** Resume an existing session instead of creating a new one. */
  resume: boolean;
  /** Path to the claude binary. */
  claudePath?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /** Extra environment for the child (e.g. ANTHROPIC_BASE_URL / AUTH_TOKEN). */
  env?: Record<string, string>;
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { id: 'allow_once', label: 'Allow once', kind: 'allow' },
  { id: 'deny_once', label: 'Deny', kind: 'deny' },
];

export class ClaudeDriver implements AgentDriver {
  readonly agent = 'claude' as const;
  readonly nativeId: string;
  readonly events = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private opts: ClaudeDriverOptions;
  private buffer = '';
  /** tool input per pending canUseTool request, echoed back on allow. */
  private pendingApprovalInputs = new Map<string, unknown>();

  constructor(opts: ClaudeDriverOptions) {
    this.opts = opts;
    this.nativeId = opts.sessionId;
  }

  async start(): Promise<void> {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Route permission requests through the stream-json control channel
      // (control_request canUseTool) instead of auto-denying in print mode.
      '--permission-prompt-tool', 'stdio',
    ];
    // Valid modes (2.1.224): acceptEdits | auto | bypassPermissions | manual | dontAsk | plan.
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') {
      args.push('--permission-mode', this.opts.permissionMode);
    }
    args.push(this.opts.resume ? '--resume' : '--session-id', this.opts.sessionId);
    const bin = this.opts.claudePath ?? 'claude';
    this.child = spawn(bin, args, {
      cwd: this.opts.cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      // Diagnostics only; protocol is on stdout.
      this.events.emit('data', { type: 'status', status: 'busy', detail: chunk.trim().slice(0, 300) } satisfies SessionEvent);
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.events.emit('data', { type: 'status', status: code === 0 ? 'idle' : 'error', detail: `claude exited (${code})` } satisfies SessionEvent);
    });
  }

  #onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.#handleMessage(JSON.parse(line));
      } catch {
        // Non-JSON line — ignore.
      }
    }
  }

  #handleMessage(msg: any): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
        }
        return;
      case 'stream_event': {
        // Partial deltas (only with --include-partial-messages).
        const ev = msg.event ?? {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.events.emit('data', { type: 'message.delta', role: 'assistant', text: ev.delta.text } satisfies SessionEvent);
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
          this.events.emit('data', { type: 'reasoning.delta', text: ev.delta.thinking } satisfies SessionEvent);
        }
        return;
      }
      case 'assistant': {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === 'text') {
            this.events.emit('data', { type: 'message.completed', role: 'assistant', text: block.text } satisfies SessionEvent);
          } else if (block.type === 'tool_use') {
            this.events.emit('data', { type: 'tool.started', toolCallId: block.id, tool: block.name, input: block.input } satisfies SessionEvent);
          }
        }
        return;
      }
      case 'user': {
        // tool_result blocks come back as user messages.
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              this.events.emit('data', {
                type: 'tool.completed',
                toolCallId: block.tool_use_id,
                output: block.content,
                isError: Boolean(block.is_error),
              } satisfies SessionEvent);
            }
          }
        }
        return;
      }
      case 'control_request': {
        // canUseTool approval — the core of PoC-1.
        const req = msg.request ?? {};
        if (req.subtype === 'can_use_tool') {
          this.pendingApprovalInputs.set(msg.request_id, req.input ?? {});
          this.events.emit('approval', {
            requestId: msg.request_id,
            tool: req.tool_name,
            input: req.input,
            options: APPROVAL_OPTIONS,
          });
        }
        return;
      }
      case 'result':
        this.events.emit('data', {
          type: 'turn.completed',
          turnId: msg.turn_id ?? this.lastTurnId ?? '',
          error: msg.is_error ? String(msg.result ?? 'error') : undefined,
        } satisfies SessionEvent);
        return;
      default:
        return;
    }
  }

  async prompt(text: string): Promise<void> {
    // Synthesize a turn id — the CLI has no first-class turn concept.
    this.lastTurnId = randomUUID();
    this.events.emit('data', { type: 'turn.started', turnId: this.lastTurnId } satisfies SessionEvent);
    this.#send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  private lastTurnId: string | null = null;

  async interrupt(): Promise<void> {
    this.#send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  async resolveApproval(requestId: string, optionId: string): Promise<void> {
    const behavior = optionId.startsWith('allow') ? 'allow' : 'deny';
    const payload = behavior === 'allow'
      ? { behavior, updatedInput: this.pendingApprovalInputs.get(requestId) ?? {} }
      : { behavior, message: 'denied by operator via agent session gateway' };
    this.pendingApprovalInputs.delete(requestId);
    this.#send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: payload,
      },
    });
  }

  #send(obj: unknown): void {
    if (!this.child?.stdin.writable) throw new Error('claude driver not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async stop(): Promise<void> {
    this.child?.kill();
    this.child = null;
  }
}
