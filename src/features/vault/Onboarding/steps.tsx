/**
 * First-run steps (PROGRAMME-v3 K4). Each step renders its own heading (focused on entry) and footer. Plain copy:
 * what the step does, no coaching.
 */
import {
  ArrowLeft,
  Check,
  CircleHelp,
  Download,
  FilePlus,
  Info,
  Landmark,
  Lock,
  LockOpen,
  RefreshCw,
  Wand2,
} from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { Button } from "@/ui/Button";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
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
      if (active && active !== document.body && ref.current?.closest(".emp-onb-panel")?.contains(active)) return;
      ref.current?.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={center ? "text-center" : undefined}>
      <h1 ref={ref} tabIndex={-1} className="emp-onb-title">
        {title}
      </h1>
      {sub ? <p className="emp-onb-sub">{sub}</p> : null}
    </div>
  );
}

export function Footer({ back, children, hint = true }: { back: (() => void) | null; children: ReactNode; hint?: boolean }) {
  return (
    <div className="emp-onb-foot">
      {back ? (
        <Button variant="ghost" icon={ArrowLeft} onClick={back}>
          Back
        </Button>
      ) : null}
      <span className="flex-1" />
      {hint ? (
        <span className="mr-1 hidden items-center gap-1.5 text-caption text-tertiary sm:flex" style={{ fontWeight: 400 }}>
          <Kbd keys="enter" size="xs" /> to continue
        </span>
      ) : null}
      {children}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 1 · welcome

const STARTS: { value: StartWith; title: string; description: string; icon: typeof Download }[] = [
  { value: "fresh", title: "Start fresh", description: "An empty workspace with the apps you pick next.", icon: FilePlus },
  { value: "pages", title: "Bring in Notion, Markdown or Obsidian", description: "Pages and simple databases. Relations and formulas may not survive.", icon: Download },
  { value: "money", title: "Bring in money", description: "A bank file (OFX, QFX or CSV) goes into Money HQ.", icon: Landmark },
];

export function WelcomeStep({ draft, update, next }: StepProps) {
  return (
    <div>
      <div className="flex items-center gap-4">
        <AppMark size={48} stage="rest" />
        <StepHeading title="Welcome to Ultra Note" sub="Notes, tasks and money, on this device." />
      </div>
      <div className="mt-6">
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
          size="lg"
          autoFocus
        />
      </div>
      <div className="mt-5 flex flex-col gap-2" role="radiogroup" aria-label="How do you want to start?">
        {STARTS.map((o) => (
          <ChoiceCard key={o.value} className="emp-onb-start" selected={draft.start === o.value} onSelect={() => update({ start: o.value })} icon={o.icon} title={o.title} description={o.description} />
        ))}
      </div>
      <Footer back={null}>
        <Button variant="primary" size="lg" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 3 · protect

export function ProtectStep({ draft, update, next, back, creating }: StepProps & { creating: boolean }) {
  return (
    <div>
      <StepHeading title="Protect your workspace" sub="Choose how Ultra Note stores your data on this device." />
      <div className="mt-6 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Encryption">
        <ChoiceCard
          selected={draft.encrypt === true}
          onSelect={() => update({ encrypt: true })}
          icon={Lock}
          recommended
          title="Encrypt with a password"
          description="Your data is encrypted with XChaCha20-Poly1305. Without your password or recovery key, nobody, including us, can read it."
        />
        <ChoiceCard
          selected={draft.encrypt === false}
          onSelect={() => update({ encrypt: false })}
          icon={LockOpen}
          title="Don't encrypt"
          description="Faster setup. You can turn on encryption later in Settings."
        />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.p
          key={String(draft.encrypt)}
          className="mt-4 flex gap-2 text-body-sm text-secondary"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.16 } }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
        >
          <Info size={15} className="mt-0.5 flex-none text-tertiary" aria-hidden />
          {draft.encrypt
            ? "Your password never leaves this device and can't be reset. Your recovery key is the only other way in."
            : "Your workspace lives on this computer. Ultra Note has no servers and no accounts, and your data is never sent anywhere."}
        </m.p>
      </AnimatePresence>
      <Footer back={back}>
        <Button variant="primary" size="lg" onClick={next} loading={creating} disabled={draft.encrypt === null}>
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
            <Button size="xs" variant="soft" icon={Wand2} loading={generating} onClick={() => void generate()} tooltip="5 random words, about 65 bits">
              Generate passphrase
            </Button>
          }
        />
        <PasswordField
          label="Confirm password"
          purpose="new"
          size="lg"
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
        <Button variant="primary" size="lg" onClick={onCreate} disabled={!canContinue && !creating} loading={creating} className="min-w-[132px]">
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
 * S3 "forge your vault": three exploded slabs assemble into the EMP stack while the key-derivation groove fills.
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
        <span className="text-body-sm text-secondary">{present ? "Forging your encryption key…" : "Vault sealed"}</span>
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
        <p className="mt-0.5 text-caption text-tertiary" style={{ fontWeight: 400 }}>
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
  const toggle = (id: string) => {
    const nextPicks = new Set(picks);
    if (nextPicks.has(id)) nextPicks.delete(id);
    else nextPicks.add(id);
    update({ picks: TRACK_OPTIONS.filter((o) => nextPicks.has(o.appId)).map((o) => o.appId) });
  };
  const n = appsFor(draft).length;
  return (
    <div>
      <StepHeading title="What do you want to track?" sub="Each pick is built as a life app with its own pages and databases. You can add or remove apps later." />
      <div className="emp-onb-choice-grid mt-6" role="group" aria-label="Life apps">
        {TRACK_OPTIONS.map((o) => {
          const on = picks.has(o.appId);
          const Icon = o.icon;
          return (
            <button key={o.appId} type="button" role="checkbox" aria-checked={on} className="emp-onb-chip" onClick={() => toggle(o.appId)}>
              <span className="tile">
                <Icon aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-body-sm font-medium">{o.label}</span>
                <span className="text-caption text-tertiary">{o.detail}</span>
              </span>
              {on ? (
                <span className="ml-auto flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent text-accent-contrast">
                  <Check size={10} strokeWidth={3} aria-hidden />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-body-sm text-secondary" aria-live="polite">
        {n ? `${n} ${n === 1 ? "app" : "apps"} to build` : "No apps. You'll start with a blank workspace."}
      </p>
      <Footer back={back}>
        <Button variant="primary" size="lg" onClick={next}>
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
      <StepHeading title={done ? "Ready" : "Building your workspace"} sub={done ? "Opening your workspace." : "Each app gets its own pages and databases."} />
      <ul className="mt-6 flex flex-col">
        {tasks.map((t, i) => (
          <li key={t.id} className="emp-build-row" data-state={states[i] === "done" ? "done" : states[i] === "pending" ? "pending" : undefined}>
            <span className="emp-build-dot" aria-hidden>
              {states[i] === "running" ? <Spinner size={16} /> : null}
              {states[i] === "done" ? <Check size={12} strokeWidth={3} /> : null}
              {states[i] === "error" ? <Info size={14} className="text-loss-text" /> : null}
            </span>
            <span className="flex-1">{t.label}</span>
            {states[i] === "running" && progress[i] > 0 ? <span className="text-caption tabular text-tertiary">{Math.round(progress[i] * 100)}%</span> : null}
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
        <div className="emp-onb-foot">
          <span className="flex-1" />
          <Button variant="primary" size="lg" onClick={onOpen} loading={opening} kbd="enter" autoFocus>
            Open
          </Button>
        </div>
      ) : null}
    </div>
  );
}
