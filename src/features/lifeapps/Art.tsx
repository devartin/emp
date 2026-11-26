/**
 * Monochrome line-art for life-app cards, drawn in the app colour (`currentColor`). Decorative only.
 * Every piece carries a hover-preview hook (lifeapps.css): `a-bar` grows from its base, `a-draw` pens a path,
 * `a-pop` pops, `a-rise` rises, `a-fade` lights up, `a-ripple` dips like a wave — staggered by `--i`.
 * At rest (and under reduced motion) the art is complete and static.
 */
import type { CSSProperties } from "react";

const i = (n: number) => ({ ["--i" as string]: n }) as CSSProperties;

export function AppArt({ appId }: { appId: string }) {
  const common = { width: 150, height: 96, viewBox: "0 0 150 96", fill: "none", "aria-hidden": true, className: "la-art" } as const;
  switch (appId) {
    case "money-hq":
      return (
        <svg {...common}>
          {[18, 34, 26, 46, 38, 58, 50].map((h, k) => (
            <rect key={k} className="a-bar" style={i(k)} x={8 + k * 19} y={92 - h} width="12" height={h + 4} rx="3" fill="currentColor" opacity={k % 2 ? 0.16 : 0.32} />
          ))}
          <path className="a-draw" pathLength={1} d="M6 64 C 30 58, 44 40, 66 44 S 108 22, 142 14" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
          <circle className="a-pop" style={i(0)} cx="142" cy="14" r="8" fill="currentColor" opacity=".16" />
          <circle className="a-pop" style={i(1)} cx="142" cy="14" r="4" fill="currentColor" />
        </svg>
      );
    case "portfolio":
      return (
        <svg {...common}>
          {[
            [14, 52, 70, 40, 78],
            [34, 44, 60, 34, 66],
            [54, 30, 50, 22, 58],
            [74, 36, 48, 28, 56],
            [94, 22, 40, 14, 46],
            [114, 14, 30, 8, 36],
            [134, 10, 24, 4, 30],
          ].map(([x, o, c, hi, lo], k) => (
            <g key={k} className="a-rise" style={i(k)} opacity={k === 3 ? 0.35 : 0.85}>
              <line x1={x} x2={x} y1={hi} y2={lo} stroke="currentColor" strokeWidth="1.5" />
              <rect x={x - 5} y={Math.min(o, c)} width="10" height={Math.abs(c - o) + 2} rx="2" fill="currentColor" opacity={k === 3 ? 1 : 0.5} />
            </g>
          ))}
          <path d="M4 88 L146 88" stroke="currentColor" strokeOpacity=".2" />
        </svg>
      );
    case "tax-organizer":
      return (
        <svg {...common}>
          <path d="M44 6 h62 a6 6 0 0 1 6 6 v84 l-9 -6 -9 6 -9 -6 -9 6 -9 -6 -9 6 -9 -6 -9 6 V12 a6 6 0 0 1 6 -6 z" fill="currentColor" opacity=".12" stroke="currentColor" strokeOpacity=".5" strokeWidth="1.5" />
          {[22, 34, 46, 58].map((y, k) => (
            <g key={y} className="a-fade" style={i(k * 2)}>
              <rect x="52" y={y} width={k === 3 ? 26 : 34} height="5" rx="2.5" fill="currentColor" opacity=".35" />
              <rect x="94" y={y} width="10" height="5" rx="2.5" fill="currentColor" opacity=".55" />
            </g>
          ))}
          <g className="a-pop" style={i(0)}>
            <circle cx="112" cy="70" r="14" fill="currentColor" />
            <path d="M105 70.5 l5 5 9 -10" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        </svg>
      );
    case "spreadsheet-studio":
      return (
        <svg {...common}>
          <rect x="16" y="10" width="126" height="84" rx="8" fill="currentColor" opacity=".08" stroke="currentColor" strokeOpacity=".35" />
          {Array.from({ length: 5 }, (_, r) =>
            Array.from({ length: 5 }, (_, c) => {
              const lit = (r === 1 && c > 1) || (r === 2 && c === 2);
              return (
                <rect
                  key={`${r}-${c}`}
                  className={lit ? "a-fade" : undefined}
                  style={lit ? i(r * 3 + c) : undefined}
                  x={22 + c * 24}
                  y={16 + r * 15}
                  width="20"
                  height="11"
                  rx="2"
                  fill="currentColor"
                  opacity={r === 0 ? 0.3 : lit ? 0.22 : r === 4 && c === 4 ? 0.9 : 0.1}
                />
              );
            }),
          )}
          <rect className="a-pop" style={i(1)} x="116" y="74" width="24" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "life-os":
      return (
        <svg {...common}>
          {[0, 1, 2].map((col) => (
            <g key={col}>
              <rect x={14 + col * 44} y="8" width="38" height="88" rx="7" fill="currentColor" opacity=".07" />
              {Array.from({ length: [3, 2, 3][col] }, (_, k) => (
                <g key={k} className={col === 2 ? undefined : "a-rise"} style={i(col * 3 + k)}>
                  <rect x={18 + col * 44} y={14 + k * 24} width="30" height="19" rx="4" fill="currentColor" opacity={col === 2 ? 0.16 : 0.3} />
                  {col === 2 ? (
                    <path className="a-draw" pathLength={1} style={{ animationDelay: `${360 + k * 140}ms` }} d={`M${23 + col * 44} ${24 + k * 24} l3 3 6 -6`} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  ) : null}
                </g>
              ))}
            </g>
          ))}
        </svg>
      );
    case "habits":
      return (
        <svg {...common}>
          {Array.from({ length: 6 }, (_, r) =>
            Array.from({ length: 9 }, (_, c) => {
              const v = [1, 0.85, 1, 0.2, 1, 1, 0.6, 1, 1][(c + r * 4) % 9];
              // The wave starts at today's cell (bottom-right) and travels back through the weeks.
              const d = 8 - c + (5 - r);
              return <rect key={`${r}-${c}`} className="a-ripple" style={{ ...i(d), transformBox: "fill-box", transformOrigin: "50% 50%" }} x={18 + c * 14} y={10 + r * 14} width="11" height="11" rx="3" fill="currentColor" opacity={v * 0.75 + 0.06} />;
            }),
          )}
        </svg>
      );
    default:
      return null;
  }
}
