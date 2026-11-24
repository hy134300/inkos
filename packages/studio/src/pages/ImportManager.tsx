import { useEffect, useMemo, useState } from "react";
import { fetchJson, invalidateApiPaths, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useI18n } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import { FileInput, BookCopy, Feather, BookMarked, Upload, Wand2, ChevronDown } from "lucide-react";
import { waitForStudioBookReady } from "../lib/book-ready";
import { useServiceStore } from "../store/service";
import { buildChatPageModelGroups, pickModelSelection } from "./chat-page-state";

interface BookSummary {
  readonly id: string;
  readonly title: string;
}

interface Nav { toDashboard: () => void; toBook: (bookId: string) => void }

type Tab = "chapters" | "canon" | "fanfic" | "spinoff" | "imitation";

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function ImportManager({ nav, theme, t, initialTab }: { nav: Nav; theme: Theme; t: TFunction; initialTab?: Tab }) {
  const c = useColors(theme);
  const { lang } = useI18n();
  const { data: booksData } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const [tab, setTab] = useState<Tab>(initialTab ?? "chapters");
  const [status, setStatus] = useState<{ readonly tone: "info" | "success" | "error"; readonly message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Chapters state
  const [chText, setChText] = useState("");
  const [chBookId, setChBookId] = useState("");
  const [chSplitRegex, setChSplitRegex] = useState("");

  // Canon state
  const [canonTarget, setCanonTarget] = useState("");
  const [canonFrom, setCanonFrom] = useState("");
  const [canonSourceType, setCanonSourceType] = useState<"book" | "file">("book");
  const [canonFile, setCanonFile] = useState<File | null>(null);

  // Fanfic state
  const [ffTitle, setFfTitle] = useState("");
  const [ffTheme, setFfTheme] = useState("");
  const [ffText, setFfText] = useState("");
  const [ffFile, setFfFile] = useState<File | null>(null);
  const [ffMode, setFfMode] = useState("canon");
  const [ffGenre, setFfGenre] = useState("other");
  const [ffLang, setFfLang] = useState(lang);

  // Model selection (mirrors the chat page so fanfic creation uses the same model)
  const services = useServiceStore((s) => s.services);
  const servicesLoading = useServiceStore((s) => s.servicesLoading);
  const bankModelsLoading = useServiceStore((s) => s.bankModelsLoading);
  const customModelsLoading = useServiceStore((s) => s.customModelsLoading);
  const modelsByService = useServiceStore((s) => s.modelsByService);
  const fetchServices = useServiceStore((s) => s.fetchServices);
  const fetchBankModels = useServiceStore((s) => s.fetchBankModels);
  const fetchCustomModels = useServiceStore((s) => s.fetchCustomModels);
  const [configuredPreference, setConfiguredPreference] = useState<{ service: string | null; model: string | null } | null>(null);
  const [ffService, setFfService] = useState<string | null>(null);
  const [ffModel, setFfModel] = useState<string | null>(null);

  // Spinoff (番外) state
  const [spTitle, setSpTitle] = useState("");
  const [spParent, setSpParent] = useState("");
  const [spDirection, setSpDirection] = useState("");

  // Imitation (仿写) state
  const [imTitle, setImTitle] = useState("");
  const [imRef, setImRef] = useState("");
  const [imIdea, setImIdea] = useState("");
  const [imGenre, setImGenre] = useState("other");
  const [imLang, setImLang] = useState(lang);

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
      setStatus(null);
    }
  }, [initialTab]);

  useEffect(() => { void fetchServices(); }, [fetchServices]);
  useEffect(() => {
    void fetchBankModels();
    void fetchCustomModels();
  }, [fetchBankModels, fetchCustomModels]);
  useEffect(() => {
    let cancelled = false;
    void fetchJson<{ service?: string | null; defaultModel?: string | null }>("/services/config")
      .then((payload) => {
        if (!cancelled) {
          setConfiguredPreference({ service: payload.service ?? null, model: payload.defaultModel ?? null });
        }
      })
      .catch(() => { if (!cancelled) setConfiguredPreference(null); });
    return () => { cancelled = true; };
  }, []);

  const groupedModels = useMemo(
    () => buildChatPageModelGroups(services, modelsByService, configuredPreference),
    [configuredPreference, modelsByService, services],
  );
  const modelPickerStatus = useMemo(() => {
    if (servicesLoading || services.length === 0) return "loading" as const;
    const connected = services.filter((s) => s.connected);
    if (connected.length === 0) return "no-models" as const;
    if (bankModelsLoading) return "loading" as const;
    if (groupedModels.some((g) => g.models.length > 0)) return "ready" as const;
    const hasConnectedBank = connected.some((s) => !s.service.startsWith("custom"));
    const hasConnectedCustom = connected.some((s) => s.service.startsWith("custom"));
    if (!hasConnectedBank && hasConnectedCustom && customModelsLoading) return "loading" as const;
    return "no-models" as const;
  }, [bankModelsLoading, customModelsLoading, groupedModels, services, servicesLoading]);

  useEffect(() => {
    const next = pickModelSelection(groupedModels, ffModel, ffService, configuredPreference);
    if (next) { setFfModel(next.model); setFfService(next.service); }
  }, [configuredPreference, ffModel, ffService, groupedModels]);

  const selectedModelLabel = useMemo(() => {
    if (!ffModel) return tr("选择模型", "Select model");
    const group = groupedModels.find((g) => g.service === ffService);
    const model = group?.models.find((m) => m.id === ffModel);
    return group ? `${group.label} · ${model?.name ?? ffModel}` : (model?.name ?? ffModel);
  }, [ffModel, ffService, groupedModels]);

  const handleImportChapters = async () => {
    if (!chText.trim() || !chBookId) return;
    setLoading(true);
    setStatus(null);
    try {
      const data = await fetchJson<{ importedCount?: number }>(`/books/${chBookId}/import/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chText, splitRegex: chSplitRegex || undefined }),
      });
      setStatus({ tone: "success", message: `Imported ${data.importedCount} chapters` });
    } catch (e) {
      setStatus({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
    setLoading(false);
  };

  const handleImportCanon = async () => {
    if (!canonTarget || (canonSourceType === "book" ? !canonFrom : !canonFile)) return;
    setLoading(true);
    setStatus(null);
    try {
      if (canonSourceType === "book") {
        await postApi(`/books/${canonTarget}/import/canon`, { fromBookId: canonFrom });
      } else if (canonFile) {
        const uploaded = await fetchJson<{ storedPath: string }>("/import/canon/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: canonFile.name, dataUrl: await fileToDataUrl(canonFile) }),
        });
        await postApi(`/books/${canonTarget}/import/canon-file`, {
          filePath: uploaded.storedPath,
          filename: canonFile.name,
        });
      }
      setStatus({ tone: "success", message: tr("母本导入成功", "Canon imported successfully") });
    } catch (e) {
      setStatus({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
    setLoading(false);
  };

  const handleFanficInit = async () => {
    if (!ffTitle.trim() || (!ffText.trim() && !ffFile)) return;
    setLoading(true);
    setStatus(null);
    try {
      let sourcePath: string | undefined;
      let sourceName: string | undefined;
      if (ffFile) {
        const uploaded = await fetchJson<{ storedPath: string }>("/import/canon/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: ffFile.name, dataUrl: await fileToDataUrl(ffFile) }),
        });
        sourcePath = uploaded.storedPath;
        sourceName = ffFile.name;
      }
      const data = await fetchJson<{ bookId?: string }>("/fanfic/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: ffTitle,
          ...(ffTheme.trim() ? { theme: ffTheme.trim() } : {}),
          ...(ffFile ? { sourcePath, sourceName } : { sourceText: ffText }),
          mode: ffMode,
          genre: ffGenre, language: ffLang,
          ...(ffService ? { service: ffService } : {}),
          ...(ffModel ? { model: ffModel } : {}),
        }),
      });
      if (data.bookId) {
        setStatus({ tone: "info", message: `${t("import.creating")}: ${data.bookId}` });
        await waitForStudioBookReady(data.bookId);
        setStatus({ tone: "success", message: `${t("import.fanficDone")}: ${data.bookId}` });
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
    setLoading(false);
  };

  const handleSpinoffInit = async () => {
    if (!spTitle.trim() || !spParent) return;
    setLoading(true);
    setStatus(null);
    try {
      const data = await postApi<{ bookId?: string }>("/spinoff/init", { title: spTitle, parentBookId: spParent, direction: spDirection || undefined });
      if (data.bookId) {
        setStatus({ tone: "info", message: `${t("import.creating")}: ${data.bookId}` });
        await waitForStudioBookReady(data.bookId);
        setStatus({ tone: "success", message: `${t("import.spinoffDone")}: ${data.bookId}` });
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
    setLoading(false);
  };

  const handleImitationInit = async () => {
    if (!imTitle.trim() || !imRef.trim() || !imIdea.trim()) return;
    setLoading(true);
    setStatus(null);
    try {
      const data = await postApi<{ bookId?: string }>("/imitation/init", { title: imTitle, referenceText: imRef, storyIdea: imIdea, genre: imGenre, language: imLang });
      if (data.bookId) {
        setStatus({ tone: "info", message: `${t("import.creating")}: ${data.bookId}` });
        await waitForStudioBookReady(data.bookId);
        setStatus({ tone: "success", message: `${t("import.imitationDone")}: ${data.bookId}` });
        invalidateApiPaths(["/api/v1/books", `/api/v1/books/${data.bookId}`]);
        nav.toBook(data.bookId);
      }
    } catch (e) {
      setStatus({ tone: "error", message: e instanceof Error ? e.message : String(e) });
    }
    setLoading(false);
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "chapters", label: t("import.chapters"), icon: <FileInput size={14} /> },
    { id: "canon", label: t("import.canon"), icon: <BookCopy size={14} /> },
    { id: "fanfic", label: t("import.fanfic"), icon: <Feather size={14} /> },
    { id: "spinoff", label: t("import.spinoff"), icon: <BookMarked size={14} /> },
    { id: "imitation", label: t("import.imitation"), icon: <Wand2 size={14} /> },
  ];

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.import")}</span>
      </div>

      <h1 className="font-serif text-3xl flex items-center gap-3">
        <FileInput size={28} className="text-primary" />
        {t("import.title")}
      </h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-secondary/30 rounded-lg p-1 w-fit">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => { setTab(tb.id); setStatus(null); }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 transition-all ${
              tab === tb.id ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={`border ${c.cardStatic} rounded-lg p-6 space-y-4`}>
        {tab === "chapters" && (
          <>
            <select value={chBookId} onChange={(e) => setChBookId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectTarget")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <input
              type="text" value={chSplitRegex} onChange={(e) => setChSplitRegex(e.target.value)}
              placeholder={t("import.splitRegex")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm font-mono"
            />
            <textarea value={chText} onChange={(e) => setChText(e.target.value)} rows={10}
              placeholder={t("import.pasteChapters")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            <button onClick={handleImportChapters} disabled={loading || !chBookId || !chText.trim()}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : t("import.chapters")}
            </button>
          </>
        )}

        {tab === "canon" && (
          <>
            <p className="text-sm text-muted-foreground">
              {tr("母本可以来自已有 InkOS 书籍，也可以直接上传外部 TXT、Markdown 或 PDF 小说。", "Use an existing InkOS book or upload an external TXT, Markdown, or PDF novel as canon.")}
            </p>
            <div className="inline-flex rounded-lg border border-border bg-secondary/20 p-1">
              {(["book", "file"] as const).map((sourceType) => (
                <button
                  key={sourceType}
                  type="button"
                  onClick={() => setCanonSourceType(sourceType)}
                  className={`rounded-md px-3 py-1.5 text-sm ${canonSourceType === sourceType ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
                >
                  {sourceType === "book" ? tr("已有书籍", "Existing book") : tr("上传外部母本", "Upload external canon")}
                </button>
              ))}
            </div>
            {canonSourceType === "book" ? (
              <select value={canonFrom} onChange={(e) => setCanonFrom(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="">{t("import.selectSource")}</option>
                {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            ) : (
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-4 text-sm hover:bg-secondary/30">
                <Upload size={18} className="text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  {canonFile?.name ?? tr("选择 TXT、Markdown 或 PDF 文件", "Choose a TXT, Markdown, or PDF file")}
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                  className="sr-only"
                  onChange={(event) => setCanonFile(event.target.files?.[0] ?? null)}
                />
              </label>
            )}
            <select value={canonTarget} onChange={(e) => setCanonTarget(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectDerivative")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <button onClick={handleImportCanon} disabled={loading || !canonTarget || (canonSourceType === "book" ? !canonFrom : !canonFile)}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.importing") : t("import.canon")}
            </button>
          </>
        )}

        {tab === "fanfic" && (
          <>
            <input type="text" value={ffTitle} onChange={(e) => setFfTitle(e.target.value)}
              placeholder={t("import.fanficTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <div className="space-y-1.5">
              <label className="text-sm text-muted-foreground">
                {tr("创作主题与重点（可选）— 告诉 AI 这本同人聚焦什么，原作提炼和大纲都会围绕它", "Theme & focus (optional) — tell the AI what this fanfic focuses on; canon extraction and outline will follow it")}
              </label>
              <textarea
                value={ffTheme}
                onChange={(e) => setFfTheme(e.target.value)}
                rows={3}
                placeholder={tr("例如：以韩立×慕沛灵为主，重点挖掘慕沛灵结丹失败、心魔与阵道成长，保留原著人物与边界…", "e.g. Focus on Han Li × Mu Peiling, digging into Mu Peiling's failed core formation, heart demon and array growth, while preserving canon boundaries…")}
                className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">{tr("创作模型", "Model")}:</span>
              {modelPickerStatus === "ready" ? (
                <div className="relative">
                  <select
                    value={ffModel && ffService ? `${ffService}::${ffModel}` : ""}
                    onChange={(e) => {
                      const [service, model] = e.target.value.split("::");
                      setFfService(service);
                      setFfModel(model);
                    }}
                    className="appearance-none px-3 py-2 pr-8 rounded-lg bg-secondary/30 border border-border text-sm"
                  >
                    {groupedModels.flatMap((g) => g.models.map((m) => (
                      <option key={`${g.service}::${m.id}`} value={`${g.service}::${m.id}`}>
                        {g.label} · {m.name ?? m.id}
                      </option>
                    )))}
                  </select>
                  <ChevronDown size={14} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground/60">
                  {modelPickerStatus === "loading"
                    ? tr("加载模型中...", "Loading models...")
                    : tr("请先在模型配置中连接服务", "Configure a model service first")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <select value={ffMode} onChange={(e) => setFfMode(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="canon">{tr("原著向", "Canon-compliant")}</option>
                <option value="au">{tr("架空 AU", "Alternate Universe (AU)")}</option>
                <option value="ooc">{tr("性格偏离 OOC", "Out of Character (OOC)")}</option>
                <option value="cp">{tr("配对 CP", "Pairing (CP)")}</option>
              </select>
              <select value={ffGenre} onChange={(e) => setFfGenre(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="other">{tr("其他", "Other")}</option>
                <option value="xuanhuan">{tr("玄幻", "Xuanhuan Fantasy")}</option>
                <option value="urban">{tr("都市", "Urban")}</option>
                <option value="xianxia">{tr("仙侠", "Xianxia")}</option>
              </select>
              <select value={ffLang} onChange={(e) => setFfLang(e.target.value as "zh" | "en")}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="zh">{tr("中文", "Chinese")}</option>
                <option value="en">English</option>
              </select>
            </div>
            <p className="text-sm text-muted-foreground">
              {tr("可上传整本原著（TXT / Markdown / PDF，≤80 MB），也可以直接粘贴原作文本/设定/角色资料。上传文件后优先使用文件。", "Upload a full source novel (TXT / Markdown / PDF, ≤80 MB) or paste source material below. An uploaded file takes priority.")}
            </p>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-4 text-sm hover:bg-secondary/30">
              <Upload size={18} className="text-primary" />
              <span className="min-w-0 flex-1 truncate">
                {ffFile?.name ?? tr("选择 TXT、Markdown 或 PDF 文件", "Choose a TXT, Markdown, or PDF file")}
              </span>
              <input
                type="file"
                accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
                className="sr-only"
                onChange={(event) => setFfFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <textarea value={ffText} onChange={(e) => setFfText(e.target.value)} rows={10}
              placeholder={t("import.pasteMaterial")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            <button onClick={handleFanficInit} disabled={loading || !ffTitle.trim() || (!ffText.trim() && !ffFile)}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.fanfic")}
            </button>
          </>
        )}

        {tab === "spinoff" && (
          <>
            <p className="text-xs text-muted-foreground">{t("import.spinoffHint")}</p>
            <input type="text" value={spTitle} onChange={(e) => setSpTitle(e.target.value)}
              placeholder={t("import.spinoffTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <select value={spParent} onChange={(e) => setSpParent(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
              <option value="">{t("import.selectParent")}</option>
              {booksData?.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
            <textarea value={spDirection} onChange={(e) => setSpDirection(e.target.value)} rows={5}
              placeholder={t("import.spinoffDirection")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none"
            />
            <button onClick={handleSpinoffInit} disabled={loading || !spTitle.trim() || !spParent}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.spinoff")}
            </button>
          </>
        )}

        {tab === "imitation" && (
          <>
            <p className="text-xs text-muted-foreground">{t("import.imitationHint")}</p>
            <input type="text" value={imTitle} onChange={(e) => setImTitle(e.target.value)}
              placeholder={t("import.imitationTitle")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <div className="grid grid-cols-2 gap-3">
              <select value={imGenre} onChange={(e) => setImGenre(e.target.value)}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="other">{tr("其他", "Other")}</option>
                <option value="xuanhuan">{tr("玄幻", "Xuanhuan Fantasy")}</option>
                <option value="urban">{tr("都市", "Urban")}</option>
                <option value="xianxia">{tr("仙侠", "Xianxia")}</option>
              </select>
              <select value={imLang} onChange={(e) => setImLang(e.target.value as "zh" | "en")}
                className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm">
                <option value="zh">{tr("中文", "Chinese")}</option>
                <option value="en">English</option>
              </select>
            </div>
            <textarea value={imIdea} onChange={(e) => setImIdea(e.target.value)} rows={4}
              placeholder={t("import.imitationIdea")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none"
            />
            <textarea value={imRef} onChange={(e) => setImRef(e.target.value)} rows={8}
              placeholder={t("import.imitationRef")}
              className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
            />
            <button onClick={handleImitationInit} disabled={loading || !imTitle.trim() || !imRef.trim() || !imIdea.trim()}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}>
              {loading ? t("import.creating") : t("import.imitation")}
            </button>
          </>
        )}

        {status && (
          <div className={`text-sm px-3 py-2 rounded-lg ${status.tone === "error" ? "bg-destructive/10 text-destructive" : status.tone === "info" ? "bg-secondary text-muted-foreground" : "bg-emerald-500/10 text-emerald-600"}`}>
            {status.message}
          </div>
        )}
      </div>
    </div>
  );
}
