/**
 * The EMP mark: three isometric slabs (the app icon's monochrome stack), drawn as live SVG so it can animate.
 *
 *   variant="tile"   the full app icon (dark squircle, lit slabs) — onboarding hero, lock screen, about
 *   variant="glyph"  just the slabs, tinted from currentColor against the canvas — inline/brand use
 *
 * Static by default (DESIGN v3 §7, earned motion): the mark is part of the page from the first frame. Motion is opt-in:
 *   animate   a short draw-in (layers rise 240ms on the v3 ease-out, 40ms apart), ≤ the vault-unlock budget
 *   stage     the lock screen's slab beats; only `open` is a moment (C3 vault unlock), the rest are C1 feedback
 * Nothing overshoots: every curve is an ease-out or ease-in cubic with control points inside [0, 1].
 */
import { m, useAnimationControls, type TargetAndTransition } from "motion/react";
import { useEffect, useId } from "react";
import { cn } from "@/lib/cn";
import { CLASSES, REGISTER, motionSeconds } from "@/ui/motion/register";
import { ease } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";

export interface AppMarkProps {
  size?: number;
  variant?: "tile" | "glyph";
  /** Play the draw-in (default false: the mark is static). */
  animate?: boolean;
  /** Delay before the first layer (s). */
  delay?: number;
  className?: string;
  /** Accessible name; omit for decorative use. */
  title?: string;
  /**
   * Slab beats for the lock screen (S2) and first run (S3). Overrides `animate`.
   *   drop      at rest from the first frame (the lock screen arrives without motion)
   *   rest      at rest
   *   press     C1 key-press feedback: the stack compresses ~1.5px in 60ms and settles back in 100ms (correct password)
   *   jolt      C1 feedback: the slabs knock ±2px out of line and re-stack in 160ms (wrong password)
   *   open      the C3 vault-unlock moment: a 60ms press, then the slabs separate upward and the tile fades, ≤ 600ms
   *   exploded  slabs held apart (first run: they assemble as `assemble` goes 0 → 1, C2 continuity per step)
   */
  stage?: "drop" | "rest" | "press" | "jolt" | "open" | "exploded";
  /** Bump to replay the same stage (e.g. a second wrong password). */
  stageKey?: number;
  /** 0 → 1: how assembled an `exploded` stack is (S3 key derivation progress). */
  assemble?: number;
}

/** Beat timings (s), all inside their register class. */
export const MARK_TIMING = {
  pressIn: REGISTER.keyPress.in / 1000,
  pressOut: REGISTER.keyPress.out / 1000,
  jolt: CLASSES.C1.maxIn / 1000,
  /** The whole vault-unlock beat: press + separate + fade. */
  open: Math.min(0.52, REGISTER.vaultUnlock.in / 1000),
  assemble: 0.2,
  settle: 0.16,
  drawIn: 0.24,
  drawStagger: 0.04,
} as const;

const T = MARK_TIMING;
const pressShare = T.pressIn / (T.pressIn + T.pressOut);
const openShare = T.pressIn / T.open;

/** Per-layer target for a stage; `u` is svg units per css px. Exported for the motion-budget test. */
export function stageTarget(stage: NonNullable<AppMarkProps["stage"]>, k: number, u: number, assemble: number): TargetAndTransition {
  switch (stage) {
    case "press":
      return {
        y: [0, (0.5 + k * 0.5) * u, 0],
        scaleY: [1, 0.97, 1],
        transition: { duration: T.pressIn + T.pressOut, times: [0, pressShare, 1], ease: [ease.press, ease.out] },
      };
    case "jolt": {
      const j = [2, -2, 1.5][k] * u;
      return { x: [0, j, -j * 0.4, 0], transition: { duration: T.jolt, times: [0, 0.3, 0.65, 1], ease: "easeOut" } };
    }
    case "open":
      // the stack presses (correct password), then lifts apart as the vault opens
      return {
        y: [0, (0.5 + k * 0.5) * u, -(6 + k * 14) * u],
        scaleY: [1, 0.97, 1],
        opacity: [1, 1, 0],
        transition: {
          y: { duration: T.open, times: [0, openShare, 1], ease: [ease.press, ease.out] },
          scaleY: { duration: T.open, times: [0, openShare, 1], ease: [ease.press, ease.out] },
          opacity: { duration: T.open, times: [0, 0.4, 1], ease: "easeIn" },
        },
      };
    case "exploded": {
      const gap = (1 - Math.max(0, Math.min(1, assemble))) * (k - 1) * 14 * u;
      return { y: -gap, opacity: 0.55 + 0.45 * assemble, x: 0, scaleY: 1, transition: { duration: T.assemble, ease: ease.out } };
    }
    default:
      return { y: 0, x: 0, scale: 1, scaleY: 1, opacity: 1, transition: { duration: T.settle, ease: ease.out } };
  }
}

/** The tile background's beat for a stage (null: it does not move). Exported for the motion-budget test. */
export function tileTarget(stage: NonNullable<AppMarkProps["stage"]>): TargetAndTransition | null {
  if (stage === "open") return { opacity: [1, 1, 0], scale: [1, 0.99, 1.03], transition: { duration: T.open, times: [0, openShare, 1], ease: [ease.press, ease.out] } };
  if (stage === "press") return { scale: [1, 0.99, 1], transition: { duration: T.pressIn + T.pressOut, times: [0, pressShare, 1], ease: [ease.press, ease.out] } };
  return null;
}

/* Geometry from assets/icon.svg (1024 viewBox). Slab k (0 = bottom) has its top face centred at y = 463 − 100k. */
const CX = 512;
const HALF_W = 235.56;
const HALF_H = 136;
const THICK = 76;
const topY = (k: number) => 563 - 100 * k;

function slabPoints(k: number) {
  const cy = topY(k);
  const top = `${CX},${cy - HALF_H} ${CX + HALF_W},${cy} ${CX},${cy + HALF_H} ${CX - HALF_W},${cy}`;
  const left = `${CX - HALF_W},${cy} ${CX},${cy + HALF_H} ${CX},${cy + HALF_H + THICK} ${CX - HALF_W},${cy + THICK}`;
  const right = `${CX + HALF_W},${cy} ${CX},${cy + HALF_H} ${CX},${cy + HALF_H + THICK} ${CX + HALF_W},${cy + THICK}`;
  const edge = `${CX - HALF_W},${cy} ${CX},${cy + HALF_H} ${CX + HALF_W},${cy}`;
  return { top, left, right, edge, cy };
}

/** Tile palette per layer (bottom → top), matching the icon's lighting. */
const TILE = [
  { t: ["#e4e4ea", "#b9b9c2", "#8f8f99"], l: ["#5d5d66", "#33333a"], r: ["#2a2a30", "#111114"], edge: 0.55, sheen: 0.35 },
  { t: ["#f2f2f4", "#d0d0d7", "#a6a6b0"], l: ["#6d6d76", "#3e3e46"], r: ["#323238", "#151518"], edge: 0.73, sheen: 0.55 },
  { t: ["#ffffff", "#e6e6ec", "#bdbdc6"], l: ["#7d7d87", "#4a4a52"], r: ["#3a3a41", "#19191d"], edge: 0.9, sheen: 0.75 },
];

/** Glyph mix ratios of currentColor over the canvas: [top, left, right] per layer. */
const GLYPH = [
  [46, 70, 86],
  [66, 80, 92],
  [100, 86, 96],
];

export function AppMark({ size = 64, variant = "tile", animate = false, delay = 0, className, title, stage, stageKey = 0, assemble = 1 }: AppMarkProps) {
  const uid = useId().replace(/:/g, "");
  const reduced = useReducedMotionPref();
  const play = animate && !reduced && !stage;
  const c0 = useAnimationControls();
  const c1 = useAnimationControls();
  const c2 = useAnimationControls();
  const bg = useAnimationControls();
  const unit = (variant === "tile" ? 896 : 512) / size;
  useEffect(() => {
    if (!stage) return;
    const ctrls = [c0, c1, c2];
    if (reduced) {
      // Reduced motion: no travel. The end state, with the vault opening as a plain crossfade (C3 under reduced motion).
      const d = motionSeconds("vaultUnlock", true);
      ctrls.forEach((c) => void c.start({ x: 0, y: 0, scale: 1, scaleY: 1, opacity: stage === "open" ? 0 : 1, transition: { duration: stage === "open" ? d : 0 } }));
      void bg.start({ opacity: stage === "open" ? 0 : 1, scale: 1, transition: { duration: stage === "open" ? d : 0 } });
      return;
    }
    ctrls.forEach((c, k) => void c.start(stageTarget(stage, k, unit, assemble)));
    const tileBeat = tileTarget(stage);
    if (tileBeat) void bg.start(tileBeat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, stageKey, reduced, stage === "exploded" ? assemble : 0]);
  const staged = !!stage;
  const id = (s: string) => `${uid}-${s}`;
  const tile = variant === "tile";
  const viewBox = tile ? "64 64 896 896" : "256 200 512 620";

  const layer = (k: number) => {
    const p = slabPoints(k);
    const c = TILE[k];
    const g = GLYPH[k];
    const mix = (pct: number) => `color-mix(in oklab, currentColor ${pct}%, var(--bg-canvas))`;
    const body = (
      <>
        <polygon points={p.left} fill={tile ? `url(#${id(`l${k}`)})` : mix(g[1])} strokeLinejoin="round" />
        <polygon points={p.right} fill={tile ? `url(#${id(`r${k}`)})` : mix(g[2])} strokeLinejoin="round" />
        <polygon points={p.top} fill={tile ? `url(#${id(`t${k}`)})` : mix(g[0])} strokeLinejoin="round" />
        {tile ? <polygon points={p.top} fill={`url(#${id("sheen")})`} opacity={c.sheen} /> : null}
        <polyline
          points={p.edge}
          fill="none"
          stroke={tile ? "#fff" : "var(--bg-canvas)"}
          strokeOpacity={tile ? c.edge : 0.5}
          strokeWidth={tile ? 2.2 : 6}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </>
    );
    if (staged) {
      const ctrl = [c0, c1, c2][k];
      const init = stage === "exploded" ? { y: -(k - 1) * 14 * unit * (1 - assemble), opacity: 0.55 + 0.45 * assemble } : false;
      return (
        <m.g key={k} initial={init} animate={ctrl} style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}>
          {body}
        </m.g>
      );
    }
    if (!play) return <g key={k}>{body}</g>;
    return (
      <m.g
        key={k}
        initial={{ opacity: 0, y: -12 * unit }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: T.drawIn, ease: ease.out, delay: delay + k * T.drawStagger }}
      >
        {body}
      </m.g>
    );
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={cn("emp-app-mark flex-none", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ overflow: "visible" }}
    >
      {tile ? (
        <defs>
          <linearGradient id={id("bg")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#25252c" />
            <stop offset="0.5" stopColor="#131317" />
            <stop offset="1" stopColor="#070709" />
          </linearGradient>
          <radialGradient id={id("halo")} cx="0.5" cy="0.44" r="0.46">
            <stop offset="0" stopColor="#c9d2ff" stopOpacity="0.14" />
            <stop offset="0.6" stopColor="#ffffff" stopOpacity="0.03" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("rim")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.3" />
            <stop offset="0.35" stopColor="#ffffff" stopOpacity="0.07" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.03" />
          </linearGradient>
          <radialGradient id={id("sheen")} cx="0.3" cy="0.15" r="0.9">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.15" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={id("shadow")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#000" stopOpacity="0.7" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          {TILE.map((c, k) => (
            <g key={k}>
              <linearGradient id={id(`t${k}`)} x1="0.15" y1="0" x2="0.85" y2="1">
                <stop offset="0" stopColor={c.t[0]} />
                <stop offset="0.55" stopColor={c.t[1]} />
                <stop offset="1" stopColor={c.t[2]} />
              </linearGradient>
              <linearGradient id={id(`l${k}`)} x1="0" y1="0" x2="0.35" y2="1">
                <stop offset="0" stopColor={c.l[0]} />
                <stop offset="1" stopColor={c.l[1]} />
              </linearGradient>
              <linearGradient id={id(`r${k}`)} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor={c.r[0]} />
                <stop offset="1" stopColor={c.r[1]} />
              </linearGradient>
            </g>
          ))}
          <clipPath id={id("sq")}>
            <rect x="64" y="64" width="896" height="896" rx="200" />
          </clipPath>
        </defs>
      ) : null}
      {tile ? (
        <m.g
          initial={play ? { opacity: 0 } : false}
          animate={staged ? bg : { opacity: 1, scale: 1 }}
          transition={{ duration: T.drawIn, ease: ease.out, delay }}
          style={{ transformOrigin: "512px 512px" }}
        >
          <g clipPath={`url(#${id("sq")})`}>
            <rect x="64" y="64" width="896" height="896" fill={`url(#${id("bg")})`} />
            <rect x="64" y="64" width="896" height="896" fill={`url(#${id("halo")})`} />
            <ellipse cx="512" cy="805" rx="300" ry="64" fill={`url(#${id("shadow")})`} />
          </g>
          <rect x="65.5" y="65.5" width="893" height="893" rx="198.5" fill="none" stroke={`url(#${id("rim")})`} strokeWidth="3" />
        </m.g>
      ) : null}
      {[0, 1, 2].map(layer)}
    </svg>
  );
}

/** "Ultra Note" wordmark (IBM Plex Sans 700, −0.02em). Static by default; `animate` fades it in (no travel). */
export function Wordmark({ className, animate = false, delay = 0 }: { className?: string; animate?: boolean; delay?: number }) {
  return (
    <m.span
      className={cn("emp-wordmark", className)}
      initial={animate ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: T.drawIn, ease: ease.out, delay }}
    >
      Ultra Note
    </m.span>
  );
}

export default AppMark;
