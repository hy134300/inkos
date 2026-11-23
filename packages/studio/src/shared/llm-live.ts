// Shared contract for the Studio "AI Live" feed — a read-only mirror of LLM
// calls. The server derives these from core execution evidence; the browser
// folds the event stream into session snapshots for display.

export const LLM_LIVE_PHASES = [
  "requesting",
  "streaming",
  "assembling",
  "completed",
  "failed",
] as const;
export type LlmLivePhase = (typeof LLM_LIVE_PHASES)[number];

export interface LlmLiveTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmLiveContext {
  /** Stable id for one logical model call. */
  interactionId: string;
  /** Human label shown on the card, e.g. "写作 · architect". */
  label: string;
  mode: "text" | "structured";
  model?: string | null;
  api?: string | null;
  /** Full messages actually sent to the model (system/user/assistant/tool). */
  promptText?: string | null;
  /** Request parameters worth showing (max_tokens, tool_choice, thinking...). */
  parameters?: Record<string, unknown>;
  service?: string | null;
  maxTokens?: number | null;
}

export type LlmLiveEvent =
  | { type: "session_started"; seq: number; at: string; context: LlmLiveContext }
  | { type: "phase_changed"; seq: number; at: string; interactionId: string; phase: LlmLivePhase; message: string }
  | { type: "output_delta"; seq: number; at: string; interactionId: string; content: string }
  | { type: "usage_updated"; seq: number; at: string; interactionId: string; tokenUsage: LlmLiveTokenUsage }
  | { type: "session_completed"; seq: number; at: string; interactionId: string; status: string; durationMs: number }
  | { type: "session_failed"; seq: number; at: string; interactionId: string; message: string };

/** Event payload before the server stamps seq/at. Distributed over the union. */
export type LlmLiveEventInput = LlmLiveEvent extends infer E
  ? E extends LlmLiveEvent ? Omit<E, "seq" | "at"> : never
  : never;

export interface LlmLiveSessionSnapshot {
  context: LlmLiveContext;
  seq: number;
  phase: LlmLivePhase;
  phaseMessage: string;
  preview: string;
  tokenUsage?: LlmLiveTokenUsage | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
}

export type LlmLiveStreamFrame =
  | { type: "snapshot"; sessions: ReadonlyArray<LlmLiveSessionSnapshot> }
  | { type: "event"; event: LlmLiveEvent }
  | { type: "ping" };
