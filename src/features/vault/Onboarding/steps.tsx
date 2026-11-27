/**
 * The two first-run screens (1.0 brief §2.5). Each renders its own heading (focused on entry) and footer. Plain copy:
 * what the screen does, no coaching, no jargon (§1).
 */
import { ArrowLeft, CandlestickChart, Copy, FileText, ListTodo, LockKeyhole, LockOpen, ReceiptText, Sheet, Sprout, Wallet, type LucideIcon } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { usePrivacy } from "@/stores/privacy";
import { Button } from "@/ui/Button";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { AppMark } from "../AppMark";
import { PasswordField, passwordAcceptable } from "../PasswordField";
import { RecoveryCeremony } from "../RecoveryCeremony";
import { USE_CARDS, type Draft } from "./model";

// ───────────────────────────────────────────────────────────────────────────── shared

export function StepHeading({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Focus moves to the screen's heading, unless a field on the screen asked for autofocus.
    const t = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && ref.current?.closest(".onb-panel")?.contains(active)) return;
      ref.current?.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div>
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

/** A height + opacity reveal (160 ms; instant under reduced motion). */
function Reveal({ show, children, id }: { show: boolean; children: ReactNode; id: string }) {
  const reduced = useReducedMotionPref();
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <m.div
          key={id}
          className="overflow-hidden"
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1, transition: { duration: 0.08 } } : { opacity: 1, height: "auto", transition: { duration: 0.16, ease: [0.2, 0, 0, 1] } }}
          exit={reduced ? { opacity: 0, transition: { duration: 0.06 } } : { opacity: 0, height: 0, transition: { duration: 0.12 } }}
        >
          {children}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 1 · welcome

const CARD_ICON: Record<string, LucideIcon> = {
  notes: FileText,
  tasks: ListTodo,
  habits: Sprout,
  money: Wallet,
  investments: CandlestickChart,
  taxes: ReceiptText,
  spreadsheets: Sheet,
};

export function WelcomeStep({ draft, update, next }: { draft: Draft; update: (p: Partial<Draft>) => void; next: () => void }) {
  const picks = new Set(draft.picks);
  const toggle = (appId: string) => {
    const set = new Set(picks);
    if (set.has(appId)) set.delete(appId);
    else set.add(appId);
    update({ picks: USE_CARDS.flatMap((c) => (c.appId && set.has(c.appId) ? [c.appId] : [])) });
  };
  return (
    <div>
      <AppMark size={40} stage="rest" className="onb-mark" />
      <StepHeading title="Welcome to Ultranote" sub="Your notes, spreadsheets, tasks and money in one private place on this computer." />
      <div className="onb-field">
        <Input
          label="Your first name"
          helper="Optional. Your workspace is named after you."
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
      <h2 className="onb-section" id="onb-use">
        What would you like to use it for?
      </h2>
      <p className="onb-note mt-0">Pick any you like. You can add more later.</p>
      <div className="onb-cards" role="group" aria-labelledby="onb-use">
        {USE_CARDS.map((c) => {
          const always = c.appId === null;
          const on = always || picks.has(c.appId as string);
          return (
            <ChoiceCard
              key={c.key}
              role="checkbox"
              className="onb-card"
              selected={on}
              disabled={always}
              onSelect={() => c.appId && toggle(c.appId)}
              icon={CARD_ICON[c.key]}
              title={c.label}
              description={always ? "Always included" : c.detail}
            />
          );
        })}
      </div>
      <Footer back={null}>
        <Button variant="primary" onClick={next}>
          Continue
        </Button>
      </Footer>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── 2 · keep it private?

export interface PrivateStepProps {
  draft: Draft;
  update: (p: Partial<Draft>) => void;
  back: (() => void) | null;
  creating: boolean;
  opening: boolean;
  error: string | null;
  onCreate: () => void;
  onStart: () => void;
}

export function PrivateStep(props: PrivateStepProps) {
  const { draft } = props;
  // Once the encrypted workspace exists, the screen turns into its recovery key.
  if (draft.vaultCreated && draft.recoveryWords) return <RecoveryPart {...props} words={draft.recoveryWords} />;
  return <ChoosePart {...props} />;
}

function ChoosePart({ draft, update, back, creating, opening, error, onCreate, onStart }: PrivateStepProps) {
  const [strength, setStrength] = useState<PasswordStrength | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const copySensitive = usePrivacy((s) => s.copySensitive);
  const withPassword = draft.privacy === "password";
  const ok = passwordAcceptable(draft.password, strength);
  const match = draft.password === draft.confirm;
  const canCreate = withPassword && ok && match && !creating;

  const suggest = async () => {
    setSuggesting(true);
    try {
      const { passphrase } = await api.password.generate();
      setSuggested(passphrase);
      update({ password: passphrase, confirm: passphrase });
    } catch {
      /* the button stays; typing a password still works */
    } finally {
      setSuggesting(false);
    }
  };
  const showSuggestion = !!suggested && draft.password === suggested;

  return (
    <div>
      <StepHeading title="Keep it private?" sub="Everything stays on this computer. A password also encrypts it, so nobody else who uses this computer can read it." />
      <div className="onb-cards is-two" role="radiogroup" aria-label="Keep it private?">
        <ChoiceCard
          role="radio"
          className="onb-card"
          selected={withPassword}
          onSelect={() => update({ privacy: "password" })}
          icon={LockKeyhole}
          title="Lock with a password"
          description="Everything is encrypted. You'll unlock Ultranote with your password."
        />
        <ChoiceCard
          role="radio"
          className="onb-card"
          selected={draft.privacy === "none"}
          onSelect={() => update({ privacy: "none" })}
          icon={LockOpen}
          title="Not now"
          description="You can turn this on any time in Settings."
        />
      </div>
      <Reveal show={withPassword} id="pw">
        <div className="flex flex-col gap-4 pt-6">
          <PasswordField
            label="Password"
            purpose="new"
            value={draft.password}
            onChange={(password) => update({ password })}
            strength
            onStrength={setStrength}
            autoFocus
            trailing={
              <Button size="xs" variant="ghost" loading={suggesting} onClick={() => void suggest()}>
                Suggest one
              </Button>
            }
          />
          <AnimatePresence initial={false}>
            {showSuggestion ? (
              <m.div
                key="suggested"
                className="onb-suggest"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.12 } }}
                exit={{ opacity: 0, transition: { duration: 0.08 } }}
                role="status"
              >
                <div className="min-w-0 flex-1">
                  <span className="onb-suggest-label">Your new password</span>
                  <code className="onb-suggest-value" data-sensitive="">
                    {suggested}
                  </code>
                  <span className="onb-suggest-help">Write it down or keep it in a password manager.</span>
                </div>
                <Button size="sm" icon={Copy} onClick={() => suggested && copySensitive(suggested)}>
                  Copy
                </Button>
              </m.div>
            ) : null}
          </AnimatePresence>
          <PasswordField
            label="Confirm password"
            purpose="new"
            value={draft.confirm}
            onChange={(confirm) => update({ confirm })}
            error={draft.confirm && !match ? "The passwords don't match" : undefined}
            onEnter={() => canCreate && onCreate()}
          />
          <p className="onb-note mt-0">There's no way to reset a forgotten password. Next you'll get a recovery key, the only other way in.</p>
        </div>
      </Reveal>
      <Reveal show={draft.privacy === "none"} id="none">
        <p className="onb-note">Anyone who can sign in to your account on this computer could open your workspace files.</p>
      </Reveal>
      {error ? (
        <p className="emp-helper mt-4" data-invalid="" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
      <Footer back={creating || opening ? null : back} hint={draft.privacy === "none"}>
        {withPassword ? (
          <Button variant="primary" onClick={onCreate} disabled={!canCreate} loading={creating} className="min-w-[132px]">
            Continue
          </Button>
        ) : (
          <Button variant="primary" onClick={onStart} disabled={draft.privacy !== "none"} loading={opening}>
            Start using Ultranote
          </Button>
        )}
      </Footer>
      <AnimatePresence>
        {creating && withPassword ? (
          <m.div
            key="securing"
            className="emp-forge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18 } }}
            exit={{ opacity: 0, transition: { duration: 0.24, delay: 0.1 } }}
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

function RecoveryPart({ words, opening, error, onStart }: PrivateStepProps & { words: string[] }) {
  return (
    <div>
      <StepHeading title="Save your recovery key" sub="If you ever forget your password, these 24 words are the only other way in." />
      <div className="mt-6">
        <RecoveryCeremony words={words} allowSkip={false} continueLabel="Start using Ultranote" busy={opening} onDone={() => onStart()} />
      </div>
      {error ? (
        <p className="emp-helper mt-3" data-invalid="" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * While the key is derived: the three slabs of the mark close up as the progress line fills (part of the vault
 * moment; the length is the real key-derivation work). It reports no intermediate progress, so the line eases toward
 * 92% and closes the last stretch when the workspace exists (the overlay's exit); it never claims completion early.
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
    if (reduced) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const v = Math.min(0.92, 1 - Math.exp(-t / 0.42));
      setP(v);
      if (v < 0.919) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [present, reduced]);
  const shown = reduced ? (present ? 0.5 : 1) : p;
  return (
    <>
      <AppMark size={72} stage="exploded" assemble={shown} />
      <div className="mt-6 flex w-[220px] flex-col items-center gap-3">
        <span className="emp-forge-groove" aria-hidden>
          <i style={{ transform: `scaleX(${shown})` }} />
        </span>
        <span className="text-body-sm text-secondary">{present ? "Encrypting your workspace…" : "Encrypted"}</span>
      </div>
    </>
  );
}

