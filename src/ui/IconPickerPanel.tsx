import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Glyph } from "./icons/Icon";
import { PAGE_ICON_GROUPS, searchPageIcons } from "./icons/pageIcons";

/** Columns in .emp-iconpick-grid (components.css). */
const COLS = 9;
const TOTAL = PAGE_ICON_GROUPS.reduce((n, g) => n + g.icons.length, 0);

interface Cell {
  name: string;
  /** Index into the flat list. */
  i: number;
  /** Visual row across all groups (each group starts a new row). */
  row: number;
  col: number;
}

/** Lays the filtered groups out the way the grid draws them: every group starts on a fresh row of COLS cells. */
function layout(groups: ReturnType<typeof searchPageIcons>): {
  cells: Cell[];
  rows: Cell[][];
} {
  const cells: Cell[] = [];
  const rows: Cell[][] = [];
  for (const g of groups) {
    g.icons.forEach((ic, k) => {
      if (k % COLS === 0) rows.push([]);
      const c: Cell = {
        name: ic.name,
        i: cells.length,
        row: rows.length - 1,
        col: k % COLS,
      };
      cells.push(c);
      rows[rows.length - 1].push(c);
    });
  }
  return { cells, rows };
}

/**
 * The icon picker body (docs/DESIGN.md §8), usable inline (gallery, settings) or inside <IconPicker>. Focus stays in
 * the search field; the active cell is announced through aria-activedescendant (combobox → listbox pattern). Cells are
 * not tab stops: Tab goes from search straight to Remove. ArrowUp / ArrowDown keep the visual column, across groups.
 */
export function IconPickerPanel({ onSelect, onRemove, value }: { onSelect: (name: string) => void; onRemove?: () => void; value?: string | null }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  const groups = useMemo(() => searchPageIcons(q), [q]);
  const { cells, rows } = useMemo(() => layout(groups), [groups]);
  const grid = useRef<HTMLDivElement>(null);

  const go = (n: number) => {
    if (!cells.length) return;
    const to = Math.max(0, Math.min(cells.length - 1, n));
    setActive(to);
    grid.current?.querySelector<HTMLElement>(`[data-i="${to}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const vertical = (d: 1 | -1) => {
    const cur = cells[active];
    if (!cur) return;
    const row = rows[cur.row + d];
    if (!row) return;
    go(row[Math.min(cur.col, row.length - 1)].i);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight") go(active + 1);
    else if (e.key === "ArrowLeft") go(active - 1);
    else if (e.key === "ArrowDown") vertical(1);
    else if (e.key === "ArrowUp") vertical(-1);
    else if (e.key === "Home" && e.ctrlKey) go(0);
    else if (e.key === "End" && e.ctrlKey) go(cells.length - 1);
    else if (e.key === "Enter" && cells[active]) onSelect(cells[active].name);
    else return;
    e.preventDefault();
  };
  const label = (name: string) => name.replace(/-/g, " ");
  let i = 0;
  return (
    <div className="emp-iconpick">
      <div className="emp-iconpick-head">
        <label className="emp-input" data-size="sm">
          <Glyph name="search" context="inline" className="text-tertiary" />
          <input
            autoFocus
            value={q}
            placeholder="Search icons"
            aria-label="Search icons"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={cells[active] ? optId(active) : undefined}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
        </label>
      </div>
      <div className="emp-iconpick-scroll" ref={grid} role="listbox" id={listId} aria-label="Icons" tabIndex={-1}>
        {groups.length === 0 ? <div className="emp-iconpick-empty">No icon matches “{q}”.</div> : null}
        {groups.map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className="emp-iconpick-group" aria-hidden>
              {g.label}
            </div>
            <div className="emp-iconpick-grid">
              {g.icons.map((ic) => {
                const idx = i++;
                return (
                  <button
                    key={ic.name}
                    id={optId(idx)}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={idx === active}
                    aria-current={value === ic.name ? "true" : undefined}
                    aria-label={value === ic.name ? `${label(ic.name)} (current)` : label(ic.name)}
                    title={label(ic.name)}
                    className="emp-iconpick-cell"
                    data-i={idx}
                    data-active={idx === active ? "" : undefined}
                    data-selected={value === ic.name ? "" : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => onSelect(ic.name)}
                  >
                    <Glyph name={ic.name} context="row" size={18} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="emp-iconpick-foot">
        <span aria-live="polite">{q ? `${cells.length} of ${TOTAL}` : "Arrow keys to move, Enter to pick"}</span>
        {onRemove ? (
          <button type="button" className="emp-btn" data-variant="ghost" data-size="xs" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default IconPickerPanel;
