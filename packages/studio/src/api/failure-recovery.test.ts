import { describe, expect, it } from "vitest";
import { buildFailureRecoveryHint } from "./server.js";

describe("buildFailureRecoveryHint", () => {
  it("reports confirmed writes, ignores reads, and gives explicit next step", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "longform__revise_foundation", arguments: {} },
          { type: "toolCall", id: "c2", name: "workspace__read", arguments: {} },
          { type: "toolCall", id: "c3", name: "workspace__read", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        isError: false,
        details: {
          kind: "foundation_revised",
          hostExecution: { risk: "recoverable-write", status: "success", artifacts: [{ workId: "w" }, { workId: "w" }] },
        },
      },
      {
        role: "toolResult",
        toolCallId: "c2",
        isError: false,
        details: { kind: "artifact_read", hostExecution: { risk: "read", status: "success", artifacts: [] } },
      },
      {
        role: "toolResult",
        toolCallId: "c3",
        isError: false,
        details: { kind: "artifact_read", hostExecution: { risk: "read", status: "success", artifacts: [] } },
      },
    ];

    const hint = buildFailureRecoveryHint(messages, "zh");
    expect(hint).toContain("读取 2 次");
    expect(hint).toContain("longform__revise_foundation (2 artifacts)");
    expect(hint).toContain("不会自动回滚");
    expect(hint).toContain("明确指令");
  });

  it("allows safe retry when nothing was written", () => {
    const hint = buildFailureRecoveryHint([], "zh");
    expect(hint).toBe("");
  });
});
