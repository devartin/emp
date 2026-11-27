/**
 * Home for a new workspace (1.0 brief §2.5–§2.6):
 *
 *   RecoveryReminder  an encrypted workspace whose recovery key was never recorded as saved
 *   StartHere         New document · New spreadsheet · New project · Add an app · Import. Hide it, or it retires by
 *                     itself once the workspace has a few pages of its own
 *   SetupProgress     the apps picked in first run, building in the background with real progress
 *   GettingStarted    a short checklist of things this workspace can do; each item ticks itself when done, and the
 *                     list can be hidden. Its state lives in the workspace (kv ui.home, ui.gettingStarted). It is the
 *                     same list as the Getting Started page (crates/emp-store/src/repo/tour.rs ITEMS): a to-do ticked
 *                     by hand on that page counts here too
 */
import { AlertTriangle, Check, FilePlus2, FolderPlus, KeyRound, LayoutGrid, RefreshCw, Sheet, Upload, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, listen } from "@/backend";
import type { PageMeta } from "@/backend/types";
import { createPageAndOpen, createProjectAndOpen, createSheetAndOpen, openPaletteHeld, runCommand } from "@/app/commands";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { shortcutLabel } from "@/lib/platform";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { appName } from "@/features/lifeapps/identity";
import { retrySetup, useSetup } from "@/features/vault/Onboarding/setup";
import { RecoveryKeyDialog } from "@/features/vault/RecoveryKeyDialog";
import { CHECK_KEYS, tickedOnPage, type CheckKey } from "./checklist";

const HOME_NS = "ui.home" as const;
/** Start here retires once the workspace has this many pages of its own (not the tour, not app pages). */
export const START_HERE_RETIRE_AT = 3;

// ───────────────────────────────────────────────────────────────────────────── state

export interface FirstRunState {
  /** First run finished in this workspace (Start here and the checklist are for new workspaces only). */
  isNew: boolean;
  startHere: "show" | "hidden" | "retired";
  checklist: "show" | "hidden" | "done";
  /** Getting Started items done (`ui.gettingStarted/<key>`). */
  done: Record<string, boolean>;
}

/** Loads the first-run state; reloads when the palette or the import dialog closes and when data changes. */
export function useFirstRun(): [FirstRunState | null, (patch: { startHere?: FirstRunState["startHere"]; checklist?: FirstRunState["checklist"] }) => void] {
  const [state, setState] = useState<FirstRunState | null>(null);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const importOpen = useUi((s) => s.importOpen);
  const load = useCallback(() => {
    Promise.all([
      api.kv.get({ ns: "ui.onboarding", key: "completedAt" }),
      api.kv.getMany({ ns: HOME_NS, keys: ["startHere", "checklist"] }),
      api.kv.getMany({ ns: "ui.gettingStarted", keys: [...CHECK_KEYS, "tour"] }),
    ])
      .then(async ([completed, home, got]) => {
        const onPage = await tickedOnPage(got.tour ?? null);
        setState({
          isNew: !!completed,
          startHere: home.startHere === "hidden" || home.startHere === "retired" ? home.startHere : "show",
          checklist: home.checklist === "hidden" || home.checklist === "done" ? home.checklist : "show",
          done: Object.fromEntries(CHECK_KEYS.map((k) => [k, !!got[k] || onPage.has(k)])),
        });
      })
      .catch(() => setState({ isNew: false, startHere: "hidden", checklist: "hidden", done: {} }));
  }, []);
  useEffect(() => {
    if (!paletteOpen && !importOpen) load();
  }, [load, paletteOpen, importOpen]);
  useEffect(() => {
    const offs = [listen("db:changed", () => load()), listen("page:changed", () => load())];
    window.addEventListener("emp:captured", load);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("emp:captured", load);
    };
  }, [load]);
  const set = useCallback((patch: { startHere?: FirstRunState["startHere"]; checklist?: FirstRunState["checklist"] }) => {
    setState((s) => (s ? { ...s, ...patch } : s));
    for (const [key, value] of Object.entries(patch)) void api.kv.set({ ns: HOME_NS, key, value }).catch(() => undefined);
  }, []);
  return [state, set];
}

/** The root page both backends file today's notes under (`daily_note_open`). */
const JOURNAL = "Journal";

/**
 * Pages the person made: not the Getting Started tour, not app pages, not templates, and not the Journal or its
 * daily notes (one click on "Today's note", or a capture without Tasks, makes both by itself).
 */
export function useOwnPageCount(): number {
  return useTree(
    useShallow((s) => {
      const root = (p: PageMeta): PageMeta => {
        let cur: PageMeta = p;
        for (let i = 0; cur.parentId && i < 32; i++) {
          const up = s.byId.get(cur.parentId);
          if (!up) break;
          cur = up;
        }
        return cur;
      };
      let n = 0;
      for (const p of s.byId.values()) {
        if (p.deletedAt || p.appInstanceId || p.flags.template || p.flags.inline) continue;
        if (p.kind !== "doc" && p.kind !== "sheet" && p.kind !== "database") continue;
        const top = root(p);
        if (!top.parentId && top.title === "Getting Started") continue;
        if (!p.parentId && p.title === JOURNAL) continue;
        if (p.parentId && s.byId.get(p.parentId)?.title === JOURNAL && !s.byId.get(p.parentId)?.parentId) continue;
        n++;
      }
      return n;
    }),
  );
}

// ───────────────────────────────────────────────────────────────────────────── pieces

function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="hm-section-head">
      <h2 className="hm-section-title">{title}</h2>
      {children}
    </div>
  );
}

/** A section that enters with a short fade and leaves the same way (160 ms; instant under reduced motion). */
function Fade({ id, children }: { id: string; children: ReactNode }) {
  const reduced = useReducedMotionPref();
  return (
    <m.div
      key={id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: reduced ? 0 : 0.16 } }}
      exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.12 } }}
    >
      {children}
    </m.div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── recovery reminder

export function RecoveryReminder() {
  const needed = useVault((s) => !!s.status?.encrypted && s.status.state === "unlocked" && !s.status.recoveryConfirmed);
  const [open, setOpen] = useState(false);
  if (!needed && !open) return null;
  return (
    <>
      {needed ? (
        <div className="hm-reminder" role="note">
          <KeyRound size={16} className="hm-reminder-icon" aria-hidden />
          <p className="hm-reminder-text">
            <strong>Save your recovery key.</strong> If you forget your password, it's the only way back in.
          </p>
          <Button size="sm" onClick={() => setOpen(true)}>
            Save it now
          </Button>
        </div>
      ) : null}
      <RecoveryKeyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────── start here

interface StartAction {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void | Promise<void>;
}

const fail = (title: string) => (e: unknown) => void notify.fromError(e, title);

const START_ACTIONS: StartAction[] = [
  { key: "doc", label: "New document", icon: FilePlus2, run: () => createPageAndOpen(null).catch(fail("Couldn't create the document")) },
  { key: "sheet", label: "New spreadsheet", icon: Sheet, run: () => createSheetAndOpen(null).catch(fail("Couldn't create the spreadsheet")) },
  { key: "project", label: "New project", icon: FolderPlus, run: () => createProjectAndOpen(null).catch(fail("Couldn't create the project")) },
  { key: "app", label: "Add an app", icon: LayoutGrid, run: () => navigate({ t: "lifeapps" }) },
  { key: "import", label: "Import", icon: Upload, run: () => useUi.getState().setImportOpen(true) },
];

export function StartHere({ state, set }: { state: FirstRunState; set: ReturnType<typeof useFirstRun>[1] }) {
  const own = useOwnPageCount();
  const retire = state.isNew && state.startHere === "show" && own >= START_HERE_RETIRE_AT;
  useEffect(() => {
    if (retire) set({ startHere: "retired" });
  }, [retire, set]);
  const show = state.isNew && state.startHere === "show" && !retire;
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <Fade id="start">
          <section className="hm-section hm-start" aria-label="Start here">
            <Head title="Start here">
              <IconButton size="xs" label="Hide these shortcuts" icon={<X size={14} aria-hidden />} onClick={() => set({ startHere: "hidden" })} />
            </Head>
            <div className="hm-start-grid">
              {START_ACTIONS.map((a) => (
                <button key={a.key} type="button" data-home-item="" className="hm-start-tile" onClick={() => void a.run()}>
                  <a.icon size={18} strokeWidth={1.5} aria-hidden />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          </section>
        </Fade>
      ) : null}
    </AnimatePresence>
  );
}

// ───────────────────────────────────────────────────────────────────────────── setup progress

export function SetupProgress() {
  const { rows, active, running, dismiss } = useSetup(useShallow((s) => ({ rows: s.rows, active: s.active, running: s.running, dismiss: s.dismiss })));
  const apps = useWorkspace((s) => s.lifeapps);
  const reduced = useReducedMotionPref();
  if (!active || !rows.length) return null;
  const finished = rows.filter((r) => r.state === "done").length;
  const failed = rows.some((r) => r.state === "error");
  const allDone = finished === rows.length;
  return (
    <section className="hm-section hm-setup" aria-label="Setting up your apps" aria-busy={running || undefined}>
      <Head title={allDone ? "Your apps are ready" : "Setting up your apps"}>
        {allDone || (failed && !running) ? <IconButton size="xs" label="Hide" icon={<X size={14} aria-hidden />} onClick={dismiss} /> : <span className="hm-row-meta tabular">{finished} of {rows.length}</span>}
      </Head>
      <ul className="hm-list">
        {rows.map((r) => {
          const inst = r.instanceId ?? apps.find((a) => a.appId === r.appId && !a.detached)?.id;
          return (
            <li key={r.appId} className="hm-setup-row" data-state={r.state}>
              <span className="hm-setup-mark" aria-hidden>
                {r.state === "done" ? <Check size={14} strokeWidth={2} /> : r.state === "error" ? <AlertTriangle size={14} /> : null}
              </span>
              <span className="hm-row-title">{appName(r.appId)}</span>
              {r.state === "running" || r.state === "pending" ? (
                <span className="hm-setup-bar" role="progressbar" aria-label={`Setting up ${appName(r.appId)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.progress * 100)}>
                  <m.i initial={false} animate={{ scaleX: r.state === "pending" ? 0 : r.progress }} transition={{ duration: reduced ? 0 : 0.2, ease: [0.2, 0, 0, 1] }} />
                </span>
              ) : null}
              {r.state === "done" && inst ? (
                <button type="button" data-home-item="" className="hm-quiet-link" onClick={() => navigate({ t: "app", instanceId: inst })}>
                  Open
                </button>
              ) : null}
              {r.state === "error" ? <span className="hm-row-meta is-late">{r.error ?? "Couldn't set it up"}</span> : null}
            </li>
          );
        })}
      </ul>
      {failed && !running ? (
        <div className="mt-2">
          <Button size="sm" icon={RefreshCw} onClick={() => void retrySetup()}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────── getting started

interface CheckItem {
  key: CheckKey;
  label: string;
  run: () => void;
}

/** The same items, in the same order, as the Getting Started page (repo/tour.rs ITEMS, then LOCK_ITEM). */
function useChecklistItems(): CheckItem[] {
  const encrypted = useVault((s) => !!s.status?.encrypted);
  return useMemo(() => {
    const list: CheckItem[] = [
      { key: "create_page", label: "Write a document", run: () => void createPageAndOpen(null).catch(fail("Couldn't create the document")) },
      { key: "try_slash", label: "Add a heading, list or table: type / in a document", run: () => void createPageAndOpen(null).catch(fail("Couldn't create the document")) },
      { key: "capture", label: "Add a task or a note in the field above", run: () => document.querySelector<HTMLInputElement>(".hm-capture-input")?.focus() },
      { key: "open_palette", label: `Find anything with ${shortcutLabel("mod+k")}`, run: () => openPaletteHeld("all") },
    ];
    if (encrypted) list.push({ key: "lock", label: `Lock Ultranote with ${shortcutLabel("mod+shift+l")} when you step away`, run: () => void runCommand("vault.lock") });
    return list;
  }, [encrypted]);
}

export function GettingStarted({ state, set }: { state: FirstRunState; set: ReturnType<typeof useFirstRun>[1] }) {
  const items = useChecklistItems();
  const count = items.filter((i) => state.done[i.key]).length;
  const complete = count === items.length;
  // Finishing the list retires it (from the next visit); this visit shows the last tick.
  const [shownComplete] = useState(complete);
  useEffect(() => {
    if (complete && state.isNew && state.checklist === "show") set({ checklist: "done" });
  }, [complete, state.isNew, state.checklist, set]);
  const show = state.isNew && (state.checklist === "show" || (state.checklist === "done" && !shownComplete));
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <Fade id="checklist">
          <section className="hm-section hm-checklist" aria-label="Getting started">
            <Head title="Getting started">
              <span className="hm-row-meta tabular" aria-label={`${count} of ${items.length} done`}>
                {complete ? "All done" : `${count} of ${items.length}`}
              </span>
              <button type="button" className="hm-quiet-link" onClick={() => set({ checklist: "hidden" })}>
                Hide
              </button>
            </Head>
            <ul className="hm-list">
              {items.map((i) => {
                const done = !!state.done[i.key];
                return (
                  <li key={i.key} className={cn("hm-row hm-check", done && "is-done")}>
                    <span className="hm-check-mark" data-done={done ? "" : undefined} aria-hidden>
                      {done ? <Check size={12} strokeWidth={2.5} /> : null}
                    </span>
                    <button type="button" data-home-item="" className="hm-row-title hm-todo-title" onClick={i.run} aria-label={`${i.label}${done ? ", done" : ""}`}>
                      {i.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </Fade>
      ) : null}
    </AnimatePresence>
  );
}
