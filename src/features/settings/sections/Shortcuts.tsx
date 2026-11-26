/** Keyboard shortcuts reference (§8.7): every binding, grouped by scope, filterable, with platform labels. */
import { Keyboard } from "lucide-react";
import { useMemo, useState } from "react";
import { shortcutsByScope, type ShortcutScope } from "@/app/shortcuts";
import { isMac, shortcutLabel } from "@/lib/platform";
import { useUi } from "@/stores/ui";
import { Button } from "@/ui/Button";
import { Kbd } from "@/ui/Kbd";
import { SearchField } from "@/ui/SearchField";
import { Group, SectionHeader } from "../parts";

const SCOPES: { id: ShortcutScope; title: string; note: string }[] = [
  { id: "app", title: "Everywhere", note: "Work from any screen." },
  { id: "formatting", title: "Formatting", note: "While editing text." },
  { id: "blocks", title: "Blocks", note: "Moving and changing blocks in a page." },
  { id: "database", title: "Databases", note: "In table and board views." },
  { id: "sheets", title: "Sheets", note: `In the spreadsheet grid. ${shortcutLabel("mod+shift+l")} always locks, so filters use ${shortcutLabel("mod+shift+f")}.` },
];
const HIDDEN = new Set(["region.prev", "app.redo"]);

export function ShortcutsSection() {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const all = shortcutsByScope();
    const needle = q.trim().toLowerCase();
    return SCOPES.map((s) => ({
      ...s,
      items: all[s.id].filter((d) => !HIDDEN.has(d.id) && (!needle || d.description.toLowerCase().includes(needle) || (Array.isArray(d.keys) ? d.keys : [d.keys]).some((k) => k.includes(needle)))),
    })).filter((g) => g.items.length);
  }, [q]);

  return (
    <div>
      <SectionHeader
        icon={Keyboard}
        title="Keyboard shortcuts"
        description={isMac ? "EMP is keyboard-first. ⌘ is the Command key." : "EMP is keyboard-first. Shortcuts use Ctrl, Alt and Shift on this computer."}
        actions={
          <Button size="sm" variant="secondary" kbd="mod+/" onClick={() => useUi.getState().setShortcutsOpen(true)}>
            Cheat sheet
          </Button>
        }
      />
      <div className="mb-5">
        <SearchField value={q} onChange={(e) => setQ(e.currentTarget.value)} onClear={() => setQ("")} placeholder="Find a shortcut" shortcut={null} aria-label="Find a shortcut" />
      </div>
      {groups.map((g) => (
        <Group key={g.id} id={g.id === "app" ? "shortcuts-app" : undefined} title={g.title} description={g.note} flush>
          <div className="st-keys">
            {g.items.map((d) => {
              const keys = Array.isArray(d.keys) ? d.keys : [d.keys];
              return (
                <div key={d.id} className="st-key-row">
                  <span className="truncate">{d.description}</span>
                  <span className="flex flex-none items-center gap-1.5">
                    {keys.slice(0, 2).map((k, i) => (
                      <span key={k} className="flex items-center gap-1.5">
                        {i > 0 ? <span className="text-caption text-disabled">or</span> : null}
                        <Kbd keys={k} size="sm" />
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </Group>
      ))}
      {!groups.length ? <p className="py-10 text-center text-body-sm text-tertiary">No shortcuts match “{q}”.</p> : null}
    </div>
  );
}
