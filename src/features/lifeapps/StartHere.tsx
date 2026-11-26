/**
 * "Start here" checklist (§16.1): items tick themselves from events; manual ticks call `lifeapp_checklist_tick`.
 * Ticking (S13): the recessed box fills into a lit app-colour key on the `pop` spring, 8 ink rays burst, the label's
 * strike draws left → right and fades to tertiary. Finishing the list plays the S8 moment on the ring.
 */
import { Check } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useRef } from "react";
import { api } from "@/backend";
import type { LifeAppInstance } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { useWorkspace } from "@/stores/workspace";
import { Card } from "@/ui/Card";
import { Ring } from "@/ui/Ring";
import { burst, celebrate } from "@/ui/motion/Celebrate";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";

export function StartHere({ instance, className }: { instance: LifeAppInstance; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  const items = instance.checklist;
  const done = items.filter((i) => i.done).length;
  if (!items.length) return null;
  const tick = async (id: string, el: HTMLElement) => {
    const remaining = items.filter((i) => !i.done && i.id !== id).length;
    useWorkspace.setState((s) => ({ lifeapps: s.lifeapps.map((x) => (x.id === instance.id ? { ...x, checklist: x.checklist.map((c) => (c.id === id ? { ...c, done: true } : c)) } : x)) }));
    burst(el, { radius: 12 });
    if (remaining === 0 && ref.current) {
      const ring = ref.current;
      window.setTimeout(() => celebrate((ring.firstElementChild as HTMLElement | null) ?? ring), 260);
    }
    try {
      await api.lifeapp.checklistTick({ instanceId: instance.id, itemId: id });
    } catch (e) {
      notify.fromError(e, "Couldn’t update the checklist");
      void useWorkspace.getState().refreshLifeapps();
    }
  };
  return (
    <Card className={className} pad="md">
      <div ref={ref} className="mb-2 flex items-center gap-3">
        <Ring value={done / items.length} size={40} aria-label={`${done} of ${items.length} done`}>
          <span className="text-[11px] font-semibold tabular text-secondary">
            {done}/{items.length}
          </span>
        </Ring>
        <div>
          <div className="text-body font-semibold text-primary">{done === items.length ? "All set" : "Start here"}</div>
          <div className="text-caption text-tertiary">{done === items.length ? "You’ve done every first step." : "A few first steps to make it yours."}</div>
        </div>
      </div>
      <ul className="la-start">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className={cn("la-start-row w-full", it.done && "is-done")}
              disabled={it.done}
              onClick={(e) => void tick(it.id, e.currentTarget.querySelector(".la-start-box") as HTMLElement)}
              aria-pressed={it.done}
            >
              <span className="la-start-box">
                <AnimatePresence>
                  {it.done ? (
                    <m.span initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1, transition: reduced ? { duration: 0.12 } : spring.pop }} exit={{ opacity: 0 }} className="flex">
                      <Check size={12} strokeWidth={3.2} aria-hidden />
                    </m.span>
                  ) : null}
                </AnimatePresence>
              </span>
              <span className="la-start-label">
                {it.label}
                <AnimatePresence>{it.done ? <m.i key="s" initial={{ scaleX: reduced ? 1 : 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1], delay: 0.06 }} aria-hidden /> : null}</AnimatePresence>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
