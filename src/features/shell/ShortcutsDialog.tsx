/**
 * Keyboard shortcut cheat sheet (§8.7): ⌘/ (no block selected) or `?` outside text. Platform labels (⌘ on macOS,
 * Ctrl elsewhere), filterable, grouped by scope.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutsByScope, type ShortcutScope } from "@/app/shortcuts";
import { useUi } from "@/stores/ui";
import { Dialog } from "@/ui/Dialog";
import { Kbd } from "@/ui/Kbd";
import { SearchField } from "@/ui/SearchField";

const SCOPES: { id: ShortcutScope; title: string; where?: string }[] = [
  { id: "app", title: "App" },
  { id: "formatting", title: "Formatting", where: "In the editor" },
  { id: "blocks", title: "Blocks", where: "In the editor" },
  { id: "database", title: "Database", where: "In a table" },
  { id: "sheets", title: "Sheets", where: "In a sheet" },
];
const ROW_WHERE: Partial<Record<ShortcutScope, string>> = { formatting: "In editor", blocks: "In editor", database: "In table", sheets: "In sheet" };

const HIDDEN = new Set(["app.undo", "app.redo", "region.prev"]);

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const [q, setQ] = useState("");
  const [edge, setEdge] = useState({ top: true, bottom: false });
  const groups = useMemo(() => {
    const all = shortcutsByScope();
    const needle = q.trim().toLowerCase();
    // App-wide bindings, so a scoped row that reuses one (⌘K for links in the editor) can say where it applies.
    const appKeys = new Set(all.app.flatMap((d) => (Array.isArray(d.keys) ? d.keys : [d.keys])));
    return SCOPES.map((s) => ({
      ...s,
      items: all[s.id]
        .filter((d) => !HIDDEN.has(d.id) && (!needle || d.description.toLowerCase().includes(needle)))
        .map((d) => {
          const keys = Array.isArray(d.keys) ? d.keys : [d.keys];
          return { d, keys, clash: s.id !== "app" && keys.some((k) => appKeys.has(k)) };
        }),
    })).filter((g) => g.items.length);
  }, [q]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measure = () => {
    const el = scrollRef.current;
    if (!el) return;
    const next = { top: el.scrollTop < 2, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
    setEdge((cur) => (cur.top === next.top && cur.bottom === next.bottom ? cur : next));
  };
  useEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(r);
  }, [open, groups]);

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), o || setQ(""))} size="lg" title="Keyboard shortcuts" description="Work faster without leaving the keyboard.">
      <SearchField value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")} placeholder="Filter shortcuts" shortcut={null} autoFocus data-autofocus aria-label="Filter shortcuts" />
      {/* Each section spans both columns: its header first, then its rows filling the left column top-down and then
          the right, so the two columns always start level. The body fades under its edges while it can scroll. */}
      <div ref={scrollRef} className="emp-keys-scroll mt-4" data-at-top={edge.top ? "" : undefined} data-at-end={edge.bottom ? "" : undefined} onScroll={measure}>
        {groups.map((g) => {
          const rows = Math.ceil(g.items.length / 2);
          return (
            <section key={g.id} className="emp-keys-group" aria-label={g.title}>
              <h3 className="emp-keys-head">
                {g.title}
                {g.where ? <span className="emp-keys-where">{g.where}</span> : null}
              </h3>
              <div className="emp-keys-cols" style={{ ["--rows" as string]: rows }}>
                {g.items.map(({ d, keys, clash }, i) => (
                  <div key={d.id} className="emp-keys-row" data-col-end={i === rows - 1 || i === g.items.length - 1 ? "" : undefined}>
                    <span className="min-w-0 truncate">
                      {d.description}
                      {clash && ROW_WHERE[g.id] ? <span className="emp-keys-scope">{ROW_WHERE[g.id]}</span> : null}
                    </span>
                    <span className="flex flex-none items-center gap-1.5">
                      {keys.slice(0, 2).map((k, j) => (
                        <span key={k} className="flex items-center gap-1.5">
                          {j > 0 ? <span className="text-caption text-disabled">or</span> : null}
                          <Kbd keys={k} size="xs" />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {!groups.length ? <p className="py-6 text-center text-body-sm text-tertiary">No shortcuts match “{q}”.</p> : null}
      </div>
    </Dialog>
  );
}

export default ShortcutsDialog;
