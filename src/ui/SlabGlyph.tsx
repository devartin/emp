import { useId } from "react";
import { cn } from "@/lib/cn";

/* Geometry from assets/icon.svg (1024 viewBox): slab k (0 = bottom) has its top face centred at y = 563 − 100k. */
const CX = 512;
const HW = 235.56;
const HH = 136;
const THICK = 76;

function slab(k: number) {
  const cy = 563 - 100 * k;
  return {
    top: `${CX},${cy - HH} ${CX + HW},${cy} ${CX},${cy + HH} ${CX - HW},${cy}`,
    left: `${CX - HW},${cy} ${CX},${cy + HH} ${CX},${cy + HH + THICK} ${CX - HW},${cy + THICK}`,
    right: `${CX + HW},${cy} ${CX},${cy + HH} ${CX},${cy + HH + THICK} ${CX + HW},${cy + THICK}`,
    edge: `${CX - HW},${cy} ${CX},${cy + HH} ${CX + HW},${cy}`,
  };
}

export interface SlabLayerProps {
  dim?: boolean;
  hidden?: boolean;
  offset?: number | readonly [number, number];
}

export interface SlabGlyphProps {
  /** Rendered width in px (height follows the glyph's aspect). */
  size?: number;
  /** 1–3 slabs (default 3). */
  layers?: 1 | 2 | 3;
  /** Settle the slabs in from y −8 with a 60ms stagger, bottom first (once, on mount). */
  animate?: boolean;
  /** Separate the slabs by 3 screen px (drop zones on drag-over: the exploded view). */
  exploded?: boolean;
  /** Explode distance between slabs in screen px when `exploded` (default 3). */
  explodeGap?: number;
  /**
   * Per-layer overrides, index 0 = bottom slab: `dim` fades the layer to 35%, `hidden` removes it (fades), `offset`
   * shifts it by screen px (number = y, or [x, y]). Changes glide on the settle spring (reduced motion: instant).
   */
  layerProps?: ReadonlyArray<SlabLayerProps | undefined>;
  /** Accent face tint for the top slab (life-app tiles), e.g. "var(--block-blue-text)". */
  tint?: string;
  className?: string;
  title?: string;
}

/**
 * The EMP slab glyph — the app icon's isometric three-slab stack, drawn live in the current theme's slab tones
 * (light: white faces on grey sides; dark/midnight: the icon's lit faces). Used by EmptyState, FileDropZone and
 * celebration moments. Decorative unless `title` is given.
 */
export function SlabGlyph({ size = 40, layers = 3, animate, exploded, explodeGap = 3, layerProps, tint, className, title }: SlabGlyphProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ks = Array.from({ length: layers }, (_, i) => i);
  const scale = 504 / size; // svg units per css px
  const gap = explodeGap * scale;
  return (
    <svg
      className={cn("emp-slab-glyph", className)}
      data-animate={animate ? "" : undefined}
      data-exploded={exploded ? "" : undefined}
      width={size}
      height={size * (600 / 504)}
      viewBox="260 190 504 600"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ ["--gap" as string]: `${gap}px`, ["--drop" as string]: `${8 * scale}px` }}
    >
      <defs>
        {ks.map((k) => (
          <linearGradient key={k} id={`${uid}t${k}`} x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0" style={{ stopColor: `var(--glyph-top-a${k})` }} />
            <stop offset="1" style={{ stopColor: `var(--glyph-top-b${k})` }} />
          </linearGradient>
        ))}
      </defs>
      {ks.map((k) => {
        const p = slab(k);
        const topTint = tint && k === layers - 1;
        const lp = layerProps?.[k];
        const off = lp?.offset;
        const [ox, oy] = off === undefined ? [0, 0] : typeof off === "number" ? [0, off] : off;
        return (
          <g
            key={k}
            className="emp-slab-layer"
            data-dim={lp?.dim ? "" : undefined}
            data-hidden={lp?.hidden ? "" : undefined}
            style={{ ["--k" as string]: k, ["--rk" as string]: layers - 1 - k, ["--lx" as string]: `${ox * scale}px`, ["--ly" as string]: `${oy * scale}px` }}
          >
            <polygon points={p.left} style={{ fill: `var(--glyph-left${k})` }} />
            <polygon points={p.right} style={{ fill: `var(--glyph-right${k})` }} />
            <polygon points={p.top} style={{ fill: topTint ? tint : `url(#${uid}t${k})` }} />
            <polyline points={p.edge} fill="none" style={{ stroke: "var(--glyph-edge)" }} strokeWidth={6} strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}
