import { useVirtualizer } from "@tanstack/react-virtual";
import { Apple, Car, Clock, Dog, Lightbulb, Search, Shapes, Smile, Trophy } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EMOJI, EMOJI_GROUPS } from "./emoji-data";
import { IconButton } from "./IconButton";

const COLS = 8;
const CELL = 36;
const HEADER = 28;
const GROUP_ICONS = [Smile, Dog, Apple, Trophy, Car, Lightbulb, Shapes];

type Row = { kind: "header"; label: string; group: number } | { kind: "cells"; items: (readonly [string, string, number])[]; group: number };

export interface EmojiPickerPanelProps {
  onSelect: (emoji: string, name: string) => void;
  recent?: string[];
  autoFocus?: boolean;
}

/** 352×400 emoji grid, 8 columns of 36px, virtualised rows (§5.11). */
export default function EmojiPickerPanel({ onSelect, recent = [], autoFocus = true }: EmojiPickerPanelProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const { rows, flat } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? EMOJI.filter(([, n]) => n.includes(query)) : EMOJI;
    const out: Row[] = [];
    const flatList: (readonly [string, string, number])[] = [];
    const push = (label: string, group: number, items: (readonly [string, string, number])[]) => {
      if (!items.length) return;
      out.push({ kind: "header", label, group });
      for (let i = 0; i < items.length; i += COLS) out.push({ kind: "cells", items: items.slice(i, i + COLS), group });
      flatList.push(...items);
    };
    if (!query && recent.length) {
      const byChar = new Map(EMOJI.map((e) => [e[0], e] as const));
      push("Recent", -1, recent.map((c) => byChar.get(c) ?? ([c, "emoji", -1] as const)).slice(0, COLS * 2));
    }
    if (query) push(`Results`, 0, list.slice());
    else EMOJI_GROUPS.forEach((g, gi) => push(g, gi, list.filter((e) => e[2] === gi)));
    return { rows: out, flat: flatList };
  }, [q, recent]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i].kind === "header" ? HEADER : CELL),
    overscan: 8,
  });

  const indexOf = (rowIdx: number, col: number) => {
    let n = 0;
    for (let i = 0; i < rowIdx; i++) {
      const r = rows[i];
      if (r.kind === "cells") n += r.items.length;
    }
    return n + col;
  };

  const focusIndex = (i: number) => {
    const clamped = Math.max(0, Math.min(flat.length - 1, i));
    setActive(clamped);
    // find row containing clamped
    let n = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (row.kind !== "cells") continue;
      if (clamped < n + row.items.length) {
        virt.scrollToIndex(r, { align: "auto" });
        break;
      }
      n += row.items.length;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (d !== undefined) {
      e.preventDefault();
      focusIndex(active + d);
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      onSelect(flat[active][0], flat[active][1]);
    }
  };

  const jump = (g: number) => {
    const r = rows.findIndex((row) => row.kind === "header" && row.group === g);
    if (r >= 0) virt.scrollToIndex(r, { align: "start" });
  };

  const hovered = flat[active];
  return (
    <div style={{ width: 352, height: 400 }} className="flex flex-col" onKeyDown={onKey}>
      <div className="flex items-center gap-1 px-2 pt-2">
        <div className="emp-input flex-1" data-size="sm">
          <span className="emp-input-icon">
            <Search aria-hidden />
          </span>
          <input
            autoFocus={autoFocus}
            value={q}
            onChange={(e) => {
              setQ(e.currentTarget.value);
              setActive(0);
              scroller.current?.scrollTo({ top: 0 });
            }}
            placeholder="Search emoji"
            aria-label="Search emoji"
          />
        </div>
      </div>
      <div className="flex items-center gap-0.5 px-2 py-1.5" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        {recent.length ? <IconButton size="xs" icon={Clock} label="Recent" onClick={() => jump(-1)} /> : null}
        {EMOJI_GROUPS.map((g, i) => (
          <IconButton key={g} size="xs" icon={GROUP_ICONS[i]} label={g} onClick={() => jump(i)} />
        ))}
      </div>
      <div ref={scroller} className="flex-1 overflow-y-auto px-2" role="grid" aria-label="Emoji" style={{ overscrollBehavior: "contain" }}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <div key={vi.key} style={{ position: "absolute", top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` }}>
                {row.kind === "header" ? (
                  <div className="emp-menu-header" style={{ padding: "10px 2px 4px" }}>
                    {row.label}
                  </div>
                ) : (
                  <div className="emp-emoji-grid" role="row">
                    {row.items.map((e, col) => {
                      const idx = indexOf(vi.index, col);
                      return (
                        <button
                          key={e[0] + col}
                          type="button"
                          role="gridcell"
                          tabIndex={-1}
                          className="emp-emoji-cell"
                          data-active={idx === active ? "" : undefined}
                          title={e[1]}
                          aria-label={e[1]}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => onSelect(e[0], e[1])}
                        >
                          {e[0]}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {flat.length === 0 ? <div className="text-body-sm text-tertiary text-center py-10">No emoji match “{q}”</div> : null}
      </div>
      <div className="flex items-center gap-2 px-3 h-10 text-body-sm text-secondary" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        {hovered ? (
          <>
            <span style={{ fontSize: 20 }}>{hovered[0]}</span>
            <span className="truncate capitalize">{hovered[1]}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
