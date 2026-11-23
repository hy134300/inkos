import { BaseAgent } from "./base.js";
import type { FanficMode } from "../models/book.js";
import { FanficCanonToolSchema } from "./fanfic-canon-tool.js";
import { estimateTextTokens } from "../llm/provider.js";
import { semanticInputBudget, splitTextByEstimatedTokens } from "../llm/semantic-input.js";

export interface FanficCanonOutput {
  readonly fullDocument: string;
}

export class FanficCanonImporter extends BaseAgent {
  get name(): string {
    return "fanfic-canon-importer";
  }

  async importFromText(
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
    language: "zh" | "en" = "zh",
  ): Promise<FanficCanonOutput> {
    const source = await this.prepareSourceText(sourceText, sourceName, language);
    const systemPrompt = language === "en"
      ? `Compile source-grounded fan-fiction canon with the activated import and fan-fiction Skills. Mode: ${fanficMode}. Submit one readable Markdown canon document through the result tool. Include only source-evidenced sections relevant to this work; do not manufacture a genre-specific system.${source.compiled ? " The input is a traceable semantic source package." : ""}`
      : `按已激活的导入与同人 Skills 编译有来源依据的同人正典。模式：${fanficMode}。通过结果工具提交一份可读 Markdown 正典文档；只保留原作有证据且对本作有用的内容，不强造题材专属体系。${source.compiled ? "输入是可追溯的语义资料包。" : ""}`;

    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: language === "en"
          ? `Source material for "${sourceName}":\n\n${source.text}`
          : `原作《${sourceName}》素材：\n\n${source.text}` },
      ],
      {
        name: "submit_fanfic_canon",
        label: "Submit fanfic canon",
        description: "Submit the source-grounded canon sections for host persistence.",
        parameters: FanficCanonToolSchema,
      },
      // The compiled package is already sized to the final consumer budget.
      // Skipping skills here keeps the protected prompt within that budget;
      // fan-fiction Skills remain active for the downstream foundation stage.
      { temperature: 0.3, professionalGuidance: false },
    );

    const canonMarkdown = result.canonMarkdown.trim();
    if (!canonMarkdown) throw new Error("Fanfic canon compiler returned an empty document.");
    const headings = language === "en"
      ? ["Fan-fiction Canon", "Source", "Material", "Mode", "Canon"]
      : ["同人正典", "来源", "素材", "同人模式", "正典内容"];
    const fullDocument = [
      `# ${headings[0]}（${sourceName}）`,
      "",
      `## ${headings[1]}`,
      `- ${headings[2]}: ${sourceName}`,
      `- ${headings[3]}: ${fanficMode}`,
      "",
      `## ${headings[4]}`,
      canonMarkdown,
    ].join("\n");

    return { fullDocument };
  }

  private async prepareSourceText(
    sourceText: string,
    sourceName: string,
    language: "zh" | "en",
  ): Promise<{ readonly text: string; readonly compiled: boolean }> {
    // Budget for compiling chunks. Keep the original 16k reservation so small
    // context windows still split sensibly; the iterative compression below
    // additionally enforces the stricter final-consumer budget.
    const budget = semanticInputBudget(this.ctx.client, { reservedOutputTokens: 16_384 });
    if (budget === undefined || estimateTextTokens(sourceText) <= budget) {
      return { text: sourceText, compiled: false };
    }
    // Budget of the final submitStructured call (prepareWorkerMessages uses
    // window - defaults.maxTokens - 2048). The compiled package must fit here.
    const window = this.ctx.client._piModel?.contextWindow;
    const maxOutput = this.ctx.client.defaults?.maxTokens ?? 0;
    const finalBudget = window && Number.isFinite(window)
      ? Math.max(1, window - maxOutput - 2048 - 1024) // extra 1024 margin for skills/work metadata
      : budget;

    const header = language === "en"
      ? [`# ${sourceName} semantic source package`, "", "Compiled from every source chunk for traceable canon extraction.", ""]
      : [`# 《${sourceName}》语义资料包`, "", "逐段读取完整原作素材后编译，用于可追溯正典抽取。", ""];

    let compiledText = await this.compileChunks(sourceText, budget, sourceName, language);

    // The concatenated chunk notes can themselves exceed the final consumer's
    // protected-context budget (each chunk is compiled up to the full budget).
    // Iteratively compress the compiled package until it fits, so the canon
    // compiler / architect never receives an oversized protected message.
    let pass = 0;
    while (estimateTextTokens([...header, compiledText].join("\n")) > finalBudget && pass < 5) {
      pass += 1;
      const compressed = await this.compileChunks(compiledText, finalBudget, sourceName, language, pass);
      const joined = [...header, compressed].join("\n");
      // Stop if a compression pass made no progress (avoid an endless loop).
      if (estimateTextTokens(joined) >= estimateTextTokens([...header, compiledText].join("\n"))) {
        compiledText = compressed;
        break;
      }
      compiledText = compressed;
    }

    return {
      compiled: true,
      text: [...header, compiledText].join("\n"),
    };
  }

  private async compileChunks(
    text: string,
    budget: number,
    sourceName: string,
    language: "zh" | "en",
    pass = 0,
  ): Promise<string> {
    const chunks = splitTextByEstimatedTokens(text, budget);
    if (chunks.length === 1) return chunks[0];
    const notes: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const content = await this.compileChunk(chunks[index], sourceName, index, chunks.length, language, pass);
      notes.push([`## 片段 ${index + 1}/${chunks.length}`, content].join("\n\n"));
    }
    return notes.join("\n\n");
  }

  private async compileChunk(
    chunk: string,
    sourceName: string,
    index: number,
    total: number,
    language: "zh" | "en",
    pass: number,
  ): Promise<string> {
    const response = await this.chat(
      [
        {
          role: "system",
          content: language === "en"
            ? `Compile the source chunk into a concise, traceable Markdown evidence package with the activated import Skill.${pass > 0 ? " This is a compression pass: merge and shorten while preserving all canon-relevant evidence." : ""}`
            : `按已激活的导入 Skill，把原作片段编译为简洁、可追溯的 Markdown 资料包。${pass > 0 ? " 这是压缩轮：在保留全部正典相关证据的前提下合并并精简。" : ""}`,
        },
        {
          role: "user",
          content: [
            language === "en" ? `Source: ${sourceName}` : `原作：${sourceName}`,
            language === "en" ? `Chunk: ${index + 1}/${total}${pass > 0 ? ` (compression pass ${pass})` : ""}` : `片段：${index + 1}/${total}${pass > 0 ? `（压缩轮 ${pass}）` : ""}`,
            "",
            chunk,
          ].join("\n"),
        },
      ],
      // Mechanical chunk compilation needs no professional writing guidance;
      // the system prompt above already carries the compile instruction. Skipping
      // skills avoids injecting ~24k protected tokens that would overflow the
      // context when combined with a full-size chunk.
      { temperature: 0.2, professionalGuidance: false },
    );
    const content = response.content.trim();
    if (!content) throw new Error(`Fanfic source compiler returned empty output for chunk ${index + 1}/${total}${pass > 0 ? ` (pass ${pass})` : ""}.`);
    return content;
  }
}
