/**
 * First-run steps (PROGRAMME-v3 K4). Each step renders its own heading (focused on entry) and footer. Plain copy:
 * what the step does, no coaching.
 */
import { ArrowLeft, Check, CircleHelp, CircleAlert, RefreshCw } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Radio, RadioGroupRoot } from "@/ui/Radio";
import { Segmented } from "@/ui/Segmented";
import { Spinner } from "@/ui/Spinner";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppMark } from "../AppMark";
import { PasswordField, passwordAcceptable } from "../PasswordField";
import { RecoveryCeremony } from "../RecoveryCeremony";
import { appsFor, TRACK_OPTIONS, type AutoLockChoice, type Draft, type StartWith } from "./model";

export interface StepProps {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  next: () => void;
  back: (() => void) | null;
}

// ───────────────────────────────────────────────────────────────────────────── shared

export function StepHeading({ title, sub, center }: { title: ReactNode; sub?: ReactNode; center?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // §6.2: focus moves to the step's heading — unless a field on the step asked for autofocus.
    const t = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && ref.current?.closest(".onb-panel")?.contains(active)) return;
      ref.current?.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={center ? "text-center" : undefined}>
      <h1 ref={ref} tabIndex={-1} className="onb-title">
        {title}
      </h1>
      {sub ? <p className="onb-sub">{sub}</p> : null}
    </div>
  );
}

export function Footer({ back, children, hint = true }: { back: (() => void) | null; children: ReactNode; hint?: boolean }) {
  return (
    <div className="onb-foot">
      {back ? (
        <Button variant="ghost" icon={ArrowLeft} onClick={back}>
          Back
        </Button>
      ) : null}
      <span className="flex-1" />
      {hint ? (
        <span className="onb-hint">
          <Kbd keys="enter" size="xs" /> to continue
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** A ruled list of single-choice rows: the radio, a title and one line of detail. The whole row is the target. */
function ChoiceRows<V extends string>({ label, value, onChange, options }: { label: string; value: V | null; onChange: (v: V) => void; options: { value: V; title: string; detail: string; note?: string }[] }) {
  const base = useId();
  return (
    <RadioGroupRoot className="onb-list" aria-label={label} value={value ?? undefined} onValueChange={(v) => onChange(v as V)}>
      {options.map((o) => {
        const id = `${base}-${o.value}`;
        return (
          <label key={o.value} htmlFor={id} className="onb-row" data-on={value === o.value ? "" : undefined}>
            <span className="onb-row-ctl">
              <Radio id={id} value={o.value} />
            </span>
            <span className="onb-row-text">
              <span className="onb-row-title">
                {o.title}
                {o.note ? <span className="onb-row-note">{o.note}</span> : null}
              </span>
              <span className="onb-row-detail">{o.detail}</span>
            </span>
          </label>
        );
      })}
    </RadioGroupRoot>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 1 · welcome

const STARTS: { value: StartWith; title: string; detail: string }[] = [
  { value: "fresh", title: "Start fresh", detail: "An empty workspace with the apps you pick next." },
  { value: "pages", title: "Bring in Notion, Markdown or Obsidian", detail: "Pages and simple databases. Relations and formulas may not come across." },
  { value: "money", title: "Bring in money", detail: "A bank file (OFX, QFX or CSV) goes into Money HQ." },
];

export function WelcomeStep({ draft, update, next }: StepProps) {
  return (
    <div>
      <AppMark size={40} stage="rest" className="onb-mark" />
      <StepHeading title="Welcome to Ultra Note" sub="Notes, tasks and money, kept on this device." />
      <div className="onb-field">
        <Input
          label="Your name"
          helper="Optional. Shown on the lock screen."
          placeholder="First name"
          value={draft.name}
          maxLength={60}
          autoComplete="given-name"
          onChange={(e) => update({ name: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              next();
            }
          }}
          autoFocus
        />
      </div>
      <h2 className="onb-section">How do you want to start?</h2>
      <ChoiceRows label="How do you want to start?" value={draft.start} onChange={(start) => update({ start })} options={STARTS} />
      <Footer back={null}>
        <Button variant="primary" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 3 · protect

const PROTECT: { value: "yes" | "no"; title: string; detail: string; note?: string }[] = [
  {
    value: "yes",
    title: "Encrypt with a password",
    note: "Recommended",
    detail: "Everything is encrypted on disk with XChaCha20-Poly1305. Without your password or recovery key it can't be read.",
  },
  { value: "no", title: "Don't encrypt", detail: "Quicker to set up. You can turn on encryption later in Settings." },
];

export function ProtectStep({ draft, update, next, back, creating }: StepProps & { creating: boolean }) {
  return (
    <div>
      <StepHeading title="Protect your workspace" sub="Your workspace lives on this computer. Ultra Note has no servers and no accounts." />
      <ChoiceRows
        label="Encryption"
        value={draft.encrypt === null ? null : draft.encrypt ? "yes" : "no"}
        onChange={(v) => update({ encrypt: v === "yes" })}
        options={PROTECT}
      />
      <p className="onb-note">
        {draft.encrypt
          ? "Your password never leaves this device and can't be reset. The recovery key is the only other way in."
          : "Anyone who can open your user account on this computer can read the files."}
      </p>
      <Footer back={back}>
        <Button variant="primary" onClick={next} loading={creating} disabled={draft.encrypt === null}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 3a · password

const AUTO_LOCK: { value: AutoLockChoice; label: string; "aria-label"?: string }[] = [
  { value: "5", label: "5 min", "aria-label": "5 minutes" },
  { value: "15", label: "15 min", "aria-label": "15 minutes" },
  { value: "30", label: "30 min", "aria-label": "30 minutes" },
  { value: "60", label: "60 min", "aria-label": "60 minutes" },
  { value: "sleep", label: "On sleep" },
];

export function PasswordStep({
  draft,
  update,
  back,
  onCreate,
  creating,
  error,
}: StepProps & { onCreate: () => void; creating: boolean; error: string | null }) {
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [generating, setGenerating] = useState(false);
  const ok = passwordAcceptable(draft.password, strength);
  const match = draft.password === draft.confirm;
  const canContinue = ok && match && !creating;

  const generate = async () => {
    setGenerating(true);
    try {
      const { passphrase } = await api.password.generate();
      update({ password: passphrase, confirm: passphrase });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      <StepHeading title="Create a password" sub="You'll use it to unlock Ultra Note. Use at least 10 characters; a few random words work well." />
      <div className="mt-6 flex flex-col gap-4">
        <PasswordField
          label="Password"
          purpose="new"
          value={draft.password}
          onChange={(password) => update({ password })}
          strength
          onStrength={setStrength}
          autoFocus
          trailing={
            <Button size="xs" variant="ghost" loading={generating} onClick={() => void generate()} tooltip="5 random words, about 65 bits">
              Suggest a passphrase
            </Button>
          }
        />
        <PasswordField
          label="Confirm password"
          purpose="new"
          value={draft.confirm}
          onChange={(confirm) => update({ confirm })}
          error={draft.confirm && !match ? "Passwords don't match" : undefined}
          onEnter={() => canContinue && onCreate()}
        />
        <div>
          <div className="flex items-center justify-between">
            <span className="emp-label">Lock automatically after</span>
            <StrengthTable />
          </div>
          <Segmented className="mt-1.5" block aria-label="Auto-lock" value={draft.autoLock} onValueChange={(autoLock) => update({ autoLock })} options={AUTO_LOCK} />
        </div>
      </div>
      {error ? (
        <p className="emp-helper mt-3" data-invalid="" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
      <Footer back={creating ? null : back}>
        <Button variant="primary" onClick={onCreate} disabled={!canContinue && !creating} loading={creating} className="min-w-[132px]">
          Continue
        </Button>
      </Footer>
      <AnimatePresence>
        {creating ? (
          <m.div
            key="securing"
            className="emp-forge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18 } }}
            exit={{ opacity: 0, transition: { duration: 0.28, delay: 0.12 } }}
            role="status"
            aria-live="polite"
          >
            <ForgeGlyph />
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * While the key is derived: the three slabs of the mark close up as the progress line fills (part of the vault
 * moment; the length is the real KDF work).
 * Key derivation reports no intermediate progress, so the groove eases toward 92% on the KDF's time scale and closes
 * the last stretch when the vault exists (the overlay's exit) — it never claims completion early.
 */
function ForgeGlyph() {
  const reduced = useReducedMotionPref();
  const present = useIsPresent();
  const [p, setP] = useState(0);
  useEffect(() => {
    if (!present) {
      setP(1);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      setP(Math.min(0.92, 1 - Math.exp(-t / 0.42)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [present]);
  const shown = reduced ? (present ? 0.5 : 1) : p;
  return (
    <>
      <AppMark size={72} stage="exploded" assemble={shown} />
      <div className="mt-6 flex w-[220px] flex-col items-center gap-3">
        <span className="emp-forge-groove" aria-hidden>
          <i style={{ transform: `scaleX(${shown})` }} />
        </span>
        <span className="text-body-sm text-secondary">{present ? "Deriving your encryption key…" : "Encrypted"}</span>
      </div>
    </>
  );
}

function StrengthTable() {
  const rows: [string, string][] = [
    ["Leaked top 10M", "~10 s"],
    ["8 lowercase letters", "~2–3 days"],
    ["4 Diceware words", "~100 years"],
    ["10 random ASCII characters", "~1.7 million years"],
    ["6 Diceware words", "billions of years"],
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="emp-link inline-flex items-center gap-1 text-caption">
          <CircleHelp size={12} aria-hidden /> How strong is my password?
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[320px]">
        <p className="text-body-sm font-semibold text-primary">Time to try every guess</p>
        <p className="mt-0.5 text-caption text-tertiary">
          Order-of-magnitude estimate at a million guesses per second.
        </p>
        <table className="mt-3 w-full text-body-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-subtle first:border-t-0">
                <td className="py-1.5 text-secondary">{k}</td>
                <td className="py-1.5 text-right font-medium text-primary tabular">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 3b · recovery key

export function RecoveryStep({ draft, update, next }: StepProps) {
  if (!draft.recoveryWords) return null;
  return (
    <div>
      <StepHeading title="Save your recovery key" sub="If you forget your password, these 24 words are the only other way in." />
      <div className="mt-6">
        <RecoveryCeremony
          words={draft.recoveryWords}
          onDone={(confirmed) => {
            update({ recoveryConfirmed: confirmed });
            next();
          }}
        />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 2 · what do you want to track?

export function TrackStep({ draft, update, next, back }: StepProps) {
  const picks = new Set(draft.picks);
  const set = (id: string, on: boolean) => {
    const nextPicks = new Set(picks);
    if (on) nextPicks.add(id);
    else nextPicks.delete(id);
    update({ picks: TRACK_OPTIONS.filter((o) => nextPicks.has(o.appId)).map((o) => o.appId) });
  };
  const n = appsFor(draft).length;
  const base = useId();
  return (
    <div>
      <StepHeading title="What do you want to track?" sub="Each pick becomes a life app with its own pages and databases. Add or remove apps later." />
      <div className="onb-list" role="group" aria-label="Life apps">
        {TRACK_OPTIONS.map((o) => {
          const id = `${base}-${o.appId}`;
          const on = picks.has(o.appId);
          return (
            <label key={o.appId} htmlFor={id} className="onb-row is-compact" data-on={on ? "" : undefined}>
              <span className="onb-row-ctl">
                <Checkbox id={id} checked={on} onCheckedChange={(v) => set(o.appId, v)} />
              </span>
              <span className="onb-row-title">{o.label}</span>
              <span className="onb-row-meta">{o.detail}</span>
            </label>
          );
        })}
      </div>
      <p className="onb-note" aria-live="polite">
        {n ? `${n} ${n === 1 ? "app" : "apps"} to build` : "No apps. You'll start with a blank workspace."}
      </p>
      <Footer back={back}>
        <Button variant="primary" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 7 · building your workspace

export interface BuildTask {
  id: string;
  label: string;
  /** Reports 0..1 when the work knows its own progress (a life-app build). */
  run: (progress: (p: number) => void) => Promise<void>;
}

type RowState = "pending" | "running" | "done" | "error";

/**
 * The build (one of the three signature moments, PROGRAMME-v3 K3): each row is real work and its length is the work.
 * When everything is done the app opens on Home by itself; an error stops here with Retry.
 */
export function BuildingStep({ tasks, onOpen, opening }: { tasks: BuildTask[]; onOpen: () => void; opening: boolean }) {
  const reduced = useReducedMotionPref();
  const [states, setStates] = useState<RowState[]>(() => tasks.map(() => "pending"));
  const [progress, setProgress] = useState<number[]>(() => tasks.map(() => 0));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = states.every((s) => s === "done");
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    let live = true;
    (async () => {
      const list = tasksRef.current;
      for (let i = 0; i < list.length; i++) {
        if (!live) return;
        let skip = false;
        setStates((cur) => {
          skip = cur[i] === "done";
          return skip ? cur : cur.map((s, k) => (k === i ? "running" : s));
        });
        if (skip) continue;
        try {
          await list[i].run((p) => live && setProgress((cur) => cur.map((x, k) => (k === i ? Math.max(x, Math.min(1, p)) : x))));
        } catch (e) {
          if (!live) return;
          setError(errorMessage(e) || "Something went wrong");
          setStates((cur) => cur.map((s, k) => (k === i ? "error" : s)));
          return;
        }
        if (!live) return;
        setStates((cur) => cur.map((s, k) => (k === i ? "done" : s)));
      }
      // Everything is built: open on Home (a short beat so the last check is seen).
      if (live) window.setTimeout(() => live && openRef.current(), reduced ? 0 : 400);
    })();
    return () => {
      live = false;
    };
  }, [attempt, reduced]);

  return (
    <div>
      <StepHeading title={done ? "Ready" : "Setting up your workspace"} sub={done ? "Opening Home." : undefined} />
      <ul className="onb-list">
        {tasks.map((t, i) => (
          <li key={t.id} className="onb-build-row" data-state={states[i]}>
            <span className="onb-build-mark" aria-hidden>
              {states[i] === "running" ? <Spinner size={14} /> : null}
              {states[i] === "done" ? <Check size={16} strokeWidth={1.5} absoluteStrokeWidth /> : null}
              {states[i] === "error" ? <CircleAlert size={16} strokeWidth={1.25} absoluteStrokeWidth /> : null}
            </span>
            <span className="flex-1">{t.label}</span>
            {states[i] === "running" && progress[i] > 0 ? <span className="onb-row-meta tabular">{Math.round(progress[i] * 100)}%</span> : null}
            <span className="sr-only">{states[i]}</span>
          </li>
        ))}
      </ul>
      {error ? (
        <div className="mt-3 flex items-center gap-3">
          <p className="emp-helper flex-1" data-invalid="" role="alert">
            <span>{error}</span>
          </p>
          <Button
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              setError(null);
              setStates((cur) => cur.map((s) => (s === "error" ? "pending" : s)));
              setAttempt((a) => a + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {done ? (
        <div className="onb-foot">
          <span className="flex-1" />
          <Button variant="primary" onClick={onOpen} loading={opening} kbd="enter" autoFocus>
            Open
          </Button>
        </div>
      ) : null}
    </div>
  );
}
