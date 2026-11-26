/**
 * Keyboard shortcut cheat sheet (§8.7): ⌘/ (no block selected) or `?` outside text. Platform labels (⌘ on macOS,
 * Ctrl elsewhere), filterable, grouped by scope.
 */
import { useMemo, useState } from "react";
import { shortcutsByScope, type ShortcutScope } from "@/app/shortcuts";
import { useUi } from "@/stores/ui";
import { Dialog } from "@/ui/Dialog";
import { Kbd } from "@/ui/Kbd";
import { SearchField } from "@/ui/SearchField";

const SCOPES: { id: ShortcutScope; title: string }[] = [
  { id: "app", title: "App" },
  { id: "formatting", title: "Formatting" },
  { id: "blocks", title: "Blocks" },
  { id: "database", title: "Database" },
  { id: "sheets", title: "Sheets" },
];

const HIDDEN = new Set(["app.undo", "app.redo", "region.prev"]);

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const all = shortcutsByScope();
    const needle = q.trim().toLowerCase();
    return SCOPES.map((s) => ({
      ...s,
      items: all[s.id].filter((d) => !HIDDEN.has(d.id) && (!needle || d.description.toLowerCase().includes(needle))),
    })).filter((g) => g.items.length);
  }, [q]);

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), o || setQ(""))} size="lg" title="Keyboard shortcuts" description="Work faster without leaving the keyboard.">
      <SearchField value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")} placeholder="Filter shortcuts" shortcut={null} autoFocus data-autofocus aria-label="Filter shortcuts" />
      <div className="emp-keys-grid mt-5 max-h-[56vh] overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.id} className="emp-keys-group" aria-label={g.title}>
            <h3 className="mb-1 text-micro uppercase text-tertiary">{g.title}</h3>
            {g.items.map((d) => {
              const keys = Array.isArray(d.keys) ? d.keys : [d.keys];
              return (
                <div key={d.id} className="emp-keys-row">
                  <span className="truncate">{d.description}</span>
                  <span className="flex flex-none items-center gap-1.5">
                    {keys.slice(0, 2).map((k, i) => (
                      <span key={k} className="flex items-center gap-1.5">
                        {i > 0 ? <span className="text-caption text-disabled">or</span> : null}
                        <Kbd keys={k} size="xs" />
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
        {!groups.length ? <p className="py-6 text-center text-body-sm text-tertiary">No shortcuts match “{q}”.</p> : null}
      </div>
    </Dialog>
  );
}

export default ShortcutsDialog;
