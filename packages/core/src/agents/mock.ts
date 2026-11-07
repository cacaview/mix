// Mock agent driver — deterministic scripted sessions for end-to-end tests
// of the gateway protocol (incl. approval forwarding) without any API access.

import { EventEmitter } from 'node:events';
import type { AgentDriver, ApprovalOption, SessionEvent } from '../types.ts';

const OPTIONS: ApprovalOption[] = [
  { id: 'allow_once', label: 'Allow once', kind: 'allow' },
  { id: 'deny_once', label: 'Deny', kind: 'deny' },
];

export class MockDriver implements AgentDriver {
  readonly agent = 'mock' as const;
  readonly nativeId: string;
  readonly events = new EventEmitter();
  private pendingApprovals = new Map<string, (decision: string) => void>();

  constructor(nativeId: string) {
    this.nativeId = nativeId;
  }

  async start(): Promise<void> {
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  async prompt(text: string): Promise<void> {
    const turnId = `mock-turn-${Date.now()}`;
    this.events.emit('data', { type: 'turn.started', turnId } satisfies SessionEvent);
    // Ask for approval on any prompt containing "write".
    if (/write|写/i.test(text)) {
      const requestId = `mock-approval-${turnId}`;
      const decision = await new Promise<string>((resolve) => {
        this.pendingApprovals.set(requestId, resolve);
        this.events.emit('approval', {
          requestId,
          tool: 'write_file',
          input: { path: '/tmp/mock.txt', content: 'hello' },
          options: OPTIONS,
        });
      });
      this.events.emit('data', { type: 'tool.started', toolCallId: 'mock-tool-1', tool: 'write_file', input: {} } satisfies SessionEvent);
      this.events.emit('data', {
        type: 'tool.completed',
        toolCallId: 'mock-tool-1',
        output: decision.startsWith('allow') ? 'written (approved)' : 'denied by operator',
        isError: !decision.startsWith('allow'),
      } satisfies SessionEvent);
    }
    for (const part of ['Echo: ', text]) {
      this.events.emit('data', { type: 'message.delta', role: 'assistant', text: part } satisfies SessionEvent);
    }
    this.events.emit('data', { type: 'message.completed', role: 'assistant', text: `Echo: ${text}` } satisfies SessionEvent);
    this.events.emit('data', { type: 'turn.completed', turnId } satisfies SessionEvent);
  }

  async interrupt(): Promise<void> {
    this.events.emit('data', { type: 'status', status: 'idle' } satisfies SessionEvent);
  }

  async resolveApproval(requestId: string, optionId: string): Promise<void> {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      this.pendingApprovals.delete(requestId);
      resolve(optionId);
    }
  }

  async stop(): Promise<void> {
    /* nothing */
  }
}
