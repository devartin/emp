/**
 * Job progress (§11.1 (job) commands): a labelled bar with the step text crossfading, a count/percentage, an
 * optional Cancel, and a check that draws in when the job finishes. `useJob` runs a job and tracks its events.
 */
import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { hasCode, toBackendError, type JobHandle } from "@/backend";
import type { JobEvent } from "@/backend/types";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { Progress } from "@/ui/Progress";
import { ease } from "@/ui/motion/tokens";

export type JobPhase = "idle" | "running" | "done" | "error" | "cancelled";

export interface JobState<R> {
  phase: JobPhase;
  done: number;
  total: number;
  label?: string;
  result?: R;
  error?: string;
  errorCode?: string;
}

/** Start a (job) command with live progress. `run` receives the facade's onEvent listener. */
export function useJob<R>() {
  const [state, setState] = useState<JobState<R>>({ phase: "idle", done: 0, total: 0 });
  const handle = useRef<JobHandle<R> | null>(null);

  const start = useCallback(async (run: (onEvent: (e: JobEvent) => void) => Promise<JobHandle<R>>): Promise<R | null> => {
    setState({ phase: "running", done: 0, total: 0 });
    const onEvent = (e: JobEvent) => {
      if (e.kind === "progress") setState((s) => (s.phase === "running" ? { ...s, done: e.done, total: e.total, label: e.label ?? s.label } : s));
    };
    try {
      const h = await run(onEvent);
      handle.current = h;
      const result = await h.result;
      setState((s) => ({ ...s, phase: "done", result, done: s.total || 1, total: s.total || 1 }));
      return result;
    } catch (e) {
      const err = toBackendError(e);
      if (hasCode(err, "CANCELLED")) setState((s) => ({ ...s, phase: "cancelled" }));
      else setState((s) => ({ ...s, phase: "error", error: err.message, errorCode: err.code }));
      throw err;
    } finally {
      handle.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    void handle.current?.cancel().catch(() => undefined);
  }, []);

  const reset = useCallback(() => setState({ phase: "idle", done: 0, total: 0 }), []);

  return { state, start, cancel, reset };
}

export function JobProgress({ state, onCancel, title, className, doneLabel = "Done" }: { state: JobState<unknown>; onCancel?: () => void; title?: string; className?: string; doneLabel?: string }) {
  const pct = state.total > 0 ? Math.min(1, state.done / state.total) : 0;
  const done = state.phase === "done";
  return (
    <div className={cn("st-job", className)} data-phase={state.phase} role="status" aria-live="polite">
      <div className="st-job-top">
        <span className="st-job-mark" aria-hidden>
          <AnimatePresence initial={false} mode="wait">
            {done ? (
              <m.span key="ok" className="st-job-ok" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 400, damping: 22 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                  <m.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: ease.out }} />
                </svg>
              </m.span>
            ) : state.phase === "error" ? (
              <m.span key="err" className="st-job-err" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <X size={12} strokeWidth={3} />
              </m.span>
            ) : (
              <m.span key="spin" className="st-job-spin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            )}
          </AnimatePresence>
        </span>
        <div className="min-w-0 flex-1">
          {title ? <div className="st-job-title">{title}</div> : null}
          <div className="st-job-label">
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={done ? "done" : state.phase === "error" ? "error" : (state.label ?? "Starting")}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease: ease.out } }}
                exit={{ opacity: 0, y: -4, transition: { duration: 0.07, ease: ease.in } }}
                className="block truncate"
              >
                {done ? doneLabel : state.phase === "error" ? state.error : state.phase === "cancelled" ? "Cancelled" : (state.label ?? "Starting…")}
              </m.span>
            </AnimatePresence>
          </div>
        </div>
        <span className="st-job-pct tabular">{state.phase === "running" && state.total > 0 ? `${Math.round(pct * 100)}%` : ""}</span>
        {onCancel && state.phase === "running" ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <Progress
        value={done ? 1 : pct}
        indeterminate={state.phase === "running" && state.total === 0}
        size={4}
        color={state.phase === "error" ? "var(--loss)" : done ? "var(--gain)" : undefined}
        aria-label={title ?? "Progress"}
      />
    </div>
  );
}
