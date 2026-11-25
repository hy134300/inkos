import { describe, expect, it } from "vitest";
import { sampleStyleWindows } from "../agents/style-guide.js";

describe("sampleStyleWindows", () => {
  it("returns the whole text when it fits the budget", () => {
    const text = "韩立睁开眼。屋里有霉味。";
    expect(sampleStyleWindows(text, 10_000, 12)).toEqual([text]);
  });

  it("samples evenly across a long work instead of only the opening", () => {
    // Unique content per block so identical offsets cannot mask duplicate samples.
    const text = Array.from({ length: 4_000 }, (_, i) => `第${i}段：韩立走进院子，把柴放下。\n`).join("");
    const windows = sampleStyleWindows(text, 2_000, 6);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.length).toBeLessThanOrEqual(6);
    const marks = new Set(windows.map((w) => text.indexOf(w)));
    // Samples must come from different regions, not repeated prefixes.
    expect(marks.size).toBe(windows.length);
    expect(windows.every((w) => w.length > 0)).toBe(true);
  });
});
