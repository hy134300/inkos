import { describe, expect, it } from "vitest";
import { LlmLiveBroker } from "./llm-live.js";
import type { LlmLiveStreamFrame } from "../shared/llm-live.js";

function collect(broker: LlmLiveBroker): LlmLiveStreamFrame[] {
  const frames: LlmLiveStreamFrame[] = [];
  broker.subscribe((frame) => frames.push(frame));
  return frames;
}

describe("LlmLiveBroker", () => {
  it("mirrors model evidence into ordered live events and snapshots", () => {
    const broker = new LlmLiveBroker();
    const frames = collect(broker);

    // Broker.onEvidence is private in TS but exercised here through a narrow cast.
    const emit = (type: string, payload: Record<string, unknown>) =>
      (broker as unknown as { onEvidence: (t: string, p: Record<string, unknown>) => void }).onEvidence(type, payload);

    emit("model-call-started", {
      trace: { modelCallId: "call-1" },
      model: "test-model",
      maxTokens: 1024,
      context: {
        systemPrompt: "你是助手",
        messages: [{ role: "user", content: [{ type: "text", text: "写一段话" }] }],
      },
    });
    emit("model-output-delta", { modelCallId: "call-1", delta: "从前" });
    emit("model-output-delta", { modelCallId: "call-1", delta: "有座山" });
    emit("model-call-completed", {
      modelCallId: "call-1",
      status: "done",
      response: {
        content: [{ type: "text", text: "从前有座山" }],
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: "stop",
      },
    });

    const events = frames.flatMap((f) => f.type === "event" ? [f.event] : []);
    expect(events.map((e) => e.type)).toEqual([
      "session_started",
      "phase_changed", // streaming
      "output_delta",
      "output_delta",
      "usage_updated",
      "phase_changed", // completed
      "session_completed",
    ]);

    const snap = broker.snapshotFrame();
    expect(snap.type).toBe("snapshot");
    if (snap.type !== "snapshot") return;
    const session = snap.sessions[0]!;
    expect(session.context.model).toBe("test-model");
    expect(session.context.promptText).toContain("你是助手");
    expect(session.context.promptText).toContain("写一段话");
    expect(session.preview).toBe("从前有座山");
    expect(session.phase).toBe("completed");
    expect(session.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
});
