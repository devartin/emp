import * as RT from "@radix-ui/react-tabs";
import { m } from "motion/react";
import { createContext, useContext, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { RollingNumber } from "./motion/RollingNumber";
import { css } from "./motion/tokens";
import { isReducedMotion } from "./motion/useReducedEffects";

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: IconComponent | ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  value: V;
  onValueChange: (v: V) => void;
  items: TabItem<V>[];
  /** Panels keyed by value; omit to use Tabs as a pure tab bar. */
  children?: ReactNode;
  className?: string;
  listClassName?: string;
  /** Extra controls at the end of the tab row. */
  trailing?: ReactNode;
  "aria-label"?: string;
}

/** Lateral direction of the last tab switch (±1), read by <TabPanel> for its slide. */
const NavSign = createContext(0);

/**
 * Tabs (docs/DESIGN.md §6.2): an engraved 2px groove baseline with an extruded 3px ink bar that glides with
 * leading-edge-first elasticity — the leading edge arrives in 40% of the time, then the trailing edge catches up
 * (WAAPI on transform only, 460ms). Hovered tabs get a ghost plate; counts roll. Switching sets
 * `:root[data-nav-dir=lateral]` and `--nav-sign` so panel content slides with direction.
 */
export function Tabs<V extends string = string>({ value, onValueChange, items, children, className, listClassName, trailing, ...aria }: TabsProps<V>) {
  const listRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const prevBox = useRef<{ l: number; w: number } | null>(null);
  const prevIndex = useRef(items.findIndex((t) => t.value === value));
  const sign = useRef(0);
  const index = items.findIndex((t) => t.value === value);
  if (index !== prevIndex.current) {
    sign.current = index > prevIndex.current ? 1 : -1;
    prevIndex.current = index;
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    const bar = barRef.current;
    if (!list || !bar) return;
    const place = (animate: boolean) => {
      const el = list.querySelector<HTMLElement>(`[data-tab-value="${CSS.escape(value)}"]`);
      if (!el) {
        bar.removeAttribute("data-ready");
        return;
      }
      const l = el.offsetLeft + 4;
      const w = Math.max(8, el.offsetWidth - 8);
      const to = `translateX(${l}px) scaleX(${w})`;
      const from = prevBox.current;
      prevBox.current = { l, w };
      bar.style.transform = to;
      bar.setAttribute("data-ready", "");
      if (!animate || !from || isReducedMotion() || (from.l === l && from.w === w)) return;
      const R0 = from.l + from.w;
      const R1 = l + w;
      const right = l > from.l; // moving right → the right edge leads
      const mid = right ? { L: from.l + (l - from.l) * 0.15, R: R1 } : { L: l, R: R0 + (R1 - R0) * 0.15 };
      bar.animate(
        [
          { transform: `translateX(${from.l}px) scaleX(${from.w})` },
          { transform: `translateX(${mid.L}px) scaleX(${mid.R - mid.L})`, offset: 0.4, easing: css.easeOut },
          { transform: to },
        ],
        { duration: 460, easing: css.easeOut },
      );
    };
    place(true);
    const ro = new ResizeObserver(() => place(false));
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, items.length]);

  const change = (v: string) => {
    if (v === value) return;
    const ni = items.findIndex((t) => t.value === v);
    const root = document.documentElement;
    root.setAttribute("data-nav-dir", "lateral");
    root.style.setProperty("--nav-sign", String(ni >= index ? 1 : -1));
    onValueChange(v as V);
  };
  // Radix focuses the trigger with a plain focus() inside mousedown, which Chrome treats as keyboard-like and paints
  // the focus ring on every mouse click. Do the same work first with `focusVisible: false` (Radix skips its handler
  // once the event is default-prevented).
  const onTriggerMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, v: string, disabled?: boolean) => {
    if (disabled || e.button !== 0 || e.ctrlKey) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    change(v);
  };

  return (
    <RT.Root value={value} onValueChange={change} className={className}>
      <div className={cn("emp-tabs-list", listClassName)}>
        <RT.List ref={listRef} className="relative flex items-stretch gap-0.5 min-w-0 overflow-x-auto" aria-label={aria["aria-label"]} style={{ scrollbarWidth: "none" }}>
          {items.map((t) => (
            <RT.Trigger
              key={t.value}
              value={t.value}
              disabled={t.disabled}
              className="emp-tab isolate"
              data-tab-value={t.value}
              onMouseDown={(e) => onTriggerMouseDown(e, t.value, t.disabled)}
            >
              <span className="emp-tab-hover" />
              {renderIcon(t.icon)}
              {t.label}
              {t.count !== undefined ? (
                <span className="emp-tab-count tabular">
                  <RollingNumber value={t.count} countUp={false} format={(n) => String(Math.round(n))} />
                </span>
              ) : null}
            </RT.Trigger>
          ))}
          <span ref={barRef} className="emp-tab-bar" aria-hidden />
        </RT.List>
        {trailing ? <div className="ml-auto flex items-center gap-1 pl-2">{trailing}</div> : null}
      </div>
      <NavSign.Provider value={sign.current}>{children}</NavSign.Provider>
    </RT.Root>
  );
}

/** A tab panel whose content slides 16px in the direction of the switch (lateral rule) and fades in 220ms. */
export function TabPanel({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const s = useContext(NavSign);
  return (
    <RT.Content value={value} className={cn("outline-none", className)}>
      <m.div initial={s ? { opacity: 0, x: s * 16 } : false} animate={{ opacity: 1, x: 0, transition: { duration: 0.22, ease: [0.2, 0, 0, 1] } }}>
        {children}
      </m.div>
    </RT.Content>
  );
}
