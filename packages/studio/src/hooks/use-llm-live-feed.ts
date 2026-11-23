import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LlmLiveEvent,
  LlmLiveSessionSnapshot,
  LlmLiveStreamFrame,
} from "../shared/llm-live";

const MAX_PREVIEW_CHARS = 16_000;
const MAX_SESSIONS = 60;

type ConnectionState = "connecting" | "connected" | "reconnecting";

function applyEvent(current: LlmLiveSessionSnapshot | undefined, event: LlmLiveEvent): LlmLiveSessionSnapshot | null {
  if (!current) return null;
  switch (event.type) {
    case "session_started":
      return null; // handled by caller (creates new snapshots)
    case "phase_changed":
      return {
        ...current,
        seq: event.seq,
        phase: event.phase,
        phaseMessage: event.message,
        updatedAt: event.at,
        ...(event.phase === "completed" || event.phase === "failed" ? { completedAt: event.at } : {}),
      };
    case "output_delta": {
      const room = MAX_PREVIEW_CHARS - current.preview.length;
      return {
        ...current,
        seq: event.seq,
        preview: room > 0 ? current.preview + event.content.slice(0, room) : current.preview,
        updatedAt: event.at,
        ...(current.phase === "requesting" ? { phase: "streaming" as const, phaseMessage: "正在生成" } : {}),
      };
    }
    case "usage_updated":
      return { ...current, seq: event.seq, tokenUsage: event.tokenUsage, updatedAt: event.at };
    case "session_completed":
      return {
        ...current, seq: event.seq, phase: "completed", phaseMessage: "已完成",
        completedAt: event.at, durationMs: event.durationMs, updatedAt: event.at,
      };
    case "session_failed":
      return {
        ...current, seq: event.seq, phase: "failed", phaseMessage: event.message,
        completedAt: event.at, updatedAt: event.at,
      };
    default:
      return null;
  }
}

export function useLlmLiveFeed() {
  const [sessions, setSessions] = useState<ReadonlyArray<LlmLiveSessionSnapshot>>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const sessionsRef = useRef<ReadonlyArray<LlmLiveSessionSnapshot>>([]);
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Map<string, LlmLiveSessionSnapshot>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const updates = pendingRef.current;
      pendingRef.current = new Map();
      if (updates.size === 0) return;
      const byId = new Map(sessionsRef.current.map((s) => [s.context.interactionId, s]));
      for (const [id, snapshot] of updates) byId.set(id, snapshot);
      const next = [...byId.values()]
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-MAX_SESSIONS);
      sessionsRef.current = next;
      setSessions(next);
    }, 80);
  }, []);

  const handleFrame = useCallback((frame: LlmLiveStreamFrame) => {
    if (frame.type === "ping") return;
    if (frame.type === "snapshot") {
      const visible = frame.sessions.filter((s) => !hiddenIdsRef.current.has(s.context.interactionId)).slice(-MAX_SESSIONS);
      sessionsRef.current = visible;
      setSessions(visible);
      return;
    }
    const event = frame.event;
    if (event.type === "session_started") {
      hiddenIdsRef.current.delete(event.context.interactionId);
      const snapshot: LlmLiveSessionSnapshot = {
        context: event.context,
        seq: event.seq,
        phase: "requesting",
        phaseMessage: "正在连接模型",
        preview: "",
        startedAt: event.at,
        updatedAt: event.at,
      };
      pendingRef.current.set(event.context.interactionId, snapshot);
      scheduleFlush();
      return;
    }
    const id = event.interactionId;
    if (hiddenIdsRef.current.has(id)) return;
    // Merge against pending-or-existing snapshot so rapid deltas don't lose data.
    // Read the current snapshot from a ref (not a state updater) to keep the
    // updater pure and StrictMode-safe.
    const existing = pendingRef.current.get(id) ?? sessionsRef.current.find((s) => s.context.interactionId === id);
    const next = applyEvent(existing, event);
    if (next) pendingRef.current.set(id, next);
    scheduleFlush();
  }, [scheduleFlush]);

  useEffect(() => {
    const source = new EventSource("/api/v1/llm-live/stream");
    source.onopen = () => setConnection("connected");
    source.onerror = () => setConnection("reconnecting");
    const onMessage = (e: MessageEvent) => {
      try { handleFrame(JSON.parse(e.data) as LlmLiveStreamFrame); } catch { /* ignore */ }
    };
    source.addEventListener("llm_live", onMessage);
    return () => {
      source.removeEventListener("llm_live", onMessage);
      source.close();
    };
  }, [handleFrame]);

  const clear = useCallback(() => {
    const ids = new Set([
      ...sessions.map((s) => s.context.interactionId),
      ...pendingRef.current.keys(),
    ]);
    for (const id of ids) hiddenIdsRef.current.add(id);
    pendingRef.current.clear();
    sessionsRef.current = [];
    setSessions([]);
  }, [sessions]);

  const activeCount = useMemo(
    () => sessions.filter((s) => s.phase !== "completed" && s.phase !== "failed").length,
    [sessions],
  );

  return { sessions, connection, activeCount, clear };
}
