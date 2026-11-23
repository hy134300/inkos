import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Maximize2, Minimize2, Radio, Trash2, X } from "lucide-react";
import { useLlmLiveFeed } from "../hooks/use-llm-live-feed";
import type { LlmLiveSessionSnapshot } from "../shared/llm-live";
import { tr } from "../lib/app-language";

const phaseLabel = (phase: LlmLiveSessionSnapshot["phase"]): string => {
  switch (phase) {
    case "requesting": return tr("正在连接", "Requesting");
    case "streaming": return tr("正在生成", "Streaming");
    case "assembling": return tr("正在整理", "Assembling");
    case "completed": return tr("已完成", "Completed");
    case "failed": return tr("生成失败", "Failed");
    default: return phase;
  }
};

const isActive = (s: LlmLiveSessionSnapshot): boolean => s.phase !== "completed" && s.phase !== "failed";

function durationMs(s: LlmLiveSessionSnapshot, nowMs: number): number {
  const end = s.completedAt ? new Date(s.completedAt).getTime() : nowMs;
  return Math.max(0, end - new Date(s.startedAt).getTime());
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function formatTokens(s: LlmLiveSessionSnapshot): string {
  const u = s.tokenUsage;
  if (!u) return tr("统计中", "counting");
  return `${u.promptTokens} / ${u.completionTokens} / ${u.totalTokens}`;
}

function SessionCard({
  session, nowMs, collapsed, onToggle,
}: {
  session: LlmLiveSessionSnapshot;
  nowMs: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const failed = session.phase === "failed";

  return (
    <section className="rounded-lg border border-emerald-500/20 bg-black/30 overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-emerald-500/5">
        <span className={`size-2 rounded-full shrink-0 ${isActive(session) ? "bg-emerald-400 animate-pulse" : failed ? "bg-red-400" : "bg-emerald-700"}`} />
        <span className="text-[13px] font-medium text-emerald-100 truncate flex-1">{session.context.label}</span>
        <span className="text-[11px] text-emerald-400/70">{phaseLabel(session.phase)}</span>
        <span className="text-[11px] text-emerald-300/50 tabular-nums">{formatDuration(durationMs(session, nowMs))}</span>
        {collapsed ? <ChevronDown size={13} className="text-emerald-400/60" /> : <ChevronUp size={13} className="text-emerald-400/60" />}
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-2 border-t border-emerald-500/10">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-2 text-[11px] text-emerald-300/60">
            {session.context.model && <span>{tr("模型", "model")}: {session.context.model}</span>}
            {session.context.api && <span>api: {session.context.api}</span>}
            <span>{tr("输入/输出/合计 token", "in/out/total tokens")}: {formatTokens(session)}</span>
          </div>
          <div className="text-[11px] text-emerald-300/80">
            {tr("状态", "status")}: {session.phaseMessage}
            {session.context.maxTokens ? ` · max_tokens=${session.context.maxTokens}` : ""}
          </div>
          {session.context.promptText && (
            <div>
              <button type="button" onClick={() => setShowPrompt((v) => !v)} className="text-[11px] text-emerald-400 hover:underline">
                {showPrompt ? tr("隐藏发送 Prompt", "Hide prompt") : tr("查看发送 Prompt", "View prompt")}
              </button>
              {showPrompt && (
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-black/50 p-2 text-[11px] leading-relaxed text-emerald-200/70">
                  {session.context.promptText}
                </pre>
              )}
            </div>
          )}
          {session.preview && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/50 p-2 text-[12px] leading-relaxed text-emerald-100/90">
              {session.preview}
              {isActive(session) && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-emerald-400 animate-pulse align-middle" />}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

export function LlmLivePanel() {
  const { sessions, connection, activeCount, clear } = useLlmLiveFeed();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [nowMs, setNowMs] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const latestId = sessions.at(-1)?.context.interactionId;

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  // When a new call starts, collapse finished ones and focus the newest.
  useEffect(() => {
    if (!latestId) return;
    followRef.current = true;
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      for (const s of sessions) {
        if (s.context.interactionId !== latestId && !isActive(s)) next.add(s.context.interactionId);
      }
      next.delete(latestId);
      return next;
    });
  }, [latestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const latestSession = sessions.at(-1);
  const visible = brief
    ? (latestSession ? [latestSession] : [])
    : sessions;

  useLayoutEffect(() => {
    if (followRef.current && latestSession) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      });
    }
  }, [sessions, brief, latestSession]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleClear = () => {
    clear();
    setCollapsedIds(new Set());
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/70 px-2.5 py-1.5 text-[13px] text-foreground hover:bg-secondary/50 transition-colors"
        title={tr("AI 实况", "AI Live")}
      >
        <Radio size={15} className={activeCount > 0 ? "text-emerald-500 animate-pulse" : "text-muted-foreground"} />
        <span>{tr("AI 实况", "AI Live")}</span>
        {activeCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-emerald-600 text-white text-[10px] flex items-center justify-center">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`fixed z-50 flex flex-col rounded-xl border border-emerald-500/25 bg-[#0b1410]/[0.97] text-emerald-100 shadow-2xl backdrop-blur-sm ${
            expanded ? "inset-8" : "bottom-4 right-4 w-[min(680px,calc(100vw-32px))] h-[min(560px,calc(100vh-80px))]"
          }`}
        >
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-emerald-500/20 cursor-move select-none">
            <Activity size={16} className="text-emerald-400" />
            <span className="text-sm font-semibold tracking-wide">AI {tr("创作实况", "Creation Live")} / LIVE LOG</span>
            <span className="text-[11px] text-emerald-300/50 ml-1">{tr("每次调用独立显示。新调用自动聚焦，已完成收起；清空只影响当前窗口。", "One card per call. Auto-focus new calls, collapse finished ones; clear affects this window only.")}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <span className={`rounded-full px-2 py-0.5 text-[11px] ${connection === "connected" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
                {connection === "connected"
                  ? (activeCount > 0 ? `${activeCount} ${tr("项进行中", "active")}` : tr("等待生成", "Waiting"))
                  : (connection === "connecting" ? tr("正在连接", "Connecting") : tr("重连中", "Reconnecting"))}
              </span>
              <button type="button" onClick={() => setBrief((v) => !v)} className="rounded p-1 text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/10" title={tr("简略", "Brief")}>
                <span className="text-[11px]">{brief ? tr("详细", "Detailed") : tr("简略", "Brief")}</span>
              </button>
              <button type="button" onClick={() => setExpanded((v) => !v)} className="rounded p-1 text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/10" title={tr("全屏", "Expand")}>
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              {!brief && (
                <button type="button" onClick={handleClear} className="rounded p-1 text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/10" title={tr("清空前台", "Clear")}>
                  <Trash2 size={14} />
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/10" title={tr("关闭", "Close")}>
                <X size={15} />
              </button>
            </div>
          </div>

          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3 space-y-2">
            {visible.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-emerald-300/40">
                {connection === "connected"
                  ? tr("前台日志已清空，等待新的 AI 生成开始…", "Frontend log cleared, waiting for new AI generation…")
                  : tr("正在连接 AI 实况服务…", "Connecting to AI live service…")}
              </div>
            ) : (
              visible.map((s) => (
                <SessionCard
                  key={s.context.interactionId}
                  session={s}
                  nowMs={nowMs}
                  collapsed={collapsedIds.has(s.context.interactionId)}
                  onToggle={() => toggleCollapse(s.context.interactionId)}
                />
              ))
            )}
          </div>

          <div className="px-3 py-1.5 border-t border-emerald-500/20 flex items-center justify-between text-[10px] text-emerald-300/40">
            <span>{followRef.current ? tr("正在跟随最新输出", "Following latest") : tr("已停留在当前阅读位置", "Paused at current position")}</span>
            {!followRef.current && (
              <button type="button" onClick={() => { followRef.current = true; if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }} className="hover:text-emerald-200">
                {tr("回到最新输出", "Back to latest")}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
