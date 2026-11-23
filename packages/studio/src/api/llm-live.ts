import { registerExecutionEvidenceObserver } from "@actalk/inkos-core";
import type {
  LlmLiveContext,
  LlmLiveEvent,
  LlmLiveEventInput,
  LlmLiveSessionSnapshot,
  LlmLiveStreamFrame,
  LlmLiveTokenUsage,
} from "../shared/llm-live.js";

const MAX_PREVIEW_CHARS = 16_000;
const RETAIN_COMPLETED_MS = 10 * 60 * 1000;

type Listener = (frame: LlmLiveStreamFrame) => void;

interface RecordEntry {
  snapshot: LlmLiveSessionSnapshot;
  startedAtMs: number;
  previewChars: number;
}

/**
 * In-memory broker that mirrors core model-call evidence into live snapshots.
 * Sessions are keyed by modelCallId (one logical call, including retries).
 */
export class LlmLiveBroker {
  private readonly records = new Map<string, RecordEntry>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private labelCounter = 0;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    registerExecutionEvidenceObserver((type, payload) => this.onEvidence(type, payload));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshotFrame(): LlmLiveStreamFrame {
    this.prune();
    return { type: "snapshot", sessions: [...this.records.values()].map((r) => r.snapshot) };
  }

  private publish(frame: LlmLiveStreamFrame): void {
    for (const listener of this.listeners) {
      try { listener(frame); } catch { /* listeners must not break the broker */ }
    }
  }

  private nextSeq(): number { this.seq += 1; return this.seq; }

  private event(event: LlmLiveEventInput): LlmLiveEvent {
    return { ...event, seq: this.nextSeq(), at: new Date().toISOString() } as LlmLiveEvent;
  }

  private emit(event: LlmLiveEvent): void { this.publish({ type: "event", event }); }

  private onEvidence(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case "model-call-started": return this.onStarted(payload);
      case "model-output-delta": return this.onDelta(payload);
      case "model-request-prepared": return this.onPrepared(payload);
      case "model-call-completed": return this.onCompleted(payload);
      case "model-call-retry": return this.onRetry(payload);
      default: return;
    }
  }

  private idOf(payload: Record<string, unknown>): string | undefined {
    const trace = payload.trace as { modelCallId?: string } | undefined;
    const id = typeof payload.modelCallId === "string" ? payload.modelCallId : trace?.modelCallId;
    return id && id.trim() ? id : undefined;
  }

  private onStarted(payload: Record<string, unknown>): void {
    const id = this.idOf(payload);
    if (!id) return;
    const model = typeof payload.model === "string" ? payload.model : undefined;
    const context = payload.context as Record<string, unknown> | undefined;
    const maxTokens = typeof payload.maxTokens === "number" ? payload.maxTokens : undefined;
    const now = new Date().toISOString();
    this.labelCounter += 1;
    const liveContext: LlmLiveContext = {
      interactionId: id,
      label: `调用 #${this.labelCounter}`,
      mode: context?.tools ? "structured" : "text",
      model,
      service: typeof payload.service === "string" ? payload.service : null,
      maxTokens: maxTokens ?? null,
      promptText: formatContext(context),
    };
    const snapshot: LlmLiveSessionSnapshot = {
      context: liveContext,
      seq: 0,
      phase: "requesting",
      phaseMessage: "正在连接模型",
      preview: "",
      startedAt: now,
      updatedAt: now,
    };
    this.records.set(id, { snapshot, startedAtMs: Date.now(), previewChars: 0 });
    this.emit(this.event({ type: "session_started", context: liveContext }));
  }

  private onPrepared(payload: Record<string, unknown>): void {
    const id = this.idOf(payload);
    if (!id) return;
    const record = this.records.get(id);
    if (!record) return;
    if (payload.parameters && typeof payload.parameters === "object") {
      record.snapshot.context.parameters = payload.parameters as Record<string, unknown>;
    }
    if (typeof payload.model === "string") record.snapshot.context.model = payload.model;
    if (typeof payload.api === "string") record.snapshot.context.api = payload.api;
    this.touch(record);
  }

  private onDelta(payload: Record<string, unknown>): void {
    const id = this.idOf(payload);
    if (!id) return;
    const record = this.records.get(id);
    const delta = typeof payload.delta === "string" ? payload.delta : "";
    if (!record || !delta) return;
    if (record.snapshot.phase === "requesting") {
      record.snapshot.phase = "streaming";
      record.snapshot.phaseMessage = "正在生成";
      this.emit(this.event({ type: "phase_changed", interactionId: id, phase: "streaming", message: "正在生成" }));
    }
    const room = MAX_PREVIEW_CHARS - record.previewChars;
    if (room > 0) {
      const kept = delta.slice(0, room);
      record.snapshot.preview += kept;
      record.previewChars += kept.length;
    }
    this.emit(this.event({ type: "output_delta", interactionId: id, content: delta }));
    this.touch(record);
  }

  private onCompleted(payload: Record<string, unknown>): void {
    const id = this.idOf(payload);
    if (!id) return;
    const record = this.records.get(id);
    if (!record) return;
    const status = typeof payload.status === "string" ? payload.status : "done";
    const response = payload.response as Record<string, unknown> | undefined;
    // Capture full final response if we only saw a partial stream (e.g. non-streaming).
    if (!record.previewChars && response) {
      const text = extractAssistantText(response);
      if (text) {
        record.snapshot.preview = text.slice(0, MAX_PREVIEW_CHARS);
        record.previewChars = record.snapshot.preview.length;
      }
    }
    const usage = extractUsage(response);
    if (usage) {
      record.snapshot.tokenUsage = usage;
      this.emit(this.event({ type: "usage_updated", interactionId: id, tokenUsage: usage }));
    }
    const durationMs = Math.max(0, Date.now() - record.startedAtMs);
    if (status === "done") {
      record.snapshot.phase = "completed";
      record.snapshot.phaseMessage = "已完成";
      record.snapshot.completedAt = new Date().toISOString();
      record.snapshot.durationMs = durationMs;
      this.emit(this.event({ type: "phase_changed", interactionId: id, phase: "completed", message: "已完成" }));
      this.emit(this.event({ type: "session_completed", interactionId: id, status, durationMs }));
    } else {
      const message = typeof response?.errorMessage === "string" ? response.errorMessage : `调用结束：${status}`;
      record.snapshot.phase = "failed";
      record.snapshot.phaseMessage = message;
      record.snapshot.completedAt = new Date().toISOString();
      record.snapshot.durationMs = durationMs;
      this.emit(this.event({ type: "phase_changed", interactionId: id, phase: "failed", message }));
      this.emit(this.event({ type: "session_failed", interactionId: id, message }));
    }
    this.touch(record);
  }

  private onRetry(payload: Record<string, unknown>): void {
    const id = this.idOf(payload);
    if (!id) return;
    const record = this.records.get(id);
    if (!record) return;
    record.snapshot.phaseMessage = `重试中：${typeof payload.reason === "string" ? payload.reason : "未知原因"}`;
    this.touch(record);
  }

  private touch(record: RecordEntry): void {
    record.snapshot.updatedAt = new Date().toISOString();
  }

  private prune(): void {
    const cutoff = Date.now() - RETAIN_COMPLETED_MS;
    for (const [id, record] of this.records) {
      const done = record.snapshot.phase === "completed" || record.snapshot.phase === "failed";
      if (done && record.startedAtMs < cutoff) this.records.delete(id);
    }
  }
}

function formatContext(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const ctx = context as { systemPrompt?: unknown; messages?: unknown };
  const blocks: string[] = [];
  if (typeof ctx.systemPrompt === "string" && ctx.systemPrompt.trim()) {
    blocks.push(`[system]\n${ctx.systemPrompt.trim()}`);
  }
  if (Array.isArray(ctx.messages)) {
    for (const message of ctx.messages) {
      if (!message || typeof message !== "object") continue;
      const m = message as { role?: unknown; content?: unknown };
      const role = typeof m.role === "string" ? m.role : "message";
      blocks.push(`[${role}]\n${formatContent(m.content)}`);
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function formatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (!part || typeof part !== "object") return String(part ?? "");
    const p = part as { type?: string; text?: string; thinking?: string; data?: string; mimeType?: string };
    if (p.type === "thinking" && p.thinking) return p.thinking;
    if (p.type === "image") return `[image ${p.mimeType ?? "unknown"}]`;
    return p.text ?? "";
  }).filter(Boolean).join("\n");
}

function extractAssistantText(response: Record<string, unknown>): string {
  const content = response.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as { type?: string; text?: string };
    return p.type === "text" && typeof p.text === "string" ? p.text : "";
  }).join("");
}

function extractUsage(response: Record<string, unknown> | undefined): LlmLiveTokenUsage | null {
  if (!response) return null;
  const usage = response.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  const prompt = numberOrZero(usage.input ?? usage.promptTokens);
  const completion = numberOrZero(usage.output ?? usage.completionTokens);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: numberOrZero(usage.totalTokens ?? prompt + completion),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const llmLiveBroker = new LlmLiveBroker();
