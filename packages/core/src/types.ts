// Core types for the Agent Session Gateway.
// Normalized event/session model — every agent driver maps its native
// protocol into these shapes (see docs/04-protocol-matrix.md).

export type AgentId = 'claude' | 'codex' | 'opencode' | 'mock';

/** A session known to the gateway (loaded or persisted on disk). */
export interface SessionRef {
  /** Globally unique: `${agent}:${nativeId}` */
  gatewayId: string;
  agent: AgentId;
  /** Native session/thread id within the agent. */
  nativeId: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  /** Whether the gateway currently holds a live driver connection for it. */
  active: boolean;
  /** True when another process may own the writer role (best-effort signal). */
  externallyOwned?: boolean;
}

export type SessionEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'turn.completed'; turnId: string; error?: string }
  | { type: 'message.delta'; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'message.completed'; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool.completed'; toolCallId: string; output: unknown; isError?: boolean }
  | { type: 'status'; status: 'idle' | 'busy' | 'error'; detail?: string };

/** A permission request surfaced by an agent, awaiting a human decision. */
export interface ApprovalRequest {
  requestId: string;
  sessionId: string; // gatewayId
  agent: AgentId;
  tool: string;
  input: unknown;
  /** e.g. ['allow_once', 'deny_once'] — normalized option ids. */
  options: ApprovalOption[];
  createdAtMs: number;
}

export interface ApprovalOption {
  id: string;
  label: string;
  kind: 'allow' | 'deny';
}

export interface ApprovalDecision {
  requestId: string;
  optionId: string;
}

/** Driver = live connection to one native agent session. */
export interface AgentApprovalPayload {
  requestId: string;
  tool: string;
  input: unknown;
  options: ApprovalOption[];
}

export interface DriverEventBus {
  on(event: 'data', cb: (e: SessionEvent) => void): unknown;
  on(event: 'approval', cb: (a: AgentApprovalPayload) => void): unknown;
}

export interface AgentDriver {
  readonly agent: AgentId;
  readonly nativeId: string;
  /** Start the underlying process/connection. */
  start(): Promise<void>;
  /** Submit a user prompt. */
  prompt(text: string): Promise<void>;
  /** Interrupt the running turn. */
  interrupt(): Promise<void>;
  /** Respond to a native approval request. */
  resolveApproval(requestId: string, optionId: string): Promise<void>;
  stop(): Promise<void>;
  readonly events: DriverEventBus;
}
