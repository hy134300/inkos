import { describe, expect, it } from "vitest";
import { computeReferenceStats } from "../agents/style-guide.js";

describe("computeReferenceStats", () => {
  it("measures sentence and clause shape on the host instead of guessing", () => {
    const text = "韩立走进院子，把柴放下。天已经黑了，他没有点灯。\n\n“回来了？”母亲问。";
    const stats = computeReferenceStats(text);
    expect(stats.chars).toBe(text.length);
    expect(stats.sentences).toBeGreaterThan(0);
    expect(stats.avgSentenceChars).toBeGreaterThan(0);
    expect(stats.clausesPerSentence).toBeGreaterThan(1);
    expect(stats.perThousand["句号"]).toBeGreaterThan(0);
    expect(stats.dialogueParagraphRatio).toBeGreaterThan(0);
  });
});
