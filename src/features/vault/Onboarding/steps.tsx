/**
 * Onboarding steps (§6.2). Each step renders its own heading (focused on entry) and footer. Copy follows SPEC
 * §6.2/§9.22 verbatim where SPEC gives it.
 */
import {
  ArrowLeft,
  Check,
  CircleHelp,
  Cloud,
  Download,
  Info,
  LineChart,
  Lock,
  LockOpen,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import type { AccentName } from "@/lib/bootPrefs";
import { useSettings } from "@/stores/settings";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { AccentPicker } from "@/ui/ColorPicker";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Segmented } from "@/ui/Segmented";
import { Spinner } from "@/ui/Spinner";
import { Switch } from "@/ui/Switch";
import { Magnetic } from "@/ui/motion/primitives";
import { switchThemeWithReveal } from "@/ui/motion/themeTransition";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppMark, Wordmark } from "../AppMark";
import { PasswordField, passwordAcceptable } from "../PasswordField";
import { RecoveryCeremony } from "../RecoveryCeremony";
import { appsFor, HELP_OPTIONS, type AutoLockChoice, type Draft } from "./model";

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

// ───────────────────────────────────────────────────────────────────────────── 0 · launch

export function LaunchStep({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotionPref();
  useEffect(() => {
    const t = window.setTimeout(onDone, reduced ? 500 : 1200);
    return () => window.clearTimeout(t);
  }, [onDone, reduced]);
  return (
    <div className="flex flex-col items-center gap-5 py-6" aria-label="Ultra Note">
      <AppMark size={112} stage="drop" />
      <Wordmark className="text-[34px] leading-none" delay={0.5} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 1 · welcome

export function WelcomeStep({ next, update }: StepProps) {
  return (
    <div className="flex flex-col items-center text-center">
      <AppMark size={88} stage="rest" className="emp-onb-hero-mark" />
      <div className="mt-7">
        <StepHeading title="Welcome to Ultra Note" sub="Your notes, money, plans and life admin, in one private place on your device." center />
      </div>
      <div className="mt-8 flex w-full max-w-[320px] flex-col gap-2">
        <Button variant="primary" size="xl" block onClick={next} kbd="enter">
          Get started
        </Button>
        <Button
          variant="ghost"
          size="md"
          block
          icon={Download}
          onClick={() => {
            update({ importAfter: true });
            next();
          }}
        >
          Import from Notion, Markdown or CSV
        </Button>
      </div>
      <p className="mt-8 flex items-center gap-1.5 text-caption text-tertiary" style={{ fontWeight: 400 }}>
        <ShieldCheck size={14} aria-hidden />
        Everything stays on this device unless you connect a service.
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 2 · make it yours

type ThemeChoice = "light" | "dark" | "system";

export function PersonalizeStep({ draft, update, next, back }: StepProps) {
  const device = useSettings((s) => s.device);
  const setDevice = useSettings((s) => s.setDevice);
  const theme: ThemeChoice = device?.theme === "light" || device?.theme === "dark" ? device.theme : device?.theme === "midnight" ? "dark" : "system";

  const pickTheme = (t: ThemeChoice, el: HTMLElement | null) => {
    if (t === theme) return;
    switchThemeWithReveal(() => void setDevice({ theme: t }), el);
  };

  return (
    <div>
      <StepHeading title="Make it yours" sub="You can change any of this later in Settings → Appearance." />
      <div className="mt-6">
        <Input
          label="What should we call you?"
          placeholder="Your first name"
          value={draft.name}
          maxLength={60}
          autoComplete="given-name"
          onChange={(e) => update({ name: e.currentTarget.value })}
          size="lg"
        />
      </div>
      <div className="mt-6">
        <span className="emp-label">Theme</span>
        <div className="mt-1.5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {(["light", "dark", "system"] as const).map((t) => (
            <ThemeCard key={t} t={t} selected={theme === t} onSelect={(el) => pickTheme(t, el)} />
          ))}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-5">
        <div>
          <span className="emp-label">Accent</span>
          <div className="mt-2">
            <AccentPicker value={(device?.accent ?? "graphite") as AccentName} onChange={(accent) => void setDevice({ accent })} />
          </div>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-4">
        <div>
          <span className="emp-label">Density</span>
          <Segmented
            className="mt-1.5"
            block
            aria-label="Density"
            value={device?.density ?? "comfortable"}
            onValueChange={(density) => void setDevice({ density })}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </div>
        <div>
          <span className="emp-label">Text size</span>
          <Segmented
            className="mt-1.5"
            block
            aria-label="Text size"
            value={device?.textSize ?? "m"}
            onValueChange={(textSize) => void setDevice({ textSize })}
            options={[
              { value: "s", label: "S", "aria-label": "Small" },
              { value: "m", label: "M", "aria-label": "Default" },
              { value: "l", label: "L", "aria-label": "Large" },
            ]}
          />
        </div>
      </div>
      <Footer back={back}>
        <Button variant="primary" size="lg" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

function ThemeCard({ t, selected, onSelect }: { t: ThemeChoice; selected: boolean; onSelect: (el: HTMLElement | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <ChoiceCard
        className="emp-theme-card"
        selected={selected}
        onSelect={() => onSelect(ref.current)}
        title={t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}
        preview={
          <span className="emp-theme-preview" data-t={t} aria-hidden>
            <span className="side">
              <i style={{ width: "80%" }} />
              <i style={{ width: "60%" }} />
              <i className="a" style={{ width: "70%" }} />
              <i style={{ width: "50%" }} />
            </span>
            <span className="main">
              <i style={{ width: "55%", height: 6 }} />
              <i style={{ width: "90%" }} />
              <i style={{ width: "75%" }} />
              <i style={{ width: "82%" }} />
            </span>
          </span>
        }
      />
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
            ? "Your password never leaves this device, and we can't reset it. Your recovery key is the only other way in, so keep it safe."
            : "Your workspace lives on your computer. Ultra Note has no servers and no accounts, and we never receive your data."}
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
      <StepHeading title="Create a password" sub="You'll use it to unlock Ultra Note. Use at least 10 characters — a few random words work well." />
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

// ───────────────────────────────────────────────────────────────────────────── 4 · what should EMP help with?

export function HelpStep({ draft, update, next, back }: StepProps) {
  const reduced = useReducedMotionPref();
  const picks = new Set(draft.picks);
  const apps = appsFor(draft.picks).length;
  const toggle = (id: string) => {
    const nextPicks = new Set(picks);
    if (nextPicks.has(id)) nextPicks.delete(id);
    else nextPicks.add(id);
    update({ picks: HELP_OPTIONS.filter((o) => nextPicks.has(o.id)).map((o) => o.id) });
  };
  return (
    <div>
      <StepHeading title="What should Ultra Note help with?" sub="Pick as many as you like. We'll set up a starting point for each." />
      <div className="emp-onb-choice-grid mt-6" role="group" aria-label="Areas">
        {HELP_OPTIONS.map((o) => {
          const on = picks.has(o.id);
          const Icon = o.icon;
          return (
            <m.button
              key={o.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="emp-onb-chip"
              onClick={() => toggle(o.id)}
              whileTap={reduced ? undefined : { scale: 0.985 }}
              transition={spring.snappy}
            >
              <span className="tile">
                <Icon aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-body-sm font-medium leading-[18px]">{o.label}</span>
                {o.starter ? (
                  <span className="text-[11px] leading-[14px] text-tertiary">More coming</span>
                ) : null}
              </span>
              <AnimatePresence>
                {on ? (
                  <m.span
                    key="c"
                    className="ml-auto flex h-4 w-4 flex-none items-center justify-center rounded-full bg-accent text-accent-contrast"
                    initial={reduced ? { opacity: 0 } : { scale: 0 }}
                    animate={reduced ? { opacity: 1 } : { scale: 1, transition: spring.bouncy }}
                    exit={{ opacity: 0, scale: reduced ? 1 : 0.5, transition: { duration: 0.1 } }}
                  >
                    <Check size={10} strokeWidth={3} aria-hidden />
                  </m.span>
                ) : null}
              </AnimatePresence>
            </m.button>
          );
        })}
      </div>
      <p className="mt-4 text-body-sm text-secondary" aria-live="polite">
        <span className="tabular font-semibold text-primary">{apps}</span> {apps === 1 ? "app" : "apps"} selected
        {draft.picks.some((p) => HELP_OPTIONS.find((o) => o.id === p)?.starter) ? <span className="text-tertiary"> · plus starter pages</span> : null}
      </p>
      <Footer back={back}>
        <Button variant="primary" size="lg" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 6 · connections and updates

export function ConnectionsStep({ draft, update, next, back }: StepProps) {
  return (
    <div>
      <StepHeading title="Connections and updates" sub="Nothing connects to the internet unless you turn on an integration. You can see every request Ultra Note makes in Security Center." />
      <div className="mt-5">
        <div className="emp-onb-row">
          <span className="ico">
            <Cloud size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-primary">Google Calendar and Drive</p>
            <p className="text-body-sm text-tertiary">Connect from Settings → Integrations whenever you're ready. Ultra Note talks to Google directly from this device.</p>
          </div>
          <Badge tone="outline">Later</Badge>
        </div>
        <div className="emp-onb-row">
          <span className="ico">
            <LineChart size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-body font-medium text-primary">
              Market data <Badge tone="neutral">Delayed data</Badge>
            </p>
            <p className="text-body-sm text-tertiary">Free quotes with no key, delayed by about 15 minutes. Add your own provider keys later; they're always stored encrypted.</p>
          </div>
          <Switch checked={draft.delayedMarketData} onCheckedChange={(v) => update({ delayedMarketData: v })} aria-label="Use free delayed market data" />
        </div>
        <div className="emp-onb-row">
          <span className="ico">
            <RefreshCw size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-primary">Check for updates automatically</p>
            <p className="text-body-sm text-tertiary">Contacts github.com once a day. Nothing else is sent.</p>
          </div>
          <Switch checked={draft.updates} onCheckedChange={(v) => update({ updates: v })} aria-label="Check for updates automatically" />
        </div>
      </div>
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
  run: () => Promise<void>;
}

type RowState = "pending" | "running" | "done" | "error";

export function BuildingStep({ tasks, onOpen, opening }: { tasks: BuildTask[]; onOpen: () => void; opening: boolean }) {
  const reduced = useReducedMotionPref();
  const [states, setStates] = useState<RowState[]>(() => tasks.map(() => "pending"));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = states.every((s) => s === "done");
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    let live = true;
    (async () => {
      const list = tasksRef.current;
      for (let i = 0; i < list.length; i++) {
        if (!live) return;
        setStates((cur) => (cur[i] === "done" ? cur : cur.map((s, k) => (k === i ? "running" : s))));
        const started = performance.now();
        try {
          await list[i].run();
        } catch (e) {
          if (!live) return;
          setError(errorMessage(e) || "Something went wrong");
          setStates((cur) => cur.map((s, k) => (k === i ? "error" : s)));
          return;
        }
        // §6.2: at least 180ms per row so each check is visible; never longer than the real work + 2s overall.
        const left = 180 - (performance.now() - started);
        if (left > 0) await new Promise((r) => setTimeout(r, left));
        if (!live) return;
        setStates((cur) => cur.map((s, k) => (k === i ? "done" : s)));
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  return (
    <div>
      <StepHeading title={done ? "Your workspace is ready" : "Building your workspace"} sub={done ? "Everything is set up on this device." : "This only takes a moment."} />
      <m.ul className="mt-6 flex flex-col" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.18 } } }}>
        {tasks.map((t, i) => (
          <m.li
            key={t.id}
            className="emp-build-row"
            data-state={states[i] === "done" ? "done" : states[i] === "pending" ? "pending" : undefined}
            variants={{ hidden: { opacity: 0, y: reduced ? 0 : 6 }, show: { opacity: 1, y: 0, transition: spring.gentle } }}
          >
            <span className="emp-build-dot" aria-hidden>
              {states[i] === "running" ? <Spinner size={16} /> : null}
              {states[i] === "done" ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <m.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.28, ease: ease.out }} />
                </svg>
              ) : null}
              {states[i] === "error" ? <Info size={14} style={{ color: "var(--loss-text)" }} /> : null}
            </span>
            <span className="flex-1">{t.label}</span>
            <span className="sr-only">{states[i]}</span>
          </m.li>
        ))}
      </m.ul>
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
      <div className="emp-onb-foot">
        <span className="flex-1" />
        <AnimatePresence>
          {done ? (
            <m.div key="open" initial={{ opacity: 0, y: reduced ? 0 : 6, scale: reduced ? 1 : 0.96 }} animate={{ opacity: 1, y: 0, scale: 1, transition: spring.settle }}>
              <Magnetic strength={3}>
                <Button variant="primary" size="xl" icon={Sparkles} iconMotion="sparkle" onClick={onOpen} loading={opening} kbd="enter" autoFocus>
                  Open Ultra Note
                </Button>
              </Magnetic>
            </m.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
