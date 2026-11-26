/* Dev-only gallery sections for Design Language v2 "Slab": materials, the state matrix, motion lab. */
import { ArrowRight, Bell, Bold, Download, Filter, Italic, List, Pencil, Plus, RefreshCw, Search, Settings, Sparkles, Trash2, Underline, Upload, Wallet } from "lucide-react";
import { AnimatePresence, LayoutGroup, m } from "motion/react";
import { useState, type ReactNode } from "react";
import { formatCurrency } from "@/lib/format";
import { Button, type ButtonVariant } from "./Button";
import { Card } from "./Card";
import { Checkbox } from "./Checkbox";
import { DeltaPill } from "./DeltaPill";
import { IconButton } from "./IconButton";
import { Kbd } from "./Kbd";
import { KpiTile } from "./KpiTile";
import { burst, celebrate } from "./motion/Celebrate";
import { Magnetic, Morph, Reveal, Specular, Stagger, Tilt } from "./motion/primitives";
import { RollingNumber } from "./motion/RollingNumber";
import { spring } from "./motion/tokens";
import { Ring } from "./Ring";
import { SlabGlyph } from "./SlabGlyph";
import { FilterChip } from "./Tag";
import { toast } from "./Toast";

function GSection({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-5 scroll-mt-20">
      <div className="flex flex-col gap-1">
        <h2 className="text-h3">{title}</h2>
        {lead ? <p className="text-body text-secondary max-w-[680px]">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-micro text-tertiary uppercase">{children}</span>;
}

/* ─────────────── Materials ─────────────── */
export function MaterialsSection() {
  return (
    <GSection
      id="materials"
      title="Materials"
      lead="Everything is a slab: raised keycaps, recessed wells, machined plates. One key light from above-front; glass is reserved for floating layers. Hover the panels — the rim catches the light."
    >
      <div className="grid grid-cols-3 gap-4">
        <Card title="Slab · .slab" subtitle="face ::after · side ::before · 1–3px edge">
          <div className="flex flex-wrap items-center gap-3 pb-1">
            <span className="slab slab-primary inline-flex h-10 px-5 items-center rounded-[11px] font-semibold" style={{ ["--edge" as string]: "3px" }}>
              Primary
            </span>
            <span className="slab inline-flex h-10 px-5 items-center rounded-[11px] font-semibold" style={{ ["--edge" as string]: "3px" }}>
              Secondary
            </span>
            <span className="slab slab-latched inline-flex h-10 px-4 items-center rounded-[11px] font-semibold" style={{ ["--edge" as string]: "3px" }}>
              Latched
            </span>
          </div>
        </Card>
        <Card title="Well · .well" subtitle="inset shadow · rim · 1px lip">
          <div className="flex flex-col gap-3">
            <div className="well h-9 rounded-[9px] flex items-center px-3 text-tertiary">Recessed bed</div>
            <div className="well-groove h-1.5 rounded-full" />
          </div>
        </Card>
        <Card title="Glass · .glass-1/2" subtitle="overlays only · ≤ 2 layers">
          <div className="relative h-[84px] rounded-xl overflow-hidden canvas-halo" style={{ boxShadow: "inset 0 0 0 1px var(--panel-rim)" }}>
            <div className="absolute inset-0 flex items-center gap-6 pl-5">
              <SlabGlyph size={48} />
              <SlabGlyph size={34} />
              <SlabGlyph size={24} />
            </div>
            <div className="glass-1 absolute left-[38%] right-3 top-3 bottom-3 rounded-[10px] flex items-center px-3 text-body-sm">Frosted surface</div>
          </div>
        </Card>
        <Specular as="div" wash className="panel col-span-2 p-6 flex items-center gap-8 rounded-[14px]">
          <SlabGlyph size={88} animate />
          <div className="flex flex-col gap-2">
            <span className="text-micro text-tertiary uppercase">Panel · data-light data-specular</span>
            <span className="text-h2">Machined plate</span>
            <span className="text-body text-secondary max-w-[420px]">
              Top-lit gradient, inner highlight and rim, 180px film grain, a contact shadow — and a pointer-tracked edge light from one
              global listener.
            </span>
          </div>
        </Specular>
        <Card title="Groove · dome">
          <div className="flex flex-col gap-4">
            <div className="groove-h" />
            <div className="flex items-center gap-4">
              <span className="dome w-5 h-5 rounded-full" />
              <span className="dome-lit w-5 h-5 rounded-full" />
              <span className="dome w-10 h-4 rounded-full" />
              <div className="groove-v h-8" />
              <Kbd keys="mod+k" />
            </div>
          </div>
        </Card>
      </div>
    </GSection>
  );
}

/* ─────────────── State matrix (ref-01) ─────────────── */
const STATES = [
  ["Rest", undefined],
  ["Hover", "hover"],
  ["Pressed", "press"],
  ["Focus", "focus"],
  ["Disabled", "disabled"],
] as const;

export function StateMatrix() {
  const rows: [string, ButtonVariant, ReactNode, typeof Plus | undefined][] = [
    ["Primary", "primary", "New entry", Plus],
    ["Secondary", "secondary", "Import", Upload],
    ["Ghost", "ghost", "Rules", Filter],
    ["Soft", "soft", "Suggest", Sparkles],
    ["Destructive", "destructive", "Delete", Trash2],
  ];
  const force = (s: (typeof STATES)[number][1]) =>
    s === "hover" ? { "data-force": "hover" } : s === "press" ? { "data-pressing": "" } : s === "focus" ? { "data-force": "focus" } : {};
  return (
    <Card>
      <div className="grid items-center gap-y-5 gap-x-2" style={{ gridTemplateColumns: "110px repeat(5, 1fr)" }}>
        <span />
        {STATES.map(([l]) => (
          <Label key={l}>{l}</Label>
        ))}
        {rows.map(([label, v, text, Icon]) => (
          <Row4 key={label} label={label}>
            {STATES.map(([l, s]) => (
              <div key={l}>
                <Button variant={v} icon={Icon} disabled={s === "disabled"} {...(force(s) as object)}>
                  {text}
                </Button>
              </div>
            ))}
          </Row4>
        ))}
        <Row4 label="Icon">
          {STATES.map(([l, s]) => (
            <div key={l} className="flex gap-2">
              <IconButton variant="secondary" icon={Pencil} label="Edit" noTooltip disabled={s === "disabled"} {...(force(s) as object)} />
              <IconButton variant="primary" icon={Plus} label="Add" noTooltip disabled={s === "disabled"} {...(force(s) as object)} />
            </div>
          ))}
        </Row4>
      </div>
    </Card>
  );
}

function Row4({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-body-sm text-secondary font-medium">{label}</span>
      {children}
    </>
  );
}

/* ─────────────── Toolbar, chips, micro-motions ─────────────── */
export function KeycapExtras() {
  const [marks, setMarks] = useState<Record<string, boolean>>({ bold: true, italic: false, underline: false, list: false });
  const [chips, setChips] = useState<Record<string, boolean>>({ month: true, uncat: false, over: true, recurring: false });
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title="Latched keys" subtitle="aria-pressed / active — the key stays half-down">
        <div className="flex items-center gap-2 pb-1">
          {(
            [
              ["bold", Bold],
              ["italic", Italic],
              ["underline", Underline],
              ["list", List],
            ] as const
          ).map(([k, I]) => (
            <IconButton key={k} variant="secondary" size="sm" icon={I} label={k} active={marks[k]} aria-pressed={marks[k]} onClick={() => setMarks((s) => ({ ...s, [k]: !s[k] }))} />
          ))}
          <span className="text-body-sm text-tertiary ml-2">Formatting toolbar</span>
        </div>
        <Label>Filter chips · tag-shaped keycaps</Label>
        <div className="flex flex-wrap gap-2 pb-1">
          {(
            [
              ["month", "This month", undefined],
              ["uncat", "Uncategorised", 12],
              ["over", "Over $100", undefined],
              ["recurring", "Recurring", 8],
            ] as const
          ).map(([k, l, c]) => (
            <FilterChip key={k} active={chips[k]} count={c} onClick={() => setChips((s) => ({ ...s, [k]: !s[k] }))}>
              {l}
            </FilterChip>
          ))}
        </div>
      </Card>
      <Card title="Icon micro-motions" subtitle="hover the button — transform only, on the release spring">
        <div className="flex flex-wrap gap-2 pb-1">
          <Button variant="secondary" size="sm" icon={Plus} iconMotion="plus">
            New
          </Button>
          <Button variant="secondary" size="sm" iconRight={ArrowRight} iconMotion="arrow">
            Next
          </Button>
          <Button variant="secondary" size="sm" icon={Trash2} iconMotion="trash">
            Delete
          </Button>
          <Button variant="secondary" size="sm" icon={Bell} iconMotion="bell">
            Notify
          </Button>
          <Button variant="secondary" size="sm" icon={Download} iconMotion="download">
            Export
          </Button>
          <Button variant="secondary" size="sm" icon={Settings} iconMotion="settings">
            Settings
          </Button>
          <Button variant="secondary" size="sm" icon={RefreshCw} iconMotion="refresh">
            Sync
          </Button>
          <Button variant="secondary" size="sm" icon={Search} iconMotion="search">
            Search
          </Button>
          <Button variant="primary" size="lg" icon={Sparkles} iconMotion="sparkle">
            Sheen on lg
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ─────────────── Motion lab ─────────────── */
export function MotionLab() {
  const [replay, setReplay] = useState(0);
  const [value, setValue] = useState(48_210.37);
  const [scrub, setScrub] = useState<number | null>(null);
  const [goal, setGoal] = useState(0.72);
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([
    { id: "a", label: "Pay the electricity bill", done: true },
    { id: "b", label: "Move $400 to Emergency fund", done: false },
    { id: "c", label: "Review subscriptions", done: false },
  ]);
  return (
    <GSection
      id="motion"
      title="Motion lab"
      lead="One spring table for CSS and JS. Things come from somewhere: overlays grow from their trigger, numbers roll, charts are drawn, success is celebrated with the icon's own slabs. Everything degrades under reduced motion and reduced effects."
    >
      <div className="grid grid-cols-3 gap-4">
        <Card title="Reveal · Stagger" subtitle="rise · rise-blur · cards 40ms (cap 8)" actions={<Button size="xs" variant="ghost" icon={RefreshCw} iconMotion="refresh" onClick={() => setReplay((n) => n + 1)}>Replay</Button>}>
          <Stagger key={replay} className="grid grid-cols-4 gap-2" variant="rise-blur">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="panel h-11 rounded-[10px]" />
            ))}
          </Stagger>
          <Reveal key={`r${replay}`} delay={0.3} className="text-body-sm text-secondary">
            Entrances never block input; ≤ 12 animated elements.
          </Reveal>
        </Card>
        <Card title="Odometer" subtitle="only changed digits roll · up for increases">
          <span className="text-kpi">
            <RollingNumber value={scrub ?? value} format={(n) => formatCurrency(n, "USD")} scrubbing={scrub !== null} countUpKey="gallery-odometer" />
          </span>
          <div className="flex gap-2 pb-1">
            <Button size="sm" variant="secondary" onClick={() => setValue((v) => +(v + 1234.56).toFixed(2))}>
              + $1,234.56
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setValue((v) => +(v - 987.65).toFixed(2))}>
              − $987.65
            </Button>
          </div>
          <div
            className="well h-8 rounded-[8px] flex items-center justify-center text-caption text-tertiary select-none"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setScrub(+(value * (0.6 + 0.4 * ((e.clientX - r.left) / r.width))).toFixed(2));
            }}
            onPointerLeave={() => setScrub(null)}
          >
            Scrub me (90ms, no stagger)
          </div>
        </Card>
        <Card title="Celebrations" subtitle="S8 goal · S13 task completion">
          <div className="flex items-center gap-4">
            <Ring size={64} value={goal} aria-label="Goal">
              {goal < 1 ? <span className="text-body-sm font-semibold tabular">{Math.round(goal * 100)}%</span> : undefined}
            </Ring>
            <div className="flex flex-col gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={(e) => {
                  const el = e.currentTarget;
                  const next = Math.min(1, +(goal + 0.14).toFixed(2));
                  setGoal(next);
                  if (next >= 1) {
                    celebrate(el);
                    window.setTimeout(() => toast.success("Emergency fund goal reached", { description: "6.0 months of essentials covered." }), 400);
                  }
                }}
              >
                Add to goal
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setGoal(0.72)}>
                Reset
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {tasks.map((t) => (
              <Checkbox key={t.id} celebrate checked={t.done} label={t.label} onCheckedChange={(v) => setTasks((s) => s.map((x) => (x.id === t.id ? { ...x, done: v } : x)))} />
            ))}
          </div>
        </Card>
        <Card title="Magnetic CTA · Tilt" subtitle="cinematic screens only · ≤ 3px / ≤ 3°">
          <div className="flex items-center gap-5">
            <Magnetic>
              <Button variant="primary" size="lg" iconRight={ArrowRight} iconMotion="arrow">
                Create vault
              </Button>
            </Magnetic>
            <Tilt className="panel w-[120px] h-[88px] rounded-[12px] flex items-center justify-center" max={3}>
              <SlabGlyph size={40} />
            </Tilt>
          </div>
        </Card>
        <Card title="KPI → detail (S10)" subtitle="layoutId on the morph spring">
          <LayoutGroup id="kpi-morph">
            <div className="relative h-[124px]">
              <AnimatePresence initial={false}>
                {open ? (
                  <Morph
                    id="kpi-card"
                    key="detail"
                    className="panel absolute inset-0 rounded-[14px] p-4 flex flex-col gap-2 cursor-default"
                    onClick={() => setOpen(false)}
                  >
                    <m.span layoutId="kpi-label" transition={spring.morph} className="text-caption text-secondary w-fit">
                      Spent this month
                    </m.span>
                    <m.span layoutId="kpi-value" transition={spring.morph} className="text-h2 tabular w-fit">
                      $3,412
                    </m.span>
                    <div className="flex items-end gap-1.5 h-10">
                      {[0.4, 0.7, 0.55, 0.9, 0.65, 0.8, 0.5].map((h, i) => (
                        <m.span
                          key={i}
                          className="flex-1 rounded-t-[3px]"
                          style={{ height: `${h * 100}%`, background: "linear-gradient(180deg, var(--lit-b), var(--lit-a))", transformOrigin: "bottom" }}
                          initial={{ scaleY: 0 }}
                          animate={{ scaleY: 1, transition: { ...spring.settle, delay: 0.12 + i * 0.024 } }}
                        />
                      ))}
                    </div>
                  </Morph>
                ) : (
                  <Morph id="kpi-card" key="tile" className="panel absolute left-0 top-0 w-[180px] rounded-[14px] p-4 flex flex-col gap-1" data-raise="" onClick={() => setOpen(true)}>
                    <m.span layoutId="kpi-label" transition={spring.morph} className="text-caption text-secondary w-fit">
                      Spent this month
                    </m.span>
                    <m.span layoutId="kpi-value" transition={spring.morph} className="text-title tabular w-fit">
                      $3,412
                    </m.span>
                    <span className="w-fit">
                      <DeltaPill value={-0.195} invert />
                    </span>
                  </Morph>
                )}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        </Card>
        <Card title="Living keycaps (S1)" subtitle="press these keys on your keyboard">
          <div className="flex flex-wrap items-center gap-3 pb-1">
            <Kbd keys="mod+k" />
            <Kbd keys="shift+enter" />
            <Kbd keys="arrowup" />
            <Kbd keys="arrowdown" />
            <Kbd keys="esc" />
            <Kbd keys="space" />
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => burst(e.currentTarget)}
            >
              Ray burst
            </Button>
            <Button size="sm" variant="secondary" icon={Wallet} onClick={(e) => celebrate(e.currentTarget, { badge: false })}>
              Slab confetti
            </Button>
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-4 gap-4">
        <KpiTile label="Net worth" value={{ amount: "243837.00", currency: "USD" }} noCents delta={{ value: 0.375, label: "past year" }} spark={[12, 14, 13, 15, 17, 16, 18, 21, 20, 23, 22, 25, 27, 26, 29]} onClick={() => toast("Opening net worth")} />
        <KpiTile label="To be assigned" value={{ amount: "307.42", currency: "USD" }} onClick={() => toast("Assign")} footer={<span>Give every dollar a job</span>} />
        <KpiTile label="Savings rate" value={34.4} format={(n) => `${n.toFixed(1)}%`} delta={{ value: 0.021, label: "3 months" }} onClick={() => toast("Savings rate")} />
        <KpiTile label="Spent this month" value={{ amount: "4138.00", currency: "USD" }} noCents delta={{ value: -0.195, invert: true }} spark={[30, 28, 29, 27, 26, 27, 24, 25, 23, 21, 22, 19]} onClick={() => toast("Spending")} />
      </div>
    </GSection>
  );
}
