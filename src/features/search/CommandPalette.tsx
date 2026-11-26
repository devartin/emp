/**
 * Command palette and quick find (§5.9). Mounted once by the shell; opened through the ui store (⌘K all, ⌘P pages,
 * ⌘⇧P commands, ? shortcuts).
 *
 *   (none) pages, recent, actions      >  commands (with nested pages: Theme →, Accent →, Density → …)
 *   #  databases and rows              @  dates (daily notes, calendar)
 *   $SYM quote with sparkline + delta  =  calculator (units, currency; ↵ copies)
 *   ?  shortcuts
 *
 * Pages are matched fuzzily on the client (instant, with highlights) and merged with the backend's content hits
 * (snippets). Ranking: score = match × (1 + 0.3·recency + 0.2·frequency + 0.1·favorite). ⇧↵ opens in side peek.
 * Highlighting a Theme/Accent/Density option previews it live; Esc restores.
 */
import * as RD from "@radix-ui/react-dialog";
import { parseDate } from "chrono-node";
import { Command } from "cmdk";
import {
  ArrowRight, Calculator, CalendarDays, Check, ChevronLeft, CornerDownLeft, Database, FilePlus, FileSearch, Hash, Keyboard,
  LineChart, Plus, Search, Settings, TextSearch,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { getCommands, isAvailable, openTodayNote, runCommand, subscribeCommands, type AppCommand } from "@/app/commands";
import { navigate, useRoute, type AppRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import { SHORTCUTS, type ShortcutDef } from "@/app/shortcuts";
import { api, latestRequest } from "@/backend";
import type { Id, PageMeta, Quote, SearchHit } from "@/backend/types";
import { identity } from "@/features/lifeapps/identity";
import { PageIcon } from "@/features/shell/PageIcon";
import { SECTIONS, SETTING_ENTRIES } from "@/features/settings/meta";
import { Sparkline } from "@/charts/Sparkline";
import { cn } from "@/lib/cn";
import { formatDate, isoDay } from "@/lib/dates";
import { formatCurrency } from "@/lib/format";
import { useNav } from "@/stores/nav";
import { useSearch } from "@/stores/search";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi, type PaletteMode } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { Kbd } from "@/ui/Kbd";
import { Spinner } from "@/ui/Spinner";
import { duration, ease } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { calc, calcSync, type CalcResult } from "./calc";
import { fuzzy, fuzzyAny } from "./fuzzy";
import { commandIcon } from "./icons";
import type { MoneyTarget } from "./capture";
import { takeHeldKeys } from "./keyBuffer";
import { NESTED, type NestedPage, type NestedId } from "./nested";
import { takePaletteOrigin } from "./origin";
import type { Place } from "./places";
import { useExtras } from "./useExtras";
import "./palette.css";

// ───────────────────────────────────────────────────────────────────────────── model

type Scope = "all" | "pages" | "commands" | "tags" | "dates" | "quote" | "calc" | "shortcuts";

interface Item {
  id: string;
  group: string;
  title: string;
  ranges?: [number, number][];
  subtitle?: string;
  snippet?: { text: string; ranges: [number, number][] };
  icon: ReactNode;
  shortcut?: string;
  hint?: string;
  checked?: boolean;
  route?: AppRoute;
  /** Live preview while highlighted (nested pages). */
  preview?: () => void;
  run: (opts: { peek: boolean }) => void | Promise<void>;
  /** Keep the palette open after running (pushes a nested page). */
  stay?: boolean;
  render?: ReactNode;
  score?: number;
}

const PREFIX: Record<string, Scope> = { ">": "commands", "#": "tags", "@": "dates", $: "quote", "=": "calc", "?": "shortcuts" };

const SCOPE_LABEL: Record<Scope, string> = {
  all: "",
  pages: "Pages",
  commands: "Commands",
  tags: "Databases",
  dates: "Dates",
  quote: "Quote",
  calc: "Calculator",
  shortcuts: "Shortcuts",
};

const PLACEHOLDER: Record<Scope, string> = {
  all: "Search, or add with t, n or −12.50…",
  pages: "Find a page…",
  commands: "Run a command…",
  tags: "Find a database or row…",
  dates: "Try “tomorrow”, “next friday” or “dec 24”…",
  quote: "Symbol or company, e.g. NOVA",
  calc: "12 × 4.5 · 15% of 80 · 5 km in mi · 120 usd in eur",
  shortcuts: "Find a shortcut…",
};

const MODES: [string, Scope, string, typeof Search][] = [
  [">", "commands", "Run a command", Hash],
  ["#", "tags", "Search databases and rows", Database],
  ["@", "dates", "Jump to a date", CalendarDays],
  ["$", "quote", "Look up a quote", LineChart],
  ["=", "calc", "Calculate or convert", Calculator],
  ["?", "shortcuts", "Keyboard shortcuts", Keyboard],
];

const modeToScope = (m: PaletteMode): Scope => (m === "pages" ? "pages" : m === "commands" ? "commands" : m === "shortcuts" ? "shortcuts" : "all");

const DAY = 86_400_000;

function recency(updatedAt: number, now: number): number {
  return Math.exp(-(now - updatedAt) / (7 * DAY));
}

function pathOf(byId: Map<Id, PageMeta>, meta: PageMeta): string {
  const parts: string[] = [];
  let p = meta.parentId ? byId.get(meta.parentId) : undefined;
  let guard = 0;
  while (p && guard++ < 12) {
    parts.unshift(p.title || "Untitled");
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return parts.join(" / ");
}

function routeForPage(meta: Pick<PageMeta, "id" | "kind" | "appInstanceId">): AppRoute {
  if (meta.kind === "database") return { t: "db", id: meta.id };
  if (meta.kind === "sheet") return { t: "sheet", id: meta.id };
  if ((meta.kind === "app" || meta.kind === "dashboard") && meta.appInstanceId) return { t: "app", instanceId: meta.appInstanceId };
  return { t: "page", id: meta.id };
}

function Highlight({ text, ranges }: { text: string; ranges?: [number, number][] }) {
  if (!ranges?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={i} className="cmdk-hl">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="cmdk-icon" aria-hidden>
      {children}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────── async sources

function useContentHits(q: string, enabled: boolean, types?: SearchHit["kind"][]) {
  const [state, setState] = useState<{ q: string; hits: SearchHit[]; loading: boolean; ready: boolean }>({ q: "", hits: [], loading: false, ready: true });
  const latest = useMemo(() => latestRequest(), []);
  const typesKey = types?.join(",") ?? "";
  useEffect(() => {
    const query = q.trim();
    if (!enabled || !query) {
      latest.next();
      setState({ q: "", hits: [], loading: false, ready: true });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const t = window.setTimeout(() => {
      const reqId = latest.next();
      api.search
        .query({ q: query, limit: 24, reqId, filters: types?.length ? { type: types } : undefined })
        .then((res) => {
          if (!latest.isLatest(res.reqId)) return;
          setState({ q: query, hits: res.hits, loading: false, ready: res.indexReady });
        })
        .catch(() => latest.isLatest(reqId) && setState((s) => ({ ...s, loading: false })));
    }, 70);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, enabled, typesKey, latest]);
  return state;
}

interface QuoteRow {
  symbol: string;
  name: string;
  exchange: string;
  quote?: Quote;
  spark?: number[];
}

function useQuotes(q: string, enabled: boolean) {
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const latest = useMemo(() => latestRequest(), []);
  useEffect(() => {
    const query = q.trim();
    if (!enabled) return;
    if (!query) {
      setRows(null);
      return;
    }
    const t = window.setTimeout(async () => {
      const reqId = latest.next();
      try {
        const res = await api.market.search({ q: query, limit: 5, reqId });
        if (!latest.isLatest(reqId)) return;
        const base: QuoteRow[] = res.results.map((r) => ({ symbol: r.symbol, name: r.name, exchange: r.exchange }));
        setRows(base);
        if (!base.length) return;
        const syms = base.map((r) => r.symbol);
        const to = isoDay();
        const from = isoDay(Date.now() - 45 * DAY);
        const [quotes, bars] = await Promise.all([
          api.market.quotes({ symbols: syms }).catch(() => [] as Quote[]),
          Promise.all(syms.map((s) => api.market.bars({ symbol: s, interval: "1d", from, to, adjusted: true }).catch(() => null))),
        ]);
        if (!latest.isLatest(reqId)) return;
        setRows(base.map((r, i) => ({ ...r, quote: quotes.find((x) => x.symbol === r.symbol), spark: bars[i]?.c.slice(-30) })));
      } catch {
        if (latest.isLatest(reqId)) setRows([]);
      }
    }, 120);
    return () => window.clearTimeout(t);
  }, [q, enabled, latest]);
  return rows;
}

function useCalc(q: string, enabled: boolean): { result: CalcResult | null; pending: boolean } {
  const sync = useMemo(() => (enabled ? calcSync(q) : null), [q, enabled]);
  const [asyncRes, setAsync] = useState<{ q: string; r: CalcResult | null } | null>(null);
  useEffect(() => {
    if (!enabled || sync || !q.trim()) return;
    let live = true;
    const t = window.setTimeout(() => {
      void calc(q).then((r) => live && setAsync({ q, r }));
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, enabled, sync]);
  if (sync) return { result: sync, pending: false };
  if (asyncRes && asyncRes.q === q) return { result: asyncRes.r, pending: false };
  return { result: null, pending: enabled && !!q.trim() };
}

/**
 * A weak subsequence hit whose first matched character sits mid-word ("rent" → secu·r·ity c·ent·er). Commands drop
 * these: they would outrank nothing useful and, preselected, ↵ would run something unexpected.
 */
function scatteredHit(r: { match: number; ranges: [number, number][] }, title: string): boolean {
  if (r.match >= 0.45 || r.ranges.length < 2) return false;
  const i = r.ranges[0][0];
  return i > 0 && !/[\s\-_/.,:;()[\]→>·—–]/.test(title[i - 1]) && !(title[i - 1] === title[i - 1].toLowerCase() && title[i] !== title[i].toLowerCase());
}

// ───────────────────────────────────────────────────────────────────────────── component

export default function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const mode = useUi((s) => s.paletteMode);
  const initialQuery = useUi((s) => s.paletteQuery);
  const close = useUi((s) => s.closePalette);
  const reduced = useReducedMotionPref();
  /** Esc pops a nested page / scope first; the palette registers the handler here. */
  const escRef = useRef<(() => boolean) | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // S7: grow from the control that opened it (sidebar Search row), else drop from the top centre (⌘K).
  const origin = useMemo(() => (open ? takePaletteOrigin() : null), [open]);
  // What had focus (and where we were) when the palette opened, for focus restoration on close.
  // Captured on the closed → open transition (before the palette mounts, so activeElement is still the opener).
  const openedFrom = useRef<{ focus: HTMLElement | null; route: unknown }>({ focus: null, route: null });
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) openedFrom.current = { focus: document.activeElement instanceof HTMLElement ? document.activeElement : null, route: useNav.getState().route };
  wasOpen.current = open;
  const grow = useMemo(() => {
    if (!origin || typeof window === "undefined") return null;
    const w = Math.min(640, window.innerWidth - 32);
    const left = (window.innerWidth - w) / 2;
    const top = window.innerHeight * 0.14;
    return { ox: origin.left + origin.width / 2 - left, oy: origin.top + origin.height / 2 - top, s: Math.max(0.3, Math.min(0.9, origin.width / w)) };
  }, [origin]);

  // modal={false}: a modal Radix dialog sets pointer-events:none (inherited) on <body> and locks scroll, which
  // restyled the whole document (~2,000 elements, twice) in the opening frame. The scrim already blocks the page,
  // outside presses / focus still dismiss, and the panel declares aria-modal and traps Tab itself.
  return (
    <RD.Root open={open} onOpenChange={(o) => !o && close()} modal={false}>
      <AnimatePresence>
        {open ? (
          <RD.Portal forceMount key="cmdk">
            {/* Our own scrim (a non-modal Radix dialog renders no Overlay): it blocks the page, and a press on it is
                a press outside the panel, which dismisses. */}
            <m.div
              className="cmdk-scrim"
              aria-hidden
              initial={grow ? { opacity: 0 } : false}
              animate={{ opacity: 1, transition: { duration: grow ? duration.fast : 0, ease: ease.out } }}
              exit={{ opacity: 0, transition: { duration: grow ? 0.1 : 0, ease: ease.in } }}
            />
            <div className="cmdk-pos">
              <RD.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => {
                  // The palette has no Radix trigger and stays mounted through its exit, so Radix would drop focus on
                  // <body>. Restore it ourselves: after a navigation focus the content region; otherwise go back to
                  // whatever opened the palette. Never steal focus from something that already took it (a dialog the
                  // command opened, an editor that autofocused).
                  e.preventDefault();
                  const ae = document.activeElement;
                  if (ae && ae !== document.body && ae.isConnected) return;
                  const navigated = useNav.getState().route !== openedFrom.current.route;
                  const back = openedFrom.current.focus;
                  if (!navigated && back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
                  else document.querySelector<HTMLElement>('.emp-content[data-region="content"]')?.focus({ preventScroll: true });
                }}
                onEscapeKeyDown={(e) => {
                  if (escRef.current?.()) e.preventDefault();
                }}
              >
                <m.div
                  ref={panelRef}
                  // Non-modal Radix dialog (see RD.Root): we declare the modality and keep Tab inside ourselves.
                  aria-modal="true"
                  onKeyDown={(e) => {
                    if (e.key !== "Tab" || !panelRef.current) return;
                    const f = [...panelRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
                    if (!f.length) return;
                    const i = f.indexOf(document.activeElement as HTMLElement);
                    const next = e.shiftKey ? (i <= 0 ? f[f.length - 1] : f[i - 1]) : i === f.length - 1 || i < 0 ? f[0] : f[i + 1];
                    e.preventDefault();
                    next.focus();
                  }}
                  className="cmdk-panel glass-2"
                  style={grow && !reduced ? { transformOrigin: `${grow.ox}px ${grow.oy}px` } : undefined}
                  // Opened by keyboard (no origin) the palette is C0: present at its first frame, gone at once. Opened
                  // by pointer it is C1: a short scale from the control that opened it.
                  initial={!grow ? false : reduced ? { opacity: 0 } : { opacity: 0, scale: grow.s }}
                  animate={{
                    opacity: 1,
                    scale: 1,
                    y: 0,
                    transition: !grow ? { duration: 0 } : reduced ? { duration: 0.12 } : { duration: 0.15, ease: ease.out },
                  }}
                  exit={!grow || reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: ease.in } }}
                >
                  <RD.Title className="sr-only">Command palette</RD.Title>
                  <Palette initialScope={modeToScope(mode)} initialQuery={initialQuery} onClose={close} escRef={escRef} />
                </m.div>
              </RD.Content>
            </div>
          </RD.Portal>
        ) : null}
      </AnimatePresence>
    </RD.Root>
  );
}

function Palette({ initialScope, initialQuery, onClose, escRef }: { initialScope: Scope; initialQuery: string; onClose: () => void; escRef: { current: (() => boolean) | null } }) {
  const [scope, setScope] = useState<Scope>(() => {
    const p = PREFIX[initialQuery.charAt(0)];
    return p && initialScope === "all" ? p : initialScope;
  });
  const [input, setInput] = useState(() => (PREFIX[initialQuery.charAt(0)] && initialScope === "all" ? initialQuery.slice(1) : initialQuery));
  // Keys typed between ⌘K and this mount (keyBuffer.ts) are replayed into the input before the first paint.
  const held = useRef<string | null>(null);
  const [stack, setStack] = useState<NestedId[]>([]);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<(() => void) | null>(null);

  // Re-sync when the store asks for another mode while open (⌘P while ⌘K is open).
  useEffect(() => {
    setScope(initialScope);
    setStack([]);
  }, [initialScope]);

  useLayoutEffect(() => {
    held.current = takeHeldKeys();
    inputRef.current?.focus();
    if (held.current) onInput(input + held.current);
    void useSearch.getState().load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore any live preview when unmounting without a choice.
  useEffect(() => () => restoreRef.current?.(), []);

  const nested: NestedPage | null = stack.length ? NESTED[stack[stack.length - 1]] : null;
  const q = input;
  const effectiveScope: Scope = nested ? "commands" : scope;

  const commands = useSyncExternalStore(subscribeCommands, getCommands, getCommands);
  const byId = useTree((s) => s.byId);
  const favorites = useWorkspace((s) => s.workspace?.favorites ?? []);
  const recents = useWorkspace((s) => s.recents);
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const frequency = useSearch((s) => s.frequency);
  const encrypted = useVault((s) => !!s.status?.encrypted);
  const route = useRoute();

  // Capture (t / n / −12.50 …) and places load as their own chunk when the palette opens (useExtras.ts).
  const extras = useExtras();
  const capture = useMemo(() => (extras && !nested && scope === "all" ? extras.parseCapture(q) : null), [extras, q, nested, scope]);
  const hasLifeOs = lifeapps.some((a) => a.appId === "life-os" && !a.detached);
  const hasMoney = lifeapps.some((a) => a.appId === "money-hq" && !a.detached);
  const [moneyTarget, setMoneyTarget] = useState<MoneyTarget | null>(null);
  const [account, setAccount] = useState<{ id: Id; name: string } | null>(null);
  const wantsMoney = capture?.kind === "money";
  useEffect(() => {
    if (!wantsMoney || moneyTarget || !hasMoney || !extras) return;
    let live = true;
    void extras.loadMoneyTarget().then(async (t) => {
      if (!live || !t) return;
      setMoneyTarget(t);
      setAccount(await extras.captureAccount(t));
    });
    return () => {
      live = false;
    };
  }, [wantsMoney, moneyTarget, hasMoney, extras]);

  const wantContent = !nested && (scope === "all" || scope === "pages" || scope === "tags") && q.trim().length > 0;
  const content = useContentHits(q, wantContent, scope === "tags" ? ["database", "row"] : undefined);
  const quotes = useQuotes(q, !nested && scope === "quote");
  const calcState = useCalc(q, !nested && scope === "calc");

  const finish = useCallback(
    (fn: () => void | Promise<void>) => {
      restoreRef.current = null;
      // Input never waits on motion: the palette closes and the choice runs at once.
      onClose();
      // Let the panel start its exit before heavy navigation work.
      window.setTimeout(() => {
        Promise.resolve()
          .then(fn)
          .catch((e) => notify.fromError(e, "That didn’t work"));
      }, 0);
    },
    [onClose],
  );

  const openRoute = useCallback(
    (r: AppRoute, peek: boolean, id?: Id) => {
      if (id) useSearch.getState().recordOpen(id);
      if (q.trim()) useSearch.getState().addRecent(q.trim());
      finish(() => (peek ? useUi.getState().openPeek(r) : navigate(r)));
    },
    [finish, q],
  );

  // ── items

  const pageItem = useCallback(
    (meta: PageMeta, group: string, match?: { ranges: [number, number][] }, snippet?: SearchHit["snippet"], blockId?: string): Item => {
      const r = routeForPage(meta);
      const finalRoute: AppRoute = blockId && r.t === "page" ? { ...r, blockId } : r;
      return {
        id: `page:${meta.id}${blockId ? `:${blockId}` : ""}:${group}`,
        group,
        title: meta.title || "Untitled",
        ranges: match?.ranges,
        subtitle: pathOf(byId, meta) || undefined,
        snippet: snippet ?? undefined,
        icon: (
          <span className="cmdk-icon cmdk-icon-page" aria-hidden>
            <PageIcon icon={meta.icon} kind={meta.kind} size={18} />
          </span>
        ),
        hint: meta.kind === "database" ? "Database" : meta.kind === "sheet" ? "Sheet" : meta.kind === "app" || meta.kind === "dashboard" ? "App" : undefined,
        route: finalRoute,
        run: ({ peek }) => openRoute(finalRoute, peek, meta.id),
      };
    },
    [byId, openRoute],
  );

  const commandItem = useCallback(
    (c: AppCommand, group: string, ranges?: [number, number][]): Item => {
      const Icon = commandIcon(c.icon);
      return {
        id: `cmd:${c.id}:${group}`,
        group,
        title: c.title,
        ranges,
        icon: (
          <IconTile>
            <Icon size={16} strokeWidth={1.75} />
          </IconTile>
        ),
        shortcut: c.shortcut,
        run: () => finish(() => void runCommand(c.id)),
      };
    },
    [finish],
  );

  const nestedEntry = useCallback(
    (id: NestedId, group: string, ranges?: [number, number][]): Item => {
      const page = NESTED[id];
      const Icon = page.icon;
      return {
        id: `nest:${id}:${group}`,
        group,
        title: `${page.title}…`,
        ranges,
        icon: (
          <IconTile>
            <Icon size={16} strokeWidth={1.75} />
          </IconTile>
        ),
        hint: "→",
        stay: true,
        run: () => {
          setStack((s) => [...s, id]);
          setInput("");
        },
      };
    },
    [],
  );

  const now = Date.now();
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const query = q.trim();
    const livePages = Array.from(byId.values()).filter((p) => !p.deletedAt && !p.flags.template && !p.flags.inline);
    const rankPage = (p: PageMeta, match: number) => {
      const f = frequency[p.id] ?? 0;
      const freq = f > 0 ? Math.min(1, Math.log2(1 + f) / 4) : 0;
      return match * (1 + 0.3 * recency(p.updatedAt, now) + 0.2 * freq + 0.1 * (favorites.includes(p.id) ? 1 : 0));
    };
    const fuzzyPages = (limit: number, filter: (p: PageMeta) => boolean = () => true) => {
      const scored: { p: PageMeta; ranges: [number, number][]; s: number }[] = [];
      for (const p of livePages) {
        if (!filter(p)) continue;
        const r = fuzzy(query, p.title || "Untitled");
        // Very scattered matches on short queries are noise ("lis" → "Life OS").
        if (r && !(r.ranges.length > 1 && query.length <= 4 && r.match < 0.45)) scored.push({ p, ranges: r.ranges, s: rankPage(p, r.match) });
      }
      scored.sort((a, b) => b.s - a.s);
      return scored.slice(0, limit);
    };
    const contentHits = (shown: Set<string>, limit: number) =>
      content.hits
        .filter((h) => h.snippet && !shown.has(h.id) && byId.has(h.id))
        .slice(0, limit)
        .map((h) => pageItem(byId.get(h.id) as PageMeta, "In page content", undefined, h.snippet, h.blockId));

    // ── nested page (Theme →, Accent → …)
    if (nested) {
      for (const opt of nested.options()) {
        const r = query ? fuzzyAny(query, opt.title, opt.keywords) : { match: 1, ranges: [] as [number, number][] };
        if (!r) continue;
        out.push({
          id: `opt:${nested.id}:${opt.value}`,
          group: nested.title,
          title: opt.title,
          ranges: r.ranges,
          subtitle: opt.subtitle,
          icon: opt.icon,
          checked: opt.checked,
          preview: opt.preview,
          run: () => {
            const apply = opt.apply;
            restoreRef.current = null;
            const origin = listRef.current?.querySelector<HTMLElement>("[data-selected='true'] .cmdk-icon");
            finish(() => apply(origin ?? null));
          },
        });
      }
      return out;
    }

    switch (effectiveScope) {
      case "all": {
        if (!query) {
          const recentPages = recents.map((id) => byId.get(id)).filter((p): p is PageMeta => !!p && !p.deletedAt).slice(0, 5);
          for (const p of recentPages) out.push(pageItem(p, "Recent"));
          const onPage = route.t === "page" || route.t === "db" || route.t === "sheet";
          const suggested = [
            "page.new",
            "daily.today",
            onPage ? "page.copyLink" : null,
            onPage ? (favorites.includes((route as { id: Id }).id) ? "page.unfavorite" : "page.favorite") : null,
            encrypted ? "vault.lock" : "settings.security",
            "privacy.toggle",
            "import.open",
          ].filter((x): x is string => !!x);
          for (const id of suggested) {
            const c = commands.find((x) => x.id === id);
            if (c && isAvailable(c)) out.push(commandItem(c, "Suggested"));
          }
          out.push(nestedEntry("theme", "Suggested"));
          for (const [prefix, target, title, Icon] of MODES) {
            out.push({
              id: `mode:${target}`,
              group: "Modes",
              title,
              icon: (
                <IconTile>
                  <Icon size={16} strokeWidth={1.75} />
                </IconTile>
              ),
              hint: prefix,
              stay: true,
              run: () => {
                setScope(target);
                setInput("");
                inputRef.current?.focus();
              },
            });
          }
          for (const inst of lifeapps) {
            const idn = identity(inst.appId);
            const Icon = idn.icon;
            const root = byId.get(inst.rootPageId);
            const r: AppRoute = { t: "app", instanceId: inst.id };
            out.push({
              id: `app:${inst.id}`,
              group: "Life apps",
              title: root?.title || idn.name,
              icon: (
                <IconTile>
                  <Icon size={16} strokeWidth={1.75} />
                </IconTile>
              ),
              route: r,
              run: ({ peek }) => openRoute(r, peek),
            });
          }
          break;
        }
        // A capture prefix puts its row first; a page whose title starts the same way ("Task list") is the next row,
        // one ↓ away (Flow r2 §2.7: prefix grammar, capture row first, the page second).
        let captureRow: Item | null = null;
        if (capture && extras) {
          const d = extras.describeCapture(capture, { lifeOs: hasLifeOs, money: hasMoney, account: account?.name });
          const failed = capture.kind === "error";
          captureRow = {
            id: "capture:row",
            group: "Add",
            title: d.title,
            subtitle: d.meta.join(" · ") || (failed ? (capture.target === "money" ? "Type an amount, then who it was paid to" : undefined) : undefined),
            icon: (
              <IconTile>
                <Plus size={16} strokeWidth={1.75} />
              </IconTile>
            ),
            hint: failed ? undefined : capture.kind === "money" && moneyTarget && moneyTarget.accounts.length > 1 ? "Tab: account" : "Add",
            stay: failed && !(capture.target === "money" && hasMoney),
            run: () => {
              if (capture.kind !== "error") return finish(() => void extras.runCapture(capture, account?.id));
              // A money line that can't be read opens Money HQ's transactions, where the full form lives.
              const money = lifeapps.find((a) => a.appId === "money-hq" && !a.detached);
              if (capture.target === "money" && money) finish(() => navigate({ t: "app", instanceId: money.id, tab: "transactions" }));
            },
          };
        }
        const lower = query.toLowerCase();
        if (captureRow) out.push(captureRow);
        // Groups are ordered by their best match so an exact command or setting beats a weak content hit.
        const groupsOut: { score: number; items: Item[] }[] = [];
        const places = (extras?.placesFor(lifeapps, (inst) => byId.get(inst.rootPageId)?.title) ?? [])
          .map((pl) => ({ pl, r: fuzzyAny(query, pl.title, pl.keywords) ?? fuzzyAny(query, `${pl.app} ${pl.title}`) }))
          .filter((x): x is { pl: Place; r: NonNullable<typeof x.r> } => !!x.r && x.r.match > 0.4 && !scatteredHit(x.r, x.pl.title))
          .sort((a, b) => b.r.match - a.r.match)
          .slice(0, 5);
        groupsOut.push({
          // An exact place name ("Estimator", "Accounts") goes to the hub tab ahead of a page with the same title.
          score: (places[0]?.r.match ?? 0) >= 0.95 ? 1.7 : (places[0]?.r.match ?? 0) * 1.06,
          items: places.map(({ pl, r }) => {
            const Icon = identity(pl.appId).icon;
            return {
              id: `place:${pl.id}`,
              group: "Places",
              title: pl.title,
              ranges: r.ranges,
              subtitle: pl.app,
              icon: (
                <IconTile>
                  <Icon size={16} strokeWidth={1.75} />
                </IconTile>
              ),
              route: pl.route,
              run: ({ peek }: { peek: boolean }) => openRoute(pl.route, peek),
            } satisfies Item;
          }),
        });
        const pages = fuzzyPages(7);
        const shown = new Set(pages.map((x) => x.p.id));
        groupsOut.push({ score: (pages[0]?.s ?? 0) * 1.02, items: pages.map(({ p, ranges }) => pageItem(p, "Pages", { ranges })) });
        groupsOut.push({ score: 0.55, items: contentHits(shown, 4) });
        const cmdMatches = commands
          .filter((c) => !c.hidden && isAvailable(c))
          .map((c) => ({ c, r: fuzzyAny(query, c.title, c.keywords) }))
          .filter((x): x is { c: AppCommand; r: NonNullable<typeof x.r> } => !!x.r && x.r.match > 0.25 && !scatteredHit(x.r, x.c.title))
          .sort((a, b) => b.r.match - a.r.match)
          .slice(0, 5);
        const cmdItems = cmdMatches.map(({ c, r }) => commandItem(c, "Commands", r.ranges));
        let cmdTop = cmdMatches[0]?.r.match ?? 0;
        for (const id of Object.keys(NESTED) as NestedId[]) {
          const r = fuzzyAny(query, NESTED[id].title, NESTED[id].keywords);
          if (r && r.match > 0.35 && !scatteredHit(r, NESTED[id].title)) {
            cmdItems.push(nestedEntry(id, "Commands", r.ranges));
            cmdTop = Math.max(cmdTop, r.match);
          }
        }
        // A verb whose title starts with what was typed ("check in" → Check in habits) beats a place that only
        // partly matches, and even an exactly named place (1.7).
        const words = (t: string) => t.toLowerCase().replace(/[-‐]/g, " ");
        const verbFirst = lower.length >= 3 && cmdMatches.some(({ c }) => words(c.title).startsWith(words(lower)));
        groupsOut.push({ score: verbFirst ? 1.72 : cmdTop * 0.95, items: cmdItems });
        const settings = [
          ...SECTIONS.map((s) => ({ key: s.id, title: s.title, path: "Settings", kw: s.keywords, icon: s.icon, section: s.id as string })),
          ...SETTING_ENTRIES.map((e) => ({ key: e.id, title: e.title, path: `Settings / ${SECTIONS.find((s) => s.id === e.section)?.title ?? ""}`, kw: e.keywords ?? [], icon: SECTIONS.find((s) => s.id === e.section)?.icon, section: `${e.section}:${e.id}` })),
        ]
          .map((s) => ({ s, r: fuzzyAny(query, s.title, s.kw) }))
          .filter((x) => x.r && x.r.match > 0.4)
          .sort((a, b) => (b.r?.match ?? 0) - (a.r?.match ?? 0))
          .slice(0, 3);
        groupsOut.push({
          score: (settings[0]?.r?.match ?? 0) * 0.9,
          items: settings.map(({ s, r }) => {
            const Icon = s.icon ?? Settings;
            const rt: AppRoute = { t: "settings", section: s.section };
            return {
              id: `set:${s.key}`,
              group: "Settings",
              title: s.title,
              ranges: r?.ranges,
              subtitle: s.path,
              icon: (
                <IconTile>
                  <Icon size={16} strokeWidth={1.75} />
                </IconTile>
              ),
              route: rt,
              run: ({ peek }: { peek: boolean }) => openRoute(rt, peek),
            } satisfies Item;
          }),
        });
        for (const g of groupsOut.filter((x) => x.items.length).sort((a, b) => b.score - a.score)) out.push(...g.items);
        out.push({
          id: "create:page",
          group: "Create",
          title: `Create page “${query}”`,
          icon: (
            <IconTile>
              <FilePlus size={16} strokeWidth={1.75} />
            </IconTile>
          ),
          hint: "New",
          run: () =>
            finish(async () => {
              const meta = await useTree.getState().createPage({ parentId: null, title: query.slice(0, 200) });
              navigate({ t: "page", id: meta.id });
            }),
        });
        break;
      }
      case "pages": {
        if (!query) {
          const seen = new Set<string>();
          const list = [...recents.map((id) => byId.get(id)), ...livePages.sort((a, b) => b.updatedAt - a.updatedAt)].filter((p): p is PageMeta => !!p && !p.deletedAt && !p.flags.template && !seen.has(p.id) && (seen.add(p.id), true));
          for (const p of list.slice(0, 12)) out.push(pageItem(p, "Recently opened"));
          break;
        }
        const pages = fuzzyPages(12);
        const shown = new Set(pages.map((x) => x.p.id));
        for (const { p, ranges } of pages) out.push(pageItem(p, "Pages", { ranges }));
        out.push(...contentHits(shown, 8));
        break;
      }
      case "commands": {
        const avail = commands.filter((c) => !c.hidden && isAvailable(c));
        const nestedIds = Object.keys(NESTED) as NestedId[];
        if (!query) {
          for (const id of nestedIds) out.push(nestedEntry(id, "Preferences"));
          const sections = new Map<string, AppCommand[]>();
          for (const c of avail) sections.set(c.section, [...(sections.get(c.section) ?? []), c]);
          for (const [section, list] of sections) for (const c of list) out.push(commandItem(c, section));
          break;
        }
        const scored = [
          ...avail.map((c) => ({ kind: "c" as const, c, r: fuzzyAny(query, c.title, c.keywords) })),
          ...nestedIds.map((id) => ({ kind: "n" as const, id, r: fuzzyAny(query, NESTED[id].title, NESTED[id].keywords) })),
        ]
          .filter((x) => !!x.r)
          .sort((a, b) => (b.r?.match ?? 0) - (a.r?.match ?? 0));
        for (const x of scored) out.push(x.kind === "c" ? commandItem(x.c, "Commands", x.r?.ranges) : nestedEntry(x.id, "Commands", x.r?.ranges));
        break;
      }
      case "tags": {
        const dbs = livePages.filter((p) => p.kind === "database");
        const scored = dbs
          .map((p) => ({ p, r: query ? fuzzy(query, p.title || "Untitled") : { match: 1, ranges: [] as [number, number][] } }))
          .filter((x) => !!x.r)
          .sort((a, b) => (b.r?.match ?? 0) - (a.r?.match ?? 0) || b.p.updatedAt - a.p.updatedAt)
          .slice(0, query ? 8 : 12);
        for (const { p, r } of scored) out.push(pageItem(p, "Databases", { ranges: r?.ranges ?? [] }));
        for (const h of content.hits.filter((h) => h.kind === "row").slice(0, 10)) {
          const r: AppRoute = { t: "row", id: h.id };
          const match = fuzzy(query, h.title);
          out.push({
            id: `row:${h.id}`,
            group: "Rows",
            title: h.title || "Untitled",
            ranges: match?.ranges,
            subtitle: h.path.join(" / ") || undefined,
            snippet: h.snippet,
            icon: (
              <span className="cmdk-icon cmdk-icon-page" aria-hidden>
                <PageIcon icon={h.icon} kind="doc" size={18} />
              </span>
            ),
            hint: "Row",
            route: r,
            run: ({ peek }) => openRoute(r, peek),
          });
        }
        break;
      }
      case "dates": {
        const base = new Date();
        const picks: { label: string; date: Date }[] = [];
        if (query) {
          const d = parseDate(query, base, { forwardDate: true });
          if (d) picks.push({ label: query, date: d });
        }
        if (!query || !picks.length) {
          const add = (n: number, label: string) => picks.push({ label, date: new Date(base.getTime() + n * DAY) });
          add(0, "Today");
          add(1, "Tomorrow");
          add(-1, "Yesterday");
          const nextMon = (8 - base.getDay()) % 7 || 7;
          add(nextMon, "Next Monday");
        }
        for (const { label, date } of picks) {
          const day = isoDay(date);
          const pretty = formatDate(date, "full");
          out.push({
            id: `date:note:${day}:${label}`,
            group: query ? "Date" : "Jump to a day",
            title: `Daily note · ${pretty}`,
            subtitle: label !== pretty ? label : undefined,
            icon: (
              <IconTile>
                <CalendarDays size={16} strokeWidth={1.75} />
              </IconTile>
            ),
            run: ({ peek }) =>
              finish(async () => {
                const meta = day === isoDay() ? null : await api.daily.noteOpen({ date: day });
                if (!meta) return void (await openTodayNote());
                useTree.getState().upsert([meta]);
                if (peek) useUi.getState().openPeek({ t: "page", id: meta.id });
                else navigate({ t: "page", id: meta.id });
              }),
          });
        }
        if (picks[0]) {
          out.push({
            id: "date:calendar",
            group: query ? "Date" : "Jump to a day",
            title: "Open the calendar",
            subtitle: formatDate(picks[0].date, "full"),
            icon: (
              <IconTile>
                <ArrowRight size={16} strokeWidth={1.75} />
              </IconTile>
            ),
            run: () => finish(() => navigate({ t: "calendar" })),
          });
        }
        break;
      }
      case "quote": {
        for (const row of quotes ?? []) {
          const r: AppRoute = { t: "markets", symbol: row.symbol };
          const ticker = row.symbol.split(":")[0];
          out.push({
            id: `q:${row.symbol}`,
            group: "Quotes",
            title: ticker,
            subtitle: `${row.name} · ${row.exchange}`,
            icon: (
              <IconTile>
                <LineChart size={16} strokeWidth={1.75} />
              </IconTile>
            ),
            route: r,
            render: (
              <span className="cmdk-quote">
                {row.spark && row.spark.length > 1 ? (
                  <span className="cmdk-spark">
                    <Sparkline data={row.spark} width={64} height={20} endDot={false} area={false} />
                  </span>
                ) : (
                  <span className="cmdk-spark" />
                )}
                <span className="cmdk-price tabular" data-sensitive="">
                  {row.quote ? formatCurrency(row.quote.price, row.quote.currency) : "—"}
                </span>
                {row.quote ? <span className={cn("cmdk-delta tabular", row.quote.changePct < 0 ? "text-loss-text" : "text-gain-text")}>{`${row.quote.changePct < 0 ? "−" : "+"}${Math.abs(row.quote.changePct * 100).toFixed(2)}%`}</span> : null}
              </span>
            ),
            run: ({ peek }) => openRoute(r, peek),
          });
        }
        break;
      }
      case "calc": {
        const res = calcState.result;
        if (res) {
          out.push({
            id: "calc:result",
            group: "Result",
            title: res.display,
            subtitle: res.detail,
            icon: null,
            render: (
              <span className="cmdk-calc">
                <CalcValue display={res.display} />
                <span className="cmdk-calc-detail">{res.detail}</span>
              </span>
            ),
            run: () =>
              finish(async () => {
                if (!res.copy) return;
                await navigator.clipboard.writeText(res.copy);
                notify.success("Copied", { description: res.copy });
              }),
          });
        }
        break;
      }
      case "shortcuts": {
        const list = SHORTCUTS.filter((s) => s.id !== "region.prev")
          .map((s) => ({ s, r: query ? fuzzyAny(query, s.description, [s.scope]) : { match: 1, ranges: [] as [number, number][] } }))
          .filter((x) => !!x.r)
          .sort((a, b) => (query ? (b.r?.match ?? 0) - (a.r?.match ?? 0) : 0));
        const label: Record<ShortcutDef["scope"], string> = { app: "App", formatting: "Formatting", blocks: "Blocks", database: "Database", sheets: "Sheets" };
        for (const { s, r } of list) {
          const keys = Array.isArray(s.keys) ? s.keys[0] : s.keys;
          const runnable = s.scope === "app";
          out.push({
            id: `sc:${s.id}`,
            group: query ? "Shortcuts" : label[s.scope],
            title: s.description,
            ranges: r?.ranges,
            icon: (
              <IconTile>
                <Keyboard size={16} strokeWidth={1.75} />
              </IconTile>
            ),
            shortcut: keys,
            hint: runnable ? undefined : label[s.scope],
            run: () => (runnable ? finish(() => void runCommand(s.command ?? s.id)) : undefined),
          });
        }
        break;
      }
    }
    return out;
    // `now` is captured per render on purpose; ranking only needs minute precision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, effectiveScope, nested, byId, recents, favorites, frequency, commands, lifeapps, content.hits, quotes, calcState.result, encrypted, route, pageItem, commandItem, nestedEntry, openRoute, finish, capture, hasLifeOs, hasMoney, account, moneyTarget, extras]);

  // A new query (or scope / nested level) always selects the first result, so ↵ runs the best match. Otherwise
  // (async content hits arriving, live updates) keep the current selection while it is still listed.
  const firstId = items[0]?.id ?? "";
  const queryKey = `${effectiveScope}\u0000${nested?.title ?? ""}\u0000${q}`;
  const lastQueryKey = useRef(queryKey);
  /** The user moved the selection (arrows / pointer) since the query last changed. */
  const picked = useRef(false);
  useEffect(() => {
    if (lastQueryKey.current !== queryKey) picked.current = false;
    lastQueryKey.current = queryKey;
    setValue((cur) => (picked.current && items.some((i) => i.id === cur) ? cur : firstId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, items.length, queryKey]);

  const selected = items.find((i) => i.id === value);

  // Preload the highlighted route's chunk; live-preview nested options.
  useEffect(() => {
    if (selected?.route) preloadRoute(selected.route);
    if (selected?.preview) selected.preview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Snapshot what nested previews might change so Esc / close restores it.
  useEffect(() => {
    if (!nested) return;
    const root = document.documentElement;
    const before = { theme: root.getAttribute("data-theme"), accent: root.getAttribute("data-accent"), density: root.getAttribute("data-density") };
    restoreRef.current = () => {
      if (before.theme) root.setAttribute("data-theme", before.theme);
      if (before.accent) root.setAttribute("data-accent", before.accent);
      if (before.density) root.setAttribute("data-density", before.density);
    };
    return () => {
      restoreRef.current?.();
      restoreRef.current = null;
    };
  }, [nested]);

  const popLevel = (): boolean => {
    if (stack.length) {
      setStack((s) => s.slice(0, -1));
      setInput("");
      return true;
    }
    if (scope !== "all" && scope !== initialScope) {
      setScope("all");
      return true;
    }
    if (scope !== "all" && initialScope !== "all" && !input) {
      setScope("all");
      return true;
    }
    return false;
  };

  escRef.current = () => (stack.length || (scope !== "all" && scope !== initialScope) ? popLevel() : false);

  const onInput = (v: string) => {
    if (!nested && scope === "all" && v.length >= 1 && PREFIX[v.charAt(0)]) {
      setScope(PREFIX[v.charAt(0)]);
      setInput(v.slice(1).trimStart());
      return;
    }
    setInput(v);
  };

  // The rows render from a deferred copy of the results: the palette's opening frame paints just the panel and the
  // input (the rows rise in on the next, interruptible render, inside the S7 grow), and fast typing never blocks
  // the input on rendering a list that is about to be replaced.
  const listItems = useDeferredValue(items);
  const listPending = listItems !== items;
  const groups = useMemo(() => {
    const g: { name: string; items: Item[] }[] = [];
    for (const it of listItems) {
      const last = g[g.length - 1];
      if (last && last.name === it.group) last.items.push(it);
      else g.push({ name: it.group, items: [it] });
    }
    return g;
  }, [listItems]);

  const chip = nested ? nested.title : SCOPE_LABEL[effectiveScope];
  const loading = (wantContent && content.loading) || (scope === "quote" && !!q.trim() && quotes === null) || (scope === "calc" && calcState.pending);
  const enterLabel = effectiveScope === "calc" ? "Copy" : nested ? "Apply" : selected?.id === "capture:row" ? "Add" : selected?.stay ? "Open" : selected?.route ? "Open" : "Run";

  return (
    <Command
      label="Command palette"
      shouldFilter={false}
      loop
      value={value}
      onValueChange={setValue}
      className="cmdk-root"
      onPointerMove={(e) => {
        if ((e.target as Element).closest(".cmdk-item")) picked.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End" || e.key === "PageDown" || e.key === "PageUp" || (e.ctrlKey && (e.key === "j" || e.key === "k" || e.key === "n" || e.key === "p"))) picked.current = true;
        if (e.key === "Tab" && !e.shiftKey && capture?.kind === "money" && moneyTarget && moneyTarget.accounts.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          const i = moneyTarget.accounts.findIndex((a) => a.id === account?.id);
          setAccount(moneyTarget.accounts[(i + 1) % moneyTarget.accounts.length]);
          return;
        }
        if (e.key === "Enter" && e.shiftKey && selected?.route) {
          e.preventDefault();
          void selected.run({ peek: true });
          return;
        }
        if (e.key === "Backspace" && !input && (stack.length || scope !== "all")) {
          e.preventDefault();
          if (!popLevel()) setScope("all");
        }
      }}
    >
      <div className="cmdk-input-row">
        {nested || scope !== initialScope ? (
          <button type="button" className="cmdk-back" aria-label="Back" onClick={() => (popLevel() || setScope("all"), inputRef.current?.focus())}>
            <ChevronLeft size={18} aria-hidden />
          </button>
        ) : (
          <Search size={20} className="cmdk-search-icon" aria-hidden />
        )}
        {chip ? <span className="cmdk-chip">{chip}</span> : null}
        <Command.Input
          ref={inputRef}
          value={input}
          onValueChange={onInput}
          placeholder={nested ? nested.placeholder : PLACEHOLDER[scope]}
          className="cmdk-input"
          autoComplete="off"
          spellCheck={false}
        />
        {loading ? <Spinner size={14} className="cmdk-spinner" label="Searching" /> : null}
        {!content.ready && wantContent ? <span className="cmdk-indexing">Indexing…</span> : null}
      </div>
      <Command.List ref={listRef} className="cmdk-list">
        {!items.length && !loading && !listPending ? <EmptyResults scope={effectiveScope} query={q} /> : null}
        {groups.map((g) => (
          <Command.Group key={g.name} heading={g.name}>
            {g.items.map((it) => (
              <Command.Item
                key={it.id}
                value={it.id}
                onSelect={() => void it.run({ peek: false })}
                className={cn("cmdk-item", (it.subtitle || it.snippet) && !it.render && "has-sub", it.render && effectiveScope === "calc" && "is-calc")}
              >
                {it.icon}
                {effectiveScope === "calc" && it.render ? (
                  it.render
                ) : (
                  <span className="cmdk-text">
                    <span className="cmdk-title">
                      <Highlight text={it.title} ranges={it.ranges} />
                    </span>
                    {it.snippet ? (
                      <span className="cmdk-snippet">
                        <Highlight text={it.snippet.text} ranges={it.snippet.ranges} />
                      </span>
                    ) : it.subtitle ? (
                      <span className="cmdk-sub">{it.subtitle}</span>
                    ) : null}
                  </span>
                )}
                {effectiveScope !== "calc" && it.render ? it.render : null}
                <span className="cmdk-trail">
                  {it.checked ? <Check size={14} className="cmdk-check" aria-label="Current" /> : null}
                  {it.hint === "→" ? <ArrowRight size={14} className="cmdk-arrow" aria-hidden /> : it.hint && it.id.startsWith("mode:") ? <kbd className="cmdk-prefix-key">{it.hint}</kbd> : it.hint ? <span className="cmdk-hint">{it.hint}</span> : null}
                  {it.shortcut ? <Kbd keys={it.shortcut} size="xs" /> : null}
                  <span className="cmdk-enter" aria-hidden>
                    <CornerDownLeft size={12} />
                  </span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="cmdk-footer" aria-hidden>
        <span>
          <Kbd size="xs">↑</Kbd>
          <Kbd size="xs">↓</Kbd> Navigate
        </span>
        <span>
          <Kbd size="xs">↵</Kbd> {enterLabel}
        </span>
        {selected?.route ? (
          <span>
            <Kbd keys="shift+enter" size="xs" /> Open in side peek
          </span>
        ) : null}
        <span className="cmdk-footer-end">
          {scope === "all" && !nested ? (
            <span className="cmdk-prefixes" title="> commands · # databases · @ dates · $ quotes · = calculator · ? shortcuts">
              Modes
              {Object.keys(PREFIX).map((p) => (
                <Kbd key={p} size="xs" className="cmdk-prefix-key">
                  {p}
                </Kbd>
              ))}
            </span>
          ) : (
            <span>
              <Kbd keys="escape" size="xs" /> {nested || scope !== initialScope ? "Back" : "Close"}
            </span>
          )}
        </span>
      </div>
    </Command>
  );
}

function EmptyResults({ scope, query }: { scope: Scope; query: string }) {
  const q = query.trim();
  let icon = <FileSearch size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
  let title = q ? `No results for “${q}”` : "Nothing here yet";
  let body = "Try fewer words, or search inside pages with ⌘P.";
  if (scope === "calc") {
    icon = <Calculator size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
    title = q ? "That doesn’t compute" : "Type a calculation";
    body = "Arithmetic, percentages, units (5 km in mi) and currency (120 usd in eur).";
  } else if (scope === "quote") {
    icon = <LineChart size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
    title = q ? `No symbol matches “${q}”` : "Look up a quote";
    body = "Type a ticker or company name.";
  } else if (scope === "tags") {
    icon = <Database size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
    body = "Databases and their rows appear here.";
  } else if (scope === "dates") {
    icon = <CalendarDays size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
    title = "Couldn’t read that date";
    body = "Try “friday”, “in 3 days” or “2026-12-24”.";
  } else if (scope === "commands") {
    icon = <Hash size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
    body = "Commands depend on where you are. Open a page for page actions.";
  } else if (scope === "pages") {
    icon = <TextSearch size={24} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />;
  }
  return (
    <div className="cmdk-empty" role="status">
      <span className="cmdk-empty-icon">{icon}</span>
      <p className="cmdk-empty-title">{title}</p>
      <p className="cmdk-empty-body">{body}</p>
    </div>
  );
}


/** The calculator's big figure rolls its digits as the expression changes (S7); non-numeric results just swap. */
function CalcValue({ display }: { display: string }) {
  const m = /^(-?)([\d,]*\.?\d+)(.*)$/.exec(display);
  if (!m) return <span className="cmdk-calc-value tabular">{display}</span>;
  const [, sign, num, rest] = m;
  const frac = num.includes(".") ? num.split(".")[1].length : 0;
  const grouped = num.includes(",");
  const value = Number(`${sign}${num.replace(/,/g, "")}`);
  if (!Number.isFinite(value)) return <span className="cmdk-calc-value tabular">{display}</span>;
  const format = (n: number) =>
    `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac, useGrouping: grouped })}${rest}`;
  return <span className="cmdk-calc-value tabular">{format(value)}</span>;
}
