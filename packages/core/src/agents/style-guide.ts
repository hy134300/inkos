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
          ? "Read this passage from the reference work and list only observable craft facts. Cover narrative distance, sentence and paragraph rhythm, sentence length and clauses per sentence, how time advances, dialogue ratio and function (information exchange versus competing interests), narrator asides, metaphor type, where causes land (concrete money, objects, obligations versus abstract concepts), whether characters carry concrete calculations and numbers, whether procedural motion is compressed away, and how an ending leaves pressure. Also judge four things: whether concrete details each carry a cost, a gain, or another person’s reaction; whether every number changes someone's attitude; whether lists are enumerated after a colon; and whether rules are shown only through consequences instead of being explained. Cite one short verbatim example per point. Output bullets, no analysis of plot or theme."
          : "只读这一段参考正文，列出可观察的写作手法：叙述距离、句子与段落节奏、句子长度与分句数量、时间如何推进、对白比例与功能（是交换信息还是争夺利益）、说书人插话的方式、比喻类型、因果如何落地（落在钱物利害还是抽象概念）、人物是否带具体算计与数目、流程性动作是否被省略、结尾如何留压。还要判断四件事：具体细节是否都承担代价、收益或他人反应；数字是否都引出了人物态度的变化；是否用冒号加顿号列举清单；规则是否只靠后果呈现而不解释。每条附一句原文例证。只输出要点，不做情节或主题分析。",
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
        ? "Merge these per-passage observations into one operational writing guide in Markdown. Resolve repetition and contradiction by what holds across passages. It must have two parts: language (sentence length, clauses per sentence, sentences per paragraph, punctuation and connective density, dialogue-block length) and craft (where causes land, whether characters carry calculations and numbers, how information is released or withheld, whether procedural motion is compressed, how endings leave pressure, whether dialogue competes over interests). Add a 'detail economics' section derived from the passages: whether details carry a cost, a gain, or another person’s reaction; whether numbers drive decisions; whether colons enumerate lists; whether rules are shown only through consequences; whether adjacent paragraphs repeat one fact. Keep it prescriptive and testable. Preserve short verbatim examples. Do not describe plot, characters, or themes as requirements. Return Markdown only."
        : "把下列分块观察合并为一份可执行的中文写作指南（Markdown）。以多数样段一致的表现消解重复与矛盾。必须包含两部分：一是语言层（句子长度、每句分句数、段落句数、标点与虚词密度、对白段长度），二是手法层（因果落在什么上、人物是否带算计与数目、信息如何释放与留白、流程动作是否省略、结尾如何留压、对话是否争夺利益）。写成可检验的规范：必须做到什么、禁止什么。另加一节「细节经济学」，按多数样段归纳：细节是否都承担代价、收益或他人反应；数字是否都驱动了人物决定；是否避免冒号加顿号列举；规则是否只靠后果呈现；相邻段是否重复解释同一件事。保留简短原文例证。不要把情节、人物或主题写成写作要求。只返回 Markdown。",
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
