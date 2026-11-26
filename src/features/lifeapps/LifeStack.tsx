/**
 * The life stack (gallery hero): every life app as one slab of the EMP icon's isometric geometry, stacked bottom → top
 * in gallery order. Installed apps are graphite slabs (the icon's theme tones and neutral top face) with only a 2px
 * app-colour seam; the rest are dashed outlines waiting to be built. The app colour washes a slab's face only while it
 * is pulled out (opacity crossfade). Hovering a gallery card pulls its slab out of the stack like a drawer (`release` spring) while
 * the others dim. The stack drops in on mount (bottom first, 70ms stagger, `settle`). Decorative: aria-hidden.
 */
import { cn } from "@/lib/cn";
import { identity } from "./identity";

const CX = 98;
const HW = 72;
const HH = 41.5;
const T = 10;
const STEP = 15;
const TOP = 54;

function slab(cy: number) {
  return {
    top: `${CX},${cy - HH} ${CX + HW},${cy} ${CX},${cy + HH} ${CX - HW},${cy}`,
    left: `${CX - HW},${cy} ${CX},${cy + HH} ${CX},${cy + HH + T} ${CX - HW},${cy + T}`,
    right: `${CX + HW},${cy} ${CX},${cy + HH} ${CX},${cy + HH + T} ${CX + HW},${cy + T}`,
    edge: `${CX - HW},${cy} ${CX},${cy - HH} ${CX + HW},${cy}`,
    seam: `${CX - HW + 1},${cy + 0.5} ${CX},${cy + HH} ${CX + HW - 1},${cy + 0.5}`,
  };
}

export function LifeStack({ apps, installed, hot, enter }: { apps: string[]; installed: (appId: string) => boolean; hot: string | null; enter: boolean }) {
  const n = apps.length;
  const bottom = TOP + (n - 1) * STEP;
  return (
    <svg className="la-stack" viewBox={`0 0 196 ${bottom + HH + T + 14}`} aria-hidden data-hot={hot ? "" : undefined} data-enter={enter ? "" : undefined}>
      <defs>
        <radialGradient id="la-stack-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="rgb(0 0 0 / .2)" />
          <stop offset="1" stopColor="rgb(0 0 0 / 0)" />
        </radialGradient>
        <linearGradient id="la-stack-face" x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" style={{ stopColor: "var(--glyph-top-a2)" }} />
          <stop offset="1" style={{ stopColor: "var(--glyph-top-b2)" }} />
        </linearGradient>
        {apps.map((a) => {
          const c = identity(a).color;
          return (
            <linearGradient key={a} id={`la-stack-${a}`} x1="0.15" y1="0" x2="0.85" y2="1">
              <stop offset="0" style={{ stopColor: `color-mix(in oklab, ${c} 16%, var(--glyph-top-a2))` }} />
              <stop offset="1" style={{ stopColor: `color-mix(in oklab, ${c} 26%, var(--glyph-top-b2))` }} />
            </linearGradient>
          );
        })}
      </defs>
      <ellipse cx={CX} cy={bottom + HH + T + 2} rx={HW + 6} ry={14} fill="url(#la-stack-shadow)" />
      {apps.map((a, k) => {
        const cy = bottom - k * STEP;
        const p = slab(cy);
        const c = identity(a).color;
        const on = installed(a);
        const tone = Math.min(2, Math.floor((k * 3) / Math.max(1, n)));
        return (
          <g key={a} className="la-slab-in" style={{ ["--i" as string]: k }}>
            <g className={cn("la-slab", !on && "la-slab-ghost")} data-hot={hot === a ? "" : undefined}>
              <polygon points={p.left} style={{ fill: `var(--glyph-left${tone})` }} />
              <polygon points={p.right} style={{ fill: `var(--glyph-right${tone})` }} />
              <polygon points={p.top} style={{ fill: on ? "url(#la-stack-face)" : undefined }} />
              {on ? <polygon className="la-slab-tint" points={p.top} style={{ fill: `url(#la-stack-${a})` }} /> : null}
              {on ? (
                <>
                  <polyline points={p.seam} fill="none" style={{ stroke: c }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  <polyline points={p.edge} fill="none" style={{ stroke: "var(--glyph-edge)" }} strokeWidth={1} strokeLinejoin="round" />
                </>
              ) : null}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
