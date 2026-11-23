import { describe, expect, it, vi } from "vitest";
import { FanficCanonImporter } from "../agents/fanfic-canon-importer.js";
import type { LLMClient } from "../llm/provider.js";

const TEST_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  _piModel: { contextWindow: 21_280 },
} as unknown as LLMClient;

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("FanficCanonImporter", () => {
  it("semantically compiles long source chunks instead of truncating the tail", async () => {
    const agent = new FanficCanonImporter({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    )
      .mockResolvedValueOnce({
        content: "片段1资料：主角甲第一次登场。",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "片段2资料：TAIL_CANON_MARKER 是尾部关键正典。",
        usage: ZERO_USAGE,
      });
    const submitSpy = vi.spyOn(
      agent as unknown as { submitStructured: (...args: unknown[]) => Promise<unknown> },
      "submitStructured",
    ).mockResolvedValue({
      result: {
        canonMarkdown: "## 关键事实\n\nTAIL_CANON_MARKER 是尾部关键正典。",
      },
      usage: ZERO_USAGE,
    });

    const source = `${"前段".repeat(600)}TAIL_CANON_MARKER`;
    const result = await agent.importFromText(source, "长原作", "canon");

    expect(chatSpy).toHaveBeenCalledTimes(2);
    const secondChunkMessages = chatSpy.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(secondChunkMessages[1]?.content).toContain("TAIL_CANON_MARKER");
    const finalMessages = submitSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(finalMessages[1]?.content).toContain("片段2资料：TAIL_CANON_MARKER");
    expect(finalMessages[0]?.content).not.toContain("已截断");
    expect(result.fullDocument).toContain("TAIL_CANON_MARKER");
    expect(result.fullDocument).not.toContain("力量体系");
  });

  it("compresses the concatenated chunk package when it exceeds the final consumer budget", async () => {
    // Context window tuned so finalBudget (~window - maxTokens - 2048 - 1024)
    // is smaller than the concatenated output of the first compile pass.
    const client = {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      _piModel: { contextWindow: 12_000 },
      defaults: { maxTokens: 0 },
    } as unknown as LLMClient;
    const agent = new FanficCanonImporter({ client, model: "test-model", projectRoot: process.cwd() });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    );
    // First pass: three chunks, each compiles into a large (but < budget) note.
    // Together they exceed finalBudget, forcing a compression pass.
    const bigNote = `正典证据。${"情节细节".repeat(900)}`;
    chatSpy
      .mockResolvedValueOnce({ content: bigNote, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: bigNote, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: bigNote, usage: ZERO_USAGE })
      .mockResolvedValue({ content: "压缩后的精炼正典：主角与世界观关键事实。", usage: ZERO_USAGE });

    const submitSpy = vi.spyOn(
      agent as unknown as { submitStructured: (...args: unknown[]) => Promise<unknown> },
      "submitStructured",
    ).mockResolvedValue({
      result: { canonMarkdown: "## 关键事实\n\n压缩后的精炼正典。" },
      usage: ZERO_USAGE,
    });

    // Long enough to split into 3+ chunks under the 16k-reservation budget.
    const source = "原作正文片段，含人物与事件。".repeat(1200);
    await agent.importFromText(source, "超长原作", "canon");

    // More than 3 calls means the compression pass ran.
    expect(chatSpy.mock.calls.length).toBeGreaterThan(3);
    const finalMessages = submitSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    // The final submit must not contain the oversized concatenated package.
    expect(finalMessages[1]?.content.length).toBeLessThan(bigNote.length * 3);
  });
});
