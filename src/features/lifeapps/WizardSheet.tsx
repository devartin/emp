/**
 * The reusable life-app wizard (§6.5): a 720px right sheet with questions on the left (400) and a live plan preview
 * on the right (320). Quick mode asks only `quick` steps; Guided asks everything. Steps slide (x ∓24 → 0); progress
 * is a segmented stepper; "Why?" chips explain recommendations. Create runs `lifeapp_install` as a job and turns the
 * body into a live build checklist, then celebrates and offers "Undo {App} setup" for 10 minutes.
 * Tune-up mode re-runs the same steps with stored answers and previews the PlanDiff.
 */
import { ArrowLeft, ArrowRight, Check, Lightbulb, Sparkles } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "@/backend";
import type { GenerationPlan, LifeAppManifest, PlanDiff, Step } from "@/backend/types";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useUndo } from "@/stores/undo";
import { useVault } from "@/stores/vault";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/Popover";
import { Segmented } from "@/ui/Segmented";
import { Sheet } from "@/ui/Sheet";
import { Spinner } from "@/ui/Spinner";
import { celebrate } from "@/ui/motion/Celebrate";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { loadManifest } from "./data";
import { resolveAnswers, visibleSteps } from "./engine/plan";
import { identity, appVars } from "./identity";
import { PlanPreview } from "./PlanPreview";
import { NumberStep, TextStep, ToggleStep } from "./steps/Basics";
import { ChoiceCards } from "./steps/ChoiceCards";
import { Connect } from "./steps/Connect";
import { DateStep } from "./steps/Date";
import { EncryptStep } from "./steps/Encrypt";
import { FileImport } from "./steps/FileImport";
import { Jurisdiction } from "./steps/Jurisdiction";
import { ListBuilder } from "./steps/ListBuilder";
import { Money } from "./steps/Money";
import { MultiChips } from "./steps/MultiChips";
import { Percent } from "./steps/Percent";
import { Recurrence } from "./steps/Recurrence";
import { Review } from "./steps/Review";
import { SliderStep } from "./steps/Slider";
import type { Recommendation, StepProps } from "./steps/types";
import { useWizard } from "./wizardStore";
import "./lifeapps.css";

const ENCRYPT: Step = { id: "__encrypt", kind: "toggle", title: "This data is sensitive — turn on encryption?", help: "Money, investments and taxes deserve a lock.", quick: true, skippable: true };
const UNDO_WINDOW = 10 * 60_000;

type Phase = "loading" | "questions" | "installing" | "done" | "error";
interface BuildRow {
  label: string;
  done: boolean;
}

function StepBody(props: StepProps) {
  switch (props.step.kind) {
    case "choice_cards":
      return <ChoiceCards {...props} />;
    case "multi_chips":
      return <MultiChips {...props} />;
    case "money":
      return <Money {...props} />;
    case "percent":
      return <Percent {...props} />;
    case "slider":
      return <SliderStep {...props} />;
    case "date":
      return <DateStep {...props} />;
    case "recurrence":
      return <Recurrence {...props} />;
    case "list_builder":
      return <ListBuilder {...props} />;
    case "file_import":
      return <FileImport {...props} />;
    case "connect":
      return <Connect {...props} />;
    case "jurisdiction":
      return <Jurisdiction {...props} />;
    case "text":
      return <TextStep {...props} />;
    case "number":
      return <NumberStep {...props} />;
    default:
      return <ToggleStep {...props} />;
  }
}

export function WizardSheet() {
  const { open, appId, tuneup, seed, mode: initialMode, close } = useWizard();
  const workspace = useWorkspace((s) => s.workspace);
  const encrypted = useVault((s) => s.status?.encrypted ?? true);
  const currency = useSettings((s) => s.vault?.baseCurrency ?? "USD");
  const reduced = useReducedMotionPref();

  const [manifest, setManifest] = useState<LifeAppManifest | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [mode, setMode] = useState(initialMode);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [plan, setPlan] = useState<GenerationPlan | null>(null);
  const [diff, setDiff] = useState<PlanDiff | null>(null);
  const [sample, setSample] = useState(false);
  const [encChoice, setEncChoice] = useState<"encrypt" | "later">("encrypt");
  const [build, setBuild] = useState<BuildRow[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ instanceId: string; rootPageId: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  // ── open / reset
  useEffect(() => {
    if (!open || !appId) return;
    let live = true;
    setPhase("loading");
    setManifest(null);
    setAnswers(seed ?? {});
    setStored(null);
    setIndex(0);
    setDir(1);
    setDisabled([]);
    setPlan(null);
    setDiff(null);
    setBuild([]);
    setProgress(0);
    setError(null);
    setResult(null);
    setMode(initialMode);
    setEncChoice("encrypt");
    (async () => {
      try {
        const m = await loadManifest(appId);
        let prior: Record<string, unknown> | null = null;
        if (tuneup) prior = ((await api.kv.get({ ns: "ui.lifeapps", key: `answers:${tuneup}` }).catch(() => null)) as Record<string, unknown> | null) ?? {};
        if (!live) return;
        setManifest(m);
        setStored(prior);
        if (prior) setAnswers({ ...prior, ...(seed ?? {}) });
        const fileStep = m.steps.find((s) => s.kind === "file_import");
        setSample(!!(seed && fileStep && (seed[fileStep.id] as { source?: string } | undefined)?.source === "sample"));
        setPhase("questions");
      } catch (e) {
        if (!live) return;
        setError(errorMessage(e));
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [open, appId, tuneup, seed, initialMode]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const steps = useMemo(() => {
    if (!manifest) return [] as Step[];
    const list = visibleSteps(manifest, answers, tuneup ? "guided" : mode, today);
    return manifest.sensitivity === "high" && !encrypted && !tuneup ? [ENCRYPT, ...list] : list;
  }, [manifest, answers, mode, tuneup, encrypted, today]);
  const step = steps[Math.min(index, steps.length - 1)];
  const isReview = step?.kind === "review";
  const ident = identity(appId ?? "");

  // ── live preview (debounced)
  useEffect(() => {
    if (!manifest || phase !== "questions") return;
    const h = setTimeout(() => {
      if (tuneup) {
        api.lifeapp.tuneupPreview({ instanceId: tuneup, answers }).then(setDiff).catch(() => undefined);
      }
      api.lifeapp
        .preview({ appId: manifest.id, answers, mode: tuneup ? "guided" : mode, disabledKeys: disabled })
        .then(setPlan)
        .catch(() => undefined);
    }, 180);
    return () => clearTimeout(h);
  }, [manifest, answers, mode, disabled, phase, tuneup]);

  const recFor = useCallback((s: Step): Recommendation | undefined => plan?.recommendations.find((r) => r.stepId === s.id), [plan]);

  /** The value shown for a step: explicit answer → recommendation (merged into object defaults) → default. */
  const valueFor = useCallback(
    (s: Step): unknown => {
      if (answers[s.id] !== undefined) return answers[s.id];
      const r = recFor(s);
      if (r) return s.default && typeof s.default === "object" && !Array.isArray(s.default) && r.value && typeof r.value === "object" && !Array.isArray(r.value) ? { ...(s.default as object), ...(r.value as object) } : r.value;
      return s.default;
    },
    [answers, recFor],
  );

  const resolved = useMemo(() => (manifest ? resolveAnswers(manifest, answers, mode, today).answers : answers), [manifest, answers, mode, today]);

  const go = (delta: number) => {
    setDir(delta);
    setIndex((i) => Math.max(0, Math.min(steps.length - 1, i + delta)));
  };
  useEffect(() => {
    if (phase === "questions") headingRef.current?.focus({ preventScroll: true });
  }, [index, phase]);

  // ── install / tune-up
  const create = async () => {
    if (!manifest || !workspace) return;
    setPhase("installing");
    setBuild([{ label: tuneup ? "Comparing with what you have" : `Preparing ${manifest.title}`, done: false }]);
    const onEvent = (e: { kind: string; done?: number; total?: number; label?: string }) => {
      if (e.kind !== "progress" || !e.total) return;
      setProgress(e.done! / e.total);
      if (e.label && e.done !== e.total)
        setBuild((rows) => {
          if (rows.some((r) => r.label === e.label)) return rows;
          return [...rows.map((r) => ({ ...r, done: true })), { label: e.label!, done: e.done === e.total }];
        });
    };
    try {
      if (tuneup) {
        const job = await api.lifeapp.tuneupApply({ instanceId: tuneup, answers, acceptConflicts: diff?.update.filter((u) => u.conflict).map((u) => u.key) ?? [], onEvent });
        await job.result;
        void api.kv.set({ ns: "ui.lifeapps", key: `answers:${tuneup}`, value: { ...(stored ?? {}), ...answers } }).catch(() => undefined);
        setResult({ instanceId: tuneup, rootPageId: "" });
      } else {
        const fileStep = manifest.steps.find((s) => s.kind === "file_import");
        const wantsSample = sample || (fileStep ? (valueFor(fileStep) as { source?: string } | undefined)?.source === "sample" : false);
        const job = await api.lifeapp.install({ appId: manifest.id, answers, mode, disabledKeys: disabled, workspaceId: workspace.id, sampleData: wantsSample, onEvent });
        const res = await job.result;
        setResult(res);
        void api.kv.set({ ns: "ui.lifeapps", key: `answers:${res.instanceId}`, value: resolved }).catch(() => undefined);
        // Undo for 10 minutes (§13.4): inverse is lifeapp_uninstall {keepContent:false}.
        const title = manifest.title;
        const cmd = {
          label: `Undo ${title} setup`,
          expiresAt: Date.now() + UNDO_WINDOW,
          do: () => undefined,
          undo: async () => {
            await api.lifeapp.uninstall({ instanceId: res.instanceId, keepContent: false });
            await useWorkspace.getState().refreshLifeapps();
            navigate({ t: "lifeapps" });
            notify.info(`${title} setup undone`);
          },
        };
        useUndo.getState().push(cmd);
        notify.success(`${title} is ready`, {
          description: "Everything was created in your sidebar.",
          duration: 10_000,
          action: { label: `Undo ${title} setup`, onClick: () => void useUndo.getState().undoCommand(cmd) },
        });
      }
      await useWorkspace.getState().refreshLifeapps();
      setBuild((rows) => rows.map((r) => ({ ...r, done: true })));
      setProgress(1);
      setPhase("done");
      requestAnimationFrame(() => doneRef.current && celebrate(doneRef.current));
    } catch (e) {
      setError(errorMessage(e));
      setPhase("error");
    }
  };

  const openApp = () => {
    const id = result?.instanceId;
    close();
    if (id) navigate({ t: "app", instanceId: id });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || phase !== "questions") return;
    const t = e.target as HTMLElement;
    if (t.closest("textarea, button, [role=combobox], [role=listbox], input[type=time]") || step?.id === ENCRYPT.id) return;
    e.preventDefault();
    if (isReview) void create();
    else go(1);
  };

  const busy = phase === "installing";
  const total = steps.length;
  const title = manifest ? (tuneup ? `Tune up ${manifest.title}` : `Set up ${manifest.title}`) : "Life app";
  const Icon = ident.icon;

  const header = (
    <div className="la-wiz-header" style={appVars(appId ?? "")}>
      <div className="flex items-center gap-3 pr-10">
        <span className="la-tile" style={{ background: ident.color }}>
          <Icon size={18} strokeWidth={2.1} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-title text-primary">{title}</div>
          <div className="truncate text-body-sm text-secondary">{manifest?.tagline ?? " "}</div>
        </div>
        {!tuneup && phase === "questions" && manifest ? (
          <Segmented
            size="sm"
            value={mode}
            onValueChange={(v) => {
              setMode(v);
              setIndex(0);
            }}
            options={[
              { value: "quick", label: "Quick" },
              { value: "guided", label: `Guided · ${manifest.estMinutes} min` },
            ]}
            aria-label="Wizard mode"
          />
        ) : null}
      </div>
      <div className="la-wiz-progress" aria-hidden>
        {phase === "questions" || phase === "loading"
          ? Array.from({ length: Math.max(total, 1) }, (_, i) => <span key={i} className={cn(i < index && "is-done", i === index && "is-on")} />)
          : <m.span className="la-wiz-progress-fill" initial={false} animate={{ scaleX: phase === "done" ? 1 : Math.max(0.04, progress) }} transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }} />}
      </div>
    </div>
  );

  const footer =
    phase === "questions" && step ? (
      <div className="flex w-full items-center gap-2">
        <span className="text-caption text-tertiary tabular">
          Step {Math.min(index + 1, total)} of {total}
        </span>
        {step.skippable && !isReview && step.id !== ENCRYPT.id ? (
          <Button variant="link" size="sm" onClick={() => go(1)}>
            Set up later
          </Button>
        ) : null}
        <span className="flex-1" />
        {index > 0 ? (
          <Button variant="ghost" icon={ArrowLeft} onClick={() => go(-1)}>
            Back
          </Button>
        ) : null}
        {isReview ? (
          <Button variant="primary" icon={tuneup ? Check : Sparkles} onClick={create} disabled={!plan}>
            {tuneup ? "Apply tune-up" : `Create ${manifest?.title} workspace`}
          </Button>
        ) : step.id === ENCRYPT.id && encChoice === "encrypt" ? (
          <Button variant="ghost" onClick={() => go(1)}>
            Skip for now
          </Button>
        ) : (
          <Button variant="primary" iconRight={ArrowRight} onClick={() => go(1)} kbd="↵">
            Continue
          </Button>
        )}
      </div>
    ) : phase === "done" ? (
      <div className="flex w-full items-center justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
        <Button variant="primary" iconRight={ArrowRight} onClick={openApp}>
          Open {manifest?.title}
        </Button>
      </div>
    ) : phase === "error" ? (
      <div className="flex w-full items-center justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
        {manifest ? (
          <Button variant="primary" onClick={() => setPhase("questions")}>
            Back to setup
          </Button>
        ) : null}
      </div>
    ) : undefined;

  const why = step && (recFor(step) || step.why);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !busy && close()} size="wizard" header={header} footer={footer} dismissible={!busy} bodyClassName="la-wiz-body" className="la-wiz">
      <div className="contents" onKeyDown={onKeyDown}>
        {phase === "loading" ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={20} label="Loading" />
          </div>
        ) : phase === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
            <p className="text-title text-primary">Something went wrong</p>
            <p className="max-w-[360px] text-body-sm text-secondary">{error}</p>
          </div>
        ) : phase === "installing" || phase === "done" ? (
          <BuildView rows={build} done={phase === "done"} appTitle={manifest?.title ?? ""} appId={appId ?? ""} tuneup={!!tuneup} refEl={doneRef} />
        ) : manifest && step ? (
          <div className="la-wiz-grid">
            <div className="la-wiz-q">
              <AnimatePresence mode="wait" initial={false} custom={dir}>
                <m.div
                  key={step.id}
                  custom={dir}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24 * dir }}
                  animate={{ opacity: 1, x: 0, transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, x: -24 * dir, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
                  className="flex flex-col gap-5"
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-start gap-2">
                      <h2 ref={headingRef} tabIndex={-1} className="la-q-title">
                        {isReview ? (tuneup ? "Review changes" : "Review & create") : step.title}
                      </h2>
                      {why && !isReview ? <WhyChip text={recFor(step)?.why ?? step.why ?? ""} source={recFor(step)?.source} /> : null}
                    </div>
                    {step.help && step.kind !== "connect" ? <p className="text-body-sm text-secondary">{step.help}</p> : null}
                    {isReview && plan ? <p className="text-body-sm text-secondary">Everything below is created on this device. You can tune it up any time.</p> : null}
                  </div>
                  {step.id === ENCRYPT.id ? (
                    <EncryptStep appTitle={manifest.title} choice={encChoice} onChoice={setEncChoice} onDone={() => go(1)} />
                  ) : isReview ? (
                    <Review
                      manifest={manifest}
                      steps={steps.filter((s) => s.id !== ENCRYPT.id)}
                      answers={Object.fromEntries(steps.map((s) => [s.id, valueFor(s)]))}
                      currency={currency}
                      sample={sample}
                      onSample={setSample}
                      onJump={(id) => {
                        const i = steps.findIndex((s) => s.id === id);
                        if (i >= 0) {
                          setDir(-1);
                          setIndex(i);
                        }
                      }}
                    />
                  ) : (
                    <StepBody step={step} value={valueFor(step)} onChange={(v) => setAnswers((a) => ({ ...a, [step.id]: v }))} answers={answers} manifest={manifest} recommendation={recFor(step)} currency={currency} />
                  )}
                </m.div>
              </AnimatePresence>
            </div>
            <aside className="la-wiz-side" aria-label="Preview">
              {tuneup && diff ? <DiffPreview diff={diff} /> : null}
              <PlanPreview manifest={manifest} plan={plan} answers={resolved} disabled={disabled} onToggle={(key, on) => setDisabled((d) => (on ? d.filter((k) => k !== key) : [...d, key]))} currency={currency} />
            </aside>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function WhyChip({ text, source }: { text: string; source?: string }) {
  if (!text) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="la-why" aria-label="Why this recommendation?">
          <Lightbulb size={12} aria-hidden />
          Why?
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="max-w-[300px]">
        <p className="text-body-sm text-primary">{text}</p>
        {source ? <p className="mt-2 text-caption text-tertiary">Source: {source}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

function DiffPreview({ diff }: { diff: PlanDiff }) {
  const conflicts = diff.update.filter((u) => u.conflict);
  return (
    <div className="la-diff">
      <span className="text-micro uppercase text-tertiary">Tune-up changes</span>
      <ul className="mt-2 flex flex-col gap-1 text-body-sm">
        {diff.add.map((a) => (
          <li key={a.key} className="flex items-center gap-2">
            <span className="la-diff-tag is-add">Add</span>
            <span className="truncate">{a.title}</span>
          </li>
        ))}
        {diff.update.map((u) => (
          <li key={u.key} className="flex items-center gap-2">
            <span className={cn("la-diff-tag", u.conflict ? "is-conflict" : "is-update")}>{u.conflict ? "Edited by you" : "Update"}</span>
            <span className="truncate">{u.key.replace(/_db$/, "").replace(/_/g, " ")}</span>
          </li>
        ))}
        {!diff.add.length && !diff.update.length ? <li className="text-tertiary">No changes yet — adjust an answer to see what changes.</li> : null}
      </ul>
      {conflicts.length ? <p className="mt-2 text-caption text-warning-text">You edited {conflicts.length === 1 ? "this item" : "these items"}; applying keeps your edits and adds what’s new.</p> : null}
    </div>
  );
}

function BuildView({ rows, done, appTitle, appId, tuneup, refEl }: { rows: BuildRow[]; done: boolean; appTitle: string; appId: string; tuneup: boolean; refEl: React.RefObject<HTMLDivElement | null> }) {
  const ident = identity(appId);
  const Icon = ident.icon;
  return (
    <div className="la-build" style={appVars(appId)}>
      <div className="la-build-hero">
        <div ref={refEl} className={cn("la-build-tile", done && "is-done")} style={{ background: ident.color }}>
          <Icon size={26} strokeWidth={2} aria-hidden />
        </div>
        <h2 className="text-h3 text-primary" aria-live="polite">
          {done ? (tuneup ? `${appTitle} is tuned up` : `${appTitle} is ready`) : tuneup ? `Tuning up ${appTitle}…` : `Building ${appTitle}…`}
        </h2>
        <p className="text-body-sm text-secondary">{done ? "Everything is on this device. Nothing was sent anywhere." : "Creating pages, databases and dashboards for you."}</p>
      </div>
      <ul className="la-build-list" aria-label="Progress">
        <AnimatePresence initial={false}>
          {rows.map((r) => (
            <m.li key={r.label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: spring.gentle }} className="la-build-row">
              <span className="la-build-ico">
                {r.done ? (
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                    <circle cx="12" cy="12" r="10" fill="var(--app)" />
                    <m.path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }} />
                  </svg>
                ) : (
                  <Spinner size={14} />
                )}
              </span>
              <span className={cn("text-body-sm", r.done ? "text-secondary" : "text-primary")}>{r.label}</span>
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export default WizardSheet;
