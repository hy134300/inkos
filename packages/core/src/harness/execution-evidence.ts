import type {WorkProfile, WorkManifest} from "./contracts.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type ExecutionEvidenceSink = (type: string, payload: Record<string, unknown>) => void;
const storage = new AsyncLocalStorage<{sink: ExecutionEvidenceSink; profile?: WorkProfile; work?: WorkManifest | null; baselineWork?: WorkManifest | null; authorRequest?: string}>();

// Global observers receive every evidence record regardless of which
// withExecutionEvidence scope produced it. Used by the Studio "AI live" feed;
// observers are isolated so a failing observer cannot break production.
const globalObservers = new Set<ExecutionEvidenceSink>();
export function registerExecutionEvidenceObserver(observer: ExecutionEvidenceSink): () => void {
  globalObservers.add(observer);
  return () => { globalObservers.delete(observer); };
}
export function withExecutionEvidence<T>(sink: ExecutionEvidenceSink, task: () => T, profile?: WorkProfile, work?: WorkManifest | null, authorRequest?: string, baselineWork?: WorkManifest | null): T {
  const parent = storage.getStore();
  const selectedWork = work === undefined ? parent?.work : work;
  return storage.run({sink, profile: profile ?? parent?.profile, work: selectedWork,
    baselineWork: baselineWork === undefined ? parent?.baselineWork === undefined ? selectedWork : parent.baselineWork : baselineWork,
    authorRequest: authorRequest === undefined ? parent?.authorRequest : authorRequest}, task);
}
export function recordExecutionEvidence(type: string, payload: Record<string, unknown>): void {
  storage.getStore()?.sink(type, payload);
  if (globalObservers.size === 0) return;
  for (const observer of globalObservers) {
    try { observer(type, payload); } catch { /* observers must never break production */ }
  }
}

export function currentExecutionProfile(): WorkProfile | undefined { return storage.getStore()?.profile; }
export function currentExecutionWork(): WorkManifest | null { return storage.getStore()?.work ?? null; }
/** The current user's request, independent of an agent's task paraphrase. */
export function currentExecutionAuthorRequest(): string | undefined { return storage.getStore()?.authorRequest; }
/** The episode's initial Work snapshot remains stable while actions update current work. */
export function currentExecutionBaselineWork(): WorkManifest | null | undefined { return storage.getStore()?.baselineWork; }
export function updateExecutionWork(work: WorkManifest): void { const context=storage.getStore();if(context)context.work=work; }
