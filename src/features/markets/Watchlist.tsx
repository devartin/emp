/** Watchlist panel (§11.3 watchlist_*): lists as tabs, live rows, add via search, per-symbol alerts. */
import { Bell, BellRing, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { GlideHighlight } from "@/ui/GlideHighlight";
import { useEffect, useState } from "react";
import type { SymbolKey, WatchlistSymbol } from "@/backend/types";
import { useQuote } from "@/stores/market";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { NumberField } from "@/ui/NumberField";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { Tooltip } from "@/ui/Tooltip";
import { fmtPrice } from "../finance/shared/format";
import { Quiet } from "../finance/shared/ui";
import { ticker, useWatchlists, useWatchlistsLoaded } from "./data";
import { QuoteRow } from "./QuoteTile";
import { SymbolSearch } from "./SymbolSearch";

export function WatchlistPanel({ selected, onSelect, unavailable }: { selected?: SymbolKey; onSelect: (s: SymbolKey) => void; unavailable?: boolean }) {
  const lists = useWatchlistsLoaded();
  const loaded = useWatchlists((s) => s.loaded);
  const [active, setActive] = useState<string | null>(null);
  const [alertFor, setAlertFor] = useState<WatchlistSymbol | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!active && lists.length) setActive(lists[0].id);
  }, [lists, active]);
  const list = lists.find((l) => l.id === active) ?? lists[0];
  return (
    <section className="fh-card fh-card-flush mk-watch">
      <div className="px-4 pt-4 pb-3 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="fh-card-title flex-1">Watchlists</h2>
          <IconButton icon={Plus} size="xs" label="New watchlist" onClick={() => setCreating(true)} />
        </div>
        {lists.length > 1 ? <Segmented size="sm" block value={list?.id ?? ""} onValueChange={setActive} options={lists.map((l) => ({ value: l.id, label: l.name }))} aria-label="Watchlist" /> : null}
        {list ? <SymbolSearch placeholder={`Add to ${list.name}`} onPick={(s) => void useWatchlists.getState().add(list.id, s)} /> : null}
      </div>
      <div className="mk-watch-rows">
        {!loaded ? (
          Array.from({ length: 6 }, (_, k) => (
            <div key={k} className="px-4 py-3">
              <Skeleton height={14} width="70%" />
            </div>
          ))
        ) : !list || !list.symbols.length ? (
          <Quiet title="Nothing here yet" body="Search for a symbol above to start watching it." />
        ) : (
          <AnimatePresence initial={false} mode="popLayout">
            <GlideHighlight key="__glide" selector=".mk-row.is-selected" tone="slab" attributes={["class"]} />
            {list.symbols.map((s) => (
              // compositor-only: rows fade/rise in, neighbours glide by `layout` transforms, exits pop out and fade
              <m.div key={s.key} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
                <QuoteRow
                  symbol={s.key}
                  unavailable={unavailable}
                  selected={s.key === selected}
                  onClick={() => onSelect(s.key)}
                  trailing={
                    <span className="flex items-center gap-0.5 flex-none" onClick={(e) => e.stopPropagation()}>
                      {s.alertAbove || s.alertBelow || s.alertPct ? (
                        <Tooltip content={alertText(s)}>
                          <span className="mk-alert-on" tabIndex={0}>
                            <BellRing size={12} />
                          </span>
                        </Tooltip>
                      ) : null}
                      <Menu>
                        <MenuTrigger asChild>
                          <IconButton icon={MoreHorizontal} size="xs" label={`${ticker(s.key)} options`} className="mk-row-more" />
                        </MenuTrigger>
                        <MenuContent align="end" width={200}>
                          <MenuItem icon={Bell} onSelect={() => setAlertFor(s)}>
                            Price alerts…
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem icon={Trash2} destructive onSelect={() => void useWatchlists.getState().remove(list.id, s.key)}>
                            Remove from {list.name}
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </span>
                  }
                />
              </m.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      {alertFor && list ? <AlertDialog listId={list.id} item={alertFor} onClose={() => setAlertFor(null)} /> : null}
      {creating ? <NewListDialog onClose={() => setCreating(false)} onCreated={(id) => setActive(id)} /> : null}
    </section>
  );
}

export function alertText(s: WatchlistSymbol): string {
  const parts: string[] = [];
  if (s.alertAbove) parts.push(`above ${fmtPrice(s.alertAbove)}`);
  if (s.alertBelow) parts.push(`below ${fmtPrice(s.alertBelow)}`);
  if (s.alertPct) parts.push(`moves ${s.alertPct}% in a day`);
  return parts.length ? `Alert when ${parts.join(", or ")}` : "No alerts";
}

export function AlertDialog({ listId, item, onClose }: { listId: string; item: WatchlistSymbol; onClose: () => void }) {
  const q = useQuote(item.key);
  const [above, setAbove] = useState<number | null>(item.alertAbove ?? null);
  const [below, setBelow] = useState<number | null>(item.alertBelow ?? null);
  const [pct, setPct] = useState<number | null>(item.alertPct ?? null);
  const save = async () => {
    await useWatchlists.getState().setAlerts(listId, item.key, { ...(above ? { alertAbove: above } : {}), ...(below ? { alertBelow: below } : {}), ...(pct ? { alertPct: pct } : {}) });
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Alerts for ${ticker(item.key)}`}
      description={q ? `Now ${fmtPrice(q.price, q.currency)}. Each alert fires at most once a day.` : "Each alert fires at most once a day."}
      size="sm"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => { setAbove(null); setBelow(null); setPct(null); }}>
            Clear all
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save alerts
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <NumberField label="Price rises above" value={above} onChange={setAbove} min={0} step={1} prefix="$" placeholder={q ? fmtPrice(q.price * 1.05) : ""} />
        <NumberField label="Price falls below" value={below} onChange={setBelow} min={0} step={1} prefix="$" placeholder={q ? fmtPrice(q.price * 0.95) : ""} />
        <NumberField label="Moves more than (in a day)" value={pct} onChange={setPct} min={0} max={100} step={0.5} suffix="%" />
      </div>
    </Dialog>
  );
}

function NewListDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New watchlist"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              const id = await useWatchlists.getState().create(name.trim());
              if (id) onCreated(id);
              onClose();
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dividend ideas" autoFocus />
    </Dialog>
  );
}
