/** "Start here" checklist (§16.1): items tick themselves from events; manual ticks call `lifeapp_checklist_tick`. */
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
import { celebrate } from "@/ui/motion/Celebrate";
import { spring } from "@/ui/motion/tokens";
import { identity } from "./identity";

export function StartHere({ instance, className }: { instance: LifeAppInstance; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = instance.checklist;
  const done = items.filter((i) => i.done).length;
  if (!items.length) return null;
  const tick = async (id: string, el: HTMLElement) => {
    const remaining = items.filter((i) => !i.done && i.id !== id).length;
    useWorkspace.setState((s) => ({ lifeapps: s.lifeapps.map((x) => (x.id === instance.id ? { ...x, checklist: x.checklist.map((c) => (c.id === id ? { ...c, done: true } : c)) } : x)) }));
    if (remaining === 0 && ref.current) celebrate(ref.current);
    else celebrate(el, { particles: 0 });
    try {
      await api.lifeapp.checklistTick({ instanceId: instance.id, itemId: id });
    } catch (e) {
      notify.fromError(e, "Couldn’t update the checklist");
      void useWorkspace.getState().refreshLifeapps();
    }
  };
  const color = identity(instance.appId).color;
  return (
    <Card className={className} pad="md">
      <div ref={ref} className="mb-2 flex items-center gap-3">
        <Ring value={done / items.length} size={40} color={color} aria-label={`${done} of ${items.length} done`}>
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
              <m.span className="la-start-box" animate={it.done ? { scale: [0.85, 1] } : { scale: 1 }} transition={spring.bouncy} style={{ ["--app" as string]: color }}>
                <AnimatePresence>
                  {it.done ? (
                    <m.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={spring.snappy}>
                      <Check size={12} strokeWidth={3.2} aria-hidden />
                    </m.span>
                  ) : null}
                </AnimatePresence>
              </m.span>
              <span className={cn("flex-1", it.done && "line-through decoration-[rgba(var(--text-rgb),.25)]")}>{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
