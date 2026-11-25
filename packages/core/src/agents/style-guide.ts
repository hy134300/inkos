import type { LLMClient } from "../llm/provider.js";
import { estimateTextTokens } from "../llm/provider.js";
import { runWorkerAgent } from "../agent/worker-agent.js";
import { prepareWorkerMessages } from "./base.js";
import { semanticInputBudget } from "../llm/semantic-input.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import { loadAvailableAgentSkills, mergeActivatedSkillGuidance } from "../skills/index.js";

/** How many evenly spaced passages to sample from a long reference. */
const LONG_REFERENCE_SAMPLES = 12;

/**
 * Compile reference prose into an operational style guide. Long references are
 * sampled across the whole work and merged, so a full novel can produce a
 * book-level style fingerprint instead of overflowing one model call.
 */
export async function compileStyleGuide(input: {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly referenceText: string;
  readonly sourceName?: string;
  readonly language?: "zh" | "en";
  readonly activeSkills?: ReadonlyArray<ActivatedSkillGuidance>;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const sample = input.referenceText.trim();
  if (!sample) throw new Error("Reference text is required for style extraction.");
  const language = input.language ?? "zh";
  const available = await loadAvailableAgentSkills({ projectRoot: input.projectRoot });
  const skills = ["inkos-long-story-analysis", "inkos-imitation-writing"].map((id) => {
    const skill = available.skills.find((candidate) => candidate.id === id);
    if (!skill) throw new Error(`Style extraction requires unavailable skill: ${id}`);
    return { skill, resources: [] };
  });
  const actives = mergeActivatedSkillGuidance(input.activeSkills ?? [], skills);
  const budget = semanticInputBudget(input.client, { reservedOutputTokens: 8_192 }) ?? 24_576;

  if (estimateTextTokens(sample) <= budget) {
    return singleShot(sample);
  }

  const windows = sampleStyleWindows(sample, budget, LONG_REFERENCE_SAMPLES);
  const notes: string[] = [];
  for (const [index, window] of windows.entries()) {
    try {
    const response = await runWorkerAgent(input.client, input.model, await prepareWorkerMessages({ ...input, activatedSkills: actives }, [
      {
        role: "system",
        content: language === "en"
          ? "Read this passage from the reference work and list only observable style facts. Cover narrative distance, sentence and paragraph rhythm, how time advances, density of concrete everyday detail, dialogue ratio and function, narrator asides, metaphor type, and any hard bans you can justify. Cite one short verbatim example per point. Output bullets, no analysis of plot or theme."
          : "只读这一段参考正文，列出可观察的文风事实：叙述距离、句子与段落节奏、时间如何推进、具体世俗细节密度、对白比例与功能、说书人插话、比喻类型、以及有依据的硬性禁令。每条附一句原文例证。只输出要点，不做情节或主题分析。",
      },
      {
        role: "user",
        content: language === "en"
          ? `Source: ${input.sourceName?.trim() || "reference"} (passage ${index + 1}/${windows.length})\n\n${window}`
          : `来源：${input.sourceName?.trim() || "参考文本"}（第 ${index + 1}/${windows.length} 段）\n\n${window}`,
      },
    ], undefined, "style-guide-sample"), {
      temperature: 0.2,
      signal: input.signal,
    });
    const content = response.content.trim();
    if (content) notes.push(`## 样段 ${index + 1}\n${content.slice(0, 4_000)}`);
    } catch (error) {
      // One unreadable sample must not discard the whole fingerprint.
      if (input.signal?.aborted) break;
      if (!/aborted|IncompleteRead|context/i.test(String(error))) throw error;
    }
    if (input.signal?.aborted) break;
  }
  if (!notes.length) throw new Error("Style extraction returned no usable observations.");

  const merged = await runWorkerAgent(input.client, input.model, await prepareWorkerMessages({ ...input, activatedSkills: actives }, [
    {
      role: "system",
      content: language === "en"
        ? "Merge these per-passage observations into one operational prose-style guide in Markdown. Resolve repetition and contradiction by what holds across passages. Keep it prescriptive and testable: what the narration does, what it must do, and what it must not do. Preserve short verbatim examples. Do not describe plot, characters, or themes as style requirements. Return Markdown only."
        : "把下列分块观察合并为一份可执行的中文文风指南（Markdown）。以多数样段一致的表现消解重复与矛盾。写成可检验的规范：叙述如何做、必须做到什么、禁止什么。保留简短原文例证。不要把情节、人物或主题写成文风要求。只返回 Markdown。",
    },
    {
      role: "user",
      content: language === "en"
        ? `Source: ${input.sourceName?.trim() || "reference"}\n\n${notes.join("\n\n")}`
        : `来源：${input.sourceName?.trim() || "参考文本"}\n\n${notes.join("\n\n")}`,
    },
  ], undefined, "style-guide-merge"), {
    temperature: 0.2,
    signal: input.signal,
  });
  const guide = merged.content.trim();
  if (!guide) throw new Error("Style extraction merge returned an empty guide.");
  return guide;

  async function singleShot(text: string): Promise<string> {
    const response = await runWorkerAgent(input.client, input.model, await prepareWorkerMessages({ ...input, activatedSkills: actives }, [
      {
        role: "system",
        content: language === "en"
          ? "Compile the reference into an evidence-backed operational style guide. Return Markdown only."
          : "把参考文本编译为有证据、可执行的文风指南，只返回 Markdown。",
      },
      {
        role: "user",
        content: language === "en"
          ? `Source: ${input.sourceName?.trim() || "reference"}\n\n${text}`
          : `来源：${input.sourceName?.trim() || "参考文本"}\n\n${text}`,
      },
    ], undefined, "style-guide"), {
      temperature: 0.3,
      signal: input.signal,
    });
    const guide = response.content.trim();
    if (!guide) throw new Error("Style extraction returned an empty guide.");
    return guide;
  }
}

/** Evenly spaced windows so the guide reflects the whole work, not just chapter 1. */
export function sampleStyleWindows(text: string, budgetTokens: number, count: number): string[] {
  const total = estimateTextTokens(text);
  if (total <= budgetTokens) return [text];
  // Style only needs representative passages, so prefer more, smaller windows
  // over one huge request: local proxies often abort very large prompts, and a
  // narrower window also keeps attention on actual prose texture.
  const windowChars = Math.min(16_000, Math.max(4_000, Math.floor(budgetTokens * 0.3)));
  const samples = Math.max(2, Math.min(count, Math.floor(text.length / windowChars)));
  const stride = Math.max(1, Math.floor((text.length - windowChars) / Math.max(1, samples - 1)));
  const windows: string[] = [];
  for (let index = 0; index < samples; index++) {
    const start = Math.min(index * stride, Math.max(0, text.length - windowChars));
    // Snap to a line boundary so samples do not begin mid-sentence.
    const lineStart = start === 0 ? 0 : text.indexOf("\n", start) + 1 || start;
    const slice = text.slice(lineStart, lineStart + windowChars).trim();
    if (slice) windows.push(slice);
  }
  return windows.length ? windows : [text.slice(0, windowChars)];
}
