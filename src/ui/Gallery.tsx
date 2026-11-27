/* Dev-only component showcase: every primitive in every state, all themes/accents, all chart types. */
import {
  Archive, ArrowRight, Bell, Calendar as CalendarIcon, Copy, Download, FileText, Inbox, LayoutGrid, List, Lock, MoreHorizontal, Pencil, Plus, Search,
  Check, House, Lightbulb, ListChecks, Settings, Share2, Star, Table2, Trash2, Wallet,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { applyBootPrefs, getBootPrefs, type AccentName, type ThemePref } from "@/lib/bootPrefs";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/format";
import { AlertDialog } from "./AlertDialog";
import { Amount } from "./Amount";
import { Avatar, AvatarStack } from "./Avatar";
import { Badge } from "./Badge";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Card } from "./Card";
import { Checkbox } from "./Checkbox";
import { ChoiceCard } from "./ChoiceCard";
import { AccentPicker, ColorPicker, type BlockColorValue } from "./ColorPicker";
import { Combobox, type ComboOption } from "./Combobox";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "./ContextMenu";
import { DatePicker } from "./DatePicker";
import { DeltaPill } from "./DeltaPill";
import { Dialog } from "./Dialog";
import { IconPicker } from "./IconPicker";
import { Glyph } from "./icons/Icon";
import { EmptyState } from "./EmptyState";
import { FileDropZone } from "./FileDropZone";
import { IconsSection, KeycapExtras, MaterialsSection, MoneySection, MotionLab, StateMatrix, TypeSection } from "./GalleryV2";
import { IconButton } from "./IconButton";
import { Input } from "./Input";
import { Kbd } from "./Kbd";
import { KpiTile } from "./KpiTile";
import {
  Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger,
  MenuTrigger,
} from "./Menu";
import { MoneyField } from "./MoneyField";
import { celebrate } from "./motion/Celebrate";
import { RollingNumber } from "./motion/RollingNumber";
import { switchThemeWithReveal } from "./motion/themeTransition";
import { NumberField } from "./NumberField";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import { PriceFlash } from "./PriceFlash";
import { BudgetProgress, Progress, Stepper } from "./Progress";
import { RadioGroup } from "./Radio";
import { Ring } from "./Ring";
import { SearchField } from "./SearchField";
import { SecretField } from "./SecretField";
import { Segmented } from "./Segmented";
import { Select } from "./Select";
import { Sheet } from "./Sheet";
import { Skeleton, SkeletonSwap, SkeletonText } from "./Skeleton";
import { Text } from "./Text";
import { Slider } from "./Slider";
import { Spinner } from "./Spinner";
import { StrengthMeter } from "./StrengthMeter";
import { Switch } from "./Switch";
import { Tabs } from "./Tabs";
import { Tag } from "./Tag";
import { Textarea } from "./Textarea";
import { toast } from "./Toast";
import { Tooltip } from "./Tooltip";

const ChartGallery = lazy(() => import("@/charts/ChartGallery"));

const SECTIONS = [
  ["foundations", "Foundations"],
  ["materials", "Paper, ink and keys"],
  ["type", "Type"],
  ["money", "Money"],
  ["icons", "Icons"],
  ["buttons", "Keys"],
  ["inputs", "Inputs"],
  ["selection", "Selection"],
  ["controls", "Toggles & sliders"],
  ["navigation", "Tabs & segmented"],
  ["overlays", "Menus & overlays"],
  ["feedback", "Feedback"],
  ["data", "Cards & KPIs"],
  ["status", "Progress & status"],
  ["misc", "Tags, avatars, misc"],
  ["motion", "Motion register"],
  ["charts", "Charts"],
] as const;

export function Gallery() {
  const [theme, setTheme] = useState<"light" | "dark" | "midnight">(() => (document.documentElement.getAttribute("data-theme") as "light") ?? "light");
  const [accent, setAccent] = useState<AccentName>(() => (document.documentElement.getAttribute("data-accent") as AccentName) ?? "graphite");
  const [density, setDensity] = useState(() => document.documentElement.getAttribute("data-density") ?? "comfortable");
  const [motion, setMotion] = useState(() => document.documentElement.getAttribute("data-motion") ?? "full");
  const [privacy, setPrivacy] = useState(() => document.documentElement.getAttribute("data-privacy") === "on");
  const [numbers, setNumbers] = useState(() => document.documentElement.getAttribute("data-numbers") ?? "standard");
  const [effects, setEffects] = useState(() => document.documentElement.getAttribute("data-effects") ?? "full");
  const [contrast, setContrast] = useState(() => document.documentElement.getAttribute("data-contrast") ?? "normal");

  const apply = (patch: Partial<{ theme: ThemePref; accent: AccentName }>) => applyBootPrefs({ ...getBootPrefs(), ...patch });
  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    document.documentElement.setAttribute("data-motion", motion);
    document.documentElement.setAttribute("data-privacy", privacy ? "on" : "off");
    document.documentElement.setAttribute("data-numbers", numbers);
    document.documentElement.setAttribute("data-effects", effects);
    document.documentElement.setAttribute("data-contrast", contrast);
  }, [density, motion, privacy, numbers, effects, contrast]);

  return (
    <div className="min-h-screen bg-canvas text-primary">
      <header className="sticky top-0 z-30 flex items-center gap-3 px-6 h-14 bg-canvas border-b border-default">
        <img src="/emp.svg" width={24} height={24} alt="" className="rounded-sm" />
        <span className="text-title">Ultranote UI</span>
        <Badge tone="solid">v3 Paper, ink and keys</Badge>
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            size="sm"
            aria-label="Theme"
            value={theme}
            onValueChange={(t) => {
              const btn = document.querySelector<HTMLElement>(`[data-theme-btn="${t}"]`);
              switchThemeWithReveal(() => {
                setTheme(t);
                apply({ theme: t });
              }, btn);
            }}
            options={[
              { value: "light", label: <span data-theme-btn="light">Light</span> },
              { value: "dark", label: <span data-theme-btn="dark">Dark</span> },
              { value: "midnight", label: <span data-theme-btn="midnight">Midnight</span> },
            ]}
          />
          <AccentPicker
            value={accent}
            onChange={(a) => {
              setAccent(a);
              apply({ accent: a });
            }}
          />
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={Settings} label="Display options" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Density</MenuLabel>
              <MenuRadioGroup value={density} onValueChange={setDensity}>
                <MenuRadioItem value="comfortable">Comfortable</MenuRadioItem>
                <MenuRadioItem value="compact">Compact</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuLabel>Motion</MenuLabel>
              <MenuRadioGroup value={motion} onValueChange={setMotion}>
                <MenuRadioItem value="full">Full</MenuRadioItem>
                <MenuRadioItem value="reduced">Reduced</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuLabel>Effects</MenuLabel>
              <MenuRadioGroup value={effects} onValueChange={setEffects}>
                <MenuRadioItem value="full">Full</MenuRadioItem>
                <MenuRadioItem value="reduced">Reduced</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuLabel>Contrast</MenuLabel>
              <MenuRadioGroup value={contrast} onValueChange={setContrast}>
                <MenuRadioItem value="normal">Standard</MenuRadioItem>
                <MenuRadioItem value="more">More</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuLabel>Number colours</MenuLabel>
              <MenuRadioGroup value={numbers} onValueChange={setNumbers}>
                <MenuRadioItem value="standard">Standard</MenuRadioItem>
                <MenuRadioItem value="cvd">Colour-blind safe</MenuRadioItem>
                <MenuRadioItem value="eastasian">East Asian</MenuRadioItem>
                <MenuRadioItem value="mono">Monochrome</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
          <Switch size="sm" checked={privacy} onCheckedChange={setPrivacy} label="Hide numbers" />
        </div>
      </header>
      <div className="flex">
        <nav className="sticky top-14 self-start hidden wide:flex flex-col gap-0.5 p-4 w-[220px] flex-none" style={{ height: "calc(100vh - 56px)" }}>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="h-7 px-2 rounded-sm flex items-center text-body-sm text-secondary hover:bg-hover hover:text-primary" style={{ cursor: "default" }}>
              {label}
            </a>
          ))}
        </nav>
        <main className="flex-1 min-w-0 px-8 py-8 flex flex-col gap-14 max-w-[1120px]">
          <Foundations />
          <MaterialsSection />
          <TypeSection />
          <MoneySection />
          <IconsSection />
          <Buttons />
          <Inputs />
          <SelectionSection />
          <Controls />
          <Navigation />
          <Overlays />
          <Feedback />
          <DataSection />
          <Status />
          <Misc />
          <MotionLab />
          <Section id="charts" title="Charts" lead="One ink line on nothing: no gridlines, no gradient fill, a dotted reference line, a quiet axis on the right. Colour only for multi-series. Lines draw in once, on the first data load, in 250ms.">
            <Suspense fallback={<Skeleton height={320} radius={14} />}>
              <ChartGallery />
            </Suspense>
          </Section>
        </main>
      </div>
    </div>
  );
}

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-5 scroll-mt-20">
      <div className="flex flex-col gap-1">
        <h2 className="text-h3">{title}</h2>
        {lead ? <p className="text-body text-secondary max-w-[640px]">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {label ? <span className="text-caption text-tertiary">{label}</span> : null}
      <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>
    </div>
  );
}

/* ─────────────── Foundations ─────────────── */
function Foundations() {
  const neutrals = ["--bg-window", "--bg-canvas", "--bg-surface-1", "--bg-surface-2", "--bg-surface-3", "--bg-overlay", "--bg-inverse"];
  const texts = ["--text-primary", "--text-secondary", "--text-tertiary", "--text-disabled"];
  const semantic = ["--accent-solid", "--accent-soft", "--gain", "--loss", "--warning", "--info"];
  const blocks = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  return (
    <Section id="foundations" title="Foundations" lead="Warm paper and graphite ink. Colour is reserved for meaning: gain and loss on deltas, destructive, warning, tags and multi-series data.">
      <div className="grid grid-cols-2 gap-4">
        <Card title="Surfaces">
          <div className="grid grid-cols-7 gap-2">
            {neutrals.map((v) => (
              <div key={v} className="flex flex-col gap-1.5">
                <div className="h-12 rounded-md" style={{ background: `var(${v})`, boxShadow: "inset 0 0 0 1px var(--border)" }} />
                <span className="text-micro text-tertiary normal-case truncate" style={{ letterSpacing: 0 }}>
                  {v.replace("--bg-", "")}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-4 mt-1">
            {texts.map((v) => (
              <span key={v} className="text-body font-medium" style={{ color: `var(${v})` }}>
                {v.replace("--text-", "")}
              </span>
            ))}
          </div>
        </Card>
        <Card title="Accent & semantic">
          <div className="grid grid-cols-6 gap-2">
            {semantic.map((v) => (
              <div key={v} className="flex flex-col gap-1.5">
                <div className="h-12 rounded-md" style={{ background: `var(${v})`, boxShadow: "inset 0 0 0 1px var(--border-subtle)" }} />
                <span className="text-micro text-tertiary normal-case truncate" style={{ letterSpacing: 0 }}>
                  {v.slice(2)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {blocks.map((b) => (
              <Tag key={b} color={b as never}>
                {b}
              </Tag>
            ))}
          </div>
        </Card>
        <Card title="Type scale">
          <div className="flex flex-col gap-2">
            <Text v="title" as="span">Title 30 / 600</Text>
            <Text v="h1" as="span">Heading 1 24 / 600</Text>
            <Text v="h2" as="span">Heading 2 20 / 600</Text>
            <Text v="h3" as="span">Heading 3 16 / 600</Text>
            <Text v="doc" as="span">Document 16 / 400. The quick brown fox jumps over the lazy dog.</Text>
            <Text v="body" as="span">Body 14 / 400. The quick brown fox jumps over the lazy dog.</Text>
            <Text v="ui" as="span" tone="secondary">UI 13, secondary</Text>
            <Text v="small" as="span" tone="tertiary">Small 12, tertiary</Text>
            <Text v="micro" as="span" tone="tertiary">Micro 11, sentence case</Text>
            <Text v="mono">mono 13 · 0x1F4A9 · €1,204.50</Text>
          </div>
        </Card>
        <Card title="Elevation & radii">
          <div className="grid grid-cols-4 gap-4 p-2">
            {[1, 2, 3, 4].map((e) => (
              <div key={e} className="h-20 rounded-xl flex items-end p-2 text-caption text-tertiary" style={{ boxShadow: `var(--elev-${e})`, background: "var(--bg-overlay)" }}>
                elev-{e}
              </div>
            ))}
          </div>
          <div className="flex gap-3 items-end p-2">
            {["xs", "sm", "md", "lg", "xl", "2xl"].map((r) => (
              <div key={r} className="flex flex-col items-center gap-1">
                <div className="w-12 h-12 bg-surface-2" style={{ borderRadius: `var(--radius-${r})`, boxShadow: "inset 0 0 0 1px var(--border)" }} />
                <span className="text-caption text-tertiary">{r}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Section>
  );
}

/* ─────────────── Buttons ─────────────── */
function Buttons() {
  const variants = ["primary", "secondary", "ghost", "soft", "destructive", "destructive-ghost", "link"] as const;
  const [ok, setOk] = useState(false);
  return (
    <Section id="buttons" title="Buttons" lead="Keys answer your hands. The ink key is the one primary action in a view; secondary actions are paper keys; ghosts are an ink wash. Press travels 0.5px in 60ms, release is 100ms with no overshoot. Focus is a 2px ink ring, 1px out.">
      <StateMatrix />
      <Card>
        <div className="flex flex-col gap-5">
          {variants.map((v) => (
            <Row key={v} label={v}>
              <Button variant={v} icon={v === "link" ? undefined : v.startsWith("destructive") ? Trash2 : Plus}>
                {v === "link" ? "Learn more" : v.startsWith("destructive") ? "Delete" : "New page"}
              </Button>
              <Button variant={v} kbd={v === "primary" || v === "secondary" ? "mod+enter" : undefined}>
                Continue
              </Button>
              <Button variant={v} disabled disabledReason="You need edit access">
                Disabled
              </Button>
              {v !== "link" ? (
                <Button variant={v} loading>
                  Saving
                </Button>
              ) : null}
              {v !== "link" ? <IconButton variant={v} icon={Star} label="Favorite" shortcut="mod+shift+f" /> : null}
            </Row>
          ))}
          <Row label="Sizes">
            {(["xs", "sm", "md", "lg", "xl"] as const).map((s) => (
              <Button key={s} size={s} variant="primary" icon={Plus}>
                Size {s}
              </Button>
            ))}
          </Row>
          <Row label="Icon buttons">
            {(["xs", "sm", "md", "lg", "xl"] as const).map((s) => (
              <IconButton key={s} size={s} variant="secondary" icon={MoreHorizontal} label={`More (${s})`} />
            ))}
            <IconButton icon={Bell} label="Notifications" />
            <IconButton icon={Share2} label="Share" active />
          </Row>
          <Row label="Async + success morph">
            <Button variant="primary" successFeedback onClick={() => new Promise((r) => setTimeout(r, 900))} icon={Download}>
              Export CSV
            </Button>
            <Button variant="secondary" success={ok} onClick={() => setOk((v) => !v)} icon={Copy}>
              Copy link
            </Button>
            <Button variant="soft" iconRight={ArrowRight}>
              Set up with a guide
            </Button>
          </Row>
        </div>
      </Card>
      <KeycapExtras />
    </Section>
  );
}

/* ─────────────── Inputs ─────────────── */
function Inputs() {
  const [num, setNum] = useState<number | null>(1250);
  const [amt, setAmt] = useState<string | null>("2450.00");
  const [text, setText] = useState("Quarterly review");
  return (
    <Section id="inputs" title="Inputs" lead="Flat 1px fields. Hover darkens the hairline; focus draws a 2px ink ring. Number fields carry small steppers that repeat on hold and evaluate =expressions on blur.">
      <Card>
        <div className="grid grid-cols-3 gap-x-6 gap-y-5">
          <Input label="Page title" value={text} onChange={(e) => setText(e.currentTarget.value)} clearable helper="Shown in the sidebar and breadcrumbs" />
          <Input label="Email" placeholder="you@example.com" required icon={Inbox} />
          <Input label="Invalid" defaultValue="not-an-iban" error="That doesn't look like a valid IBAN" />
          <SearchField aria-label="Search" />
          <Input label="Disabled" disabled defaultValue="Locked value" />
          <Input label="Read-only" readOnly defaultValue="acct_9f2c1e" className="slashed font-mono" />
          <NumberField label="Quantity" value={num} onChange={setNum} helper="Try typing =12*4+2 then Tab" steppers />
          <MoneyField label="Monthly budget" value={amt} onChange={setAmt} currency="USD" />
          <SecretField label="API key" defaultValue="sk_live_51Hc9…" helper="Stored encrypted; never shown again" />
          <Input size="sm" placeholder="Small 28" />
          <Input placeholder="Default 32" suffix="kg" />
          <Input size="lg" placeholder="Large 40" prefix="https://" />
          <div className="col-span-3">
            <Textarea label="Notes" placeholder="Grows from 3 to 12 rows…" />
          </div>
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Selection ─────────────── */
function SelectionSection() {
  const [cur, setCur] = useState<string | null>("USD");
  const [status, setStatus] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>(["groceries", "recurring"]);
  const [tagOpts, setTagOpts] = useState<ComboOption[]>([
    { value: "groceries", label: "Groceries", color: "green" },
    { value: "recurring", label: "Recurring", color: "blue" },
    { value: "travel", label: "Travel", color: "orange" },
    { value: "tax", label: "Tax deductible", color: "purple" },
    { value: "review", label: "Needs review", color: "red" },
  ]);
  const [date, setDate] = useState<string | null>("2026-11-26");
  const [color, setColor] = useState<BlockColorValue>("blue");
  const [pickedIcon, setPickedIcon] = useState("book-open");
  const [bg, setBg] = useState<BlockColorValue>("yellow");
  const currencies = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK", "NOK", "SGD", "BTC"].map((c) => ({ value: c, label: c, description: formatCurrency(1234.5, c === "BTC" ? "USD" : c) }));
  return (
    <Section id="selection" title="Select, combobox, date" lead="Triggers are fields. Lists are opaque paper with a warm ring; the highlight follows the pointer and the arrow keys instantly.">
      <Card>
        <div className="grid grid-cols-3 gap-x-6 gap-y-5">
          <Select label="Base currency" value={cur} onValueChange={setCur} options={currencies} />
          <Select
            label="Status"
            value={status}
            onValueChange={setStatus}
            placeholder="No status"
            options={[
              { value: "todo", label: "To do", render: <Tag color="gray">To do</Tag> },
              { value: "doing", label: "In progress", render: <Tag color="blue">In progress</Tag> },
              { value: "done", label: "Done", render: <Tag color="green">Done</Tag> },
            ]}
          />
          <DatePicker label="Due date" value={date} onChange={setDate} />
          <div className="col-span-2">
            <Combobox
              label="Tags"
              value={tags}
              onValueChange={setTags}
              options={tagOpts}
              onCreate={(l) => {
                const v = l.toLowerCase().replace(/\s+/g, "-");
                setTagOpts((o) => [...o, { value: v, label: l, color: "pink" }]);
                return v;
              }}
            />
          </div>
          <Select label="Disabled" value={null} onValueChange={() => {}} options={[]} disabled placeholder="Unavailable" />
          <ColorPicker label="Text colour" value={color} onChange={setColor} mode="text" />
          <ColorPicker label="Background" value={bg} onChange={setBg} mode="background" />
          <div className="flex items-end">
            <IconPicker value={pickedIcon} onSelect={(n) => setPickedIcon(n)}>
              <Button variant="secondary" icon={<Glyph name={pickedIcon} context="row" />}>
                Icon picker
              </Button>
            </IconPicker>
          </div>
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Controls ─────────────── */
function Controls() {
  const [a, setA] = useState(true);
  const [b, setB] = useState(false);
  const [c, setC] = useState<boolean | "indeterminate">("indeterminate");
  const [sw1, setSw1] = useState(true);
  const [sw2, setSw2] = useState(false);
  const [radio, setRadio] = useState("standard");
  const [vol, setVol] = useState([62]);
  const [range, setRange] = useState([20, 75]);
  return (
    <Section id="controls" title="Checkbox, radio, switch, slider" lead="A checked box fills with ink and draws its tick in 120ms; a switch thumb is a paper key that travels in 140ms; slider fills are ink.">
      <Card>
        <div className="grid grid-cols-4 gap-6">
          <div className="flex flex-col gap-3">
            <Checkbox checked={a} onCheckedChange={setA} label="Round-ups" description="Sweep spare change to savings" />
            <Checkbox checked={b} onCheckedChange={setB} label="Unchecked" />
            <Checkbox checked={c} onCheckedChange={(v) => setC(v)} label="Indeterminate" />
            <Checkbox checked disabled label="Disabled" />
          </div>
          <RadioGroup
            value={radio}
            onValueChange={setRadio}
            aria-label="KDF profile"
            options={[
              { value: "standard", label: "Standard", description: "≈0.7s unlock" },
              { value: "high", label: "High", description: "≈1.4s unlock" },
              { value: "legacy", label: "Legacy", disabled: true },
            ]}
          />
          <div className="flex flex-col gap-3">
            <Switch checked={sw1} onCheckedChange={setSw1} label="Auto-lock" description="After 15 minutes idle" />
            <Switch checked={sw2} onCheckedChange={setSw2} label="Celebrations" />
            <Switch size="sm" checked={sw1} onCheckedChange={setSw1} label="Small switch" />
            <Switch disabled label="Disabled" />
          </div>
          <div className="flex flex-col gap-6 pt-6">
            <Slider value={vol} onValueChange={setVol} aria-label="Savings rate" formatValue={(v) => `${v}%`} />
            <Slider value={range} onValueChange={setRange} aria-label="Range" formatValue={(v) => `$${v}k`} />
            <Slider defaultValue={[40]} disabled aria-label="Disabled" />
          </div>
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Navigation ─────────────── */
function Navigation() {
  const [seg, setSeg] = useState("month");
  const [view, setView] = useState("table");
  const [tab, setTab] = useState("overview");
  return (
    <Section id="navigation" title="Tabs & segmented" lead="Selection is instant. Tabs are a hairline with a 2px ink underline; the segmented thumb is a paper key on a flat bed.">
      <Card>
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-4">
            <Segmented
              aria-label="Range"
              value={seg}
              onValueChange={setSeg}
              options={[
                { value: "week", label: "1W" },
                { value: "month", label: "1M" },
                { value: "quarter", label: "3M" },
                { value: "year", label: "1Y" },
                { value: "all", label: "All" },
              ]}
            />
            <Segmented
              size="sm"
              aria-label="View"
              value={view}
              onValueChange={setView}
              options={[
                { value: "table", icon: Table2, label: "Table" },
                { value: "board", icon: LayoutGrid, label: "Board" },
                { value: "list", icon: List, label: "List" },
              ]}
            />
          </div>
          <Tabs
            aria-label="Sections"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "overview", label: "Overview" },
              { value: "transactions", label: "Transactions", count: 248 },
              { value: "budgets", label: "Budgets" },
              { value: "insights", label: "Insights", icon: Lightbulb },
              { value: "archived", label: "Archived", disabled: true },
            ]}
            trailing={<IconButton size="sm" icon={Plus} label="Add view" />}
          />
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Overlays ─────────────── */
function Overlays() {
  const [dlg, setDlg] = useState(false);
  const [alert, setAlert] = useState(false);
  const [typed, setTyped] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [showHidden, setShowHidden] = useState(true);
  const [sort, setSort] = useState("updated");
  return (
    <Section id="overlays" title="Menus, popovers, dialogs, sheets" lead="Things you summon float: opaque paper, a 1px warm ring and a soft layer. Mouse-opened menus grow from their trigger in 120ms; keyboard-opened ones appear at once. Dialogs settle in 160ms.">
      <Card>
        <div className="flex flex-wrap gap-3">
          <Menu>
            <MenuTrigger asChild>
              <Button variant="secondary" iconRight={MoreHorizontal}>
                Page menu
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={Star} shortcut="mod+shift+f">
                Add to favorites
              </MenuItem>
              <MenuItem icon={Copy} shortcut="mod+d">
                Duplicate
              </MenuItem>
              <MenuItem icon={Pencil} shortcut="f2">
                Rename
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger icon={Download}>Export</MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem icon={FileText}>PDF</MenuItem>
                  <MenuItem icon={FileText}>Markdown</MenuItem>
                  <MenuItem icon={Table2}>CSV</MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              <MenuLabel>View</MenuLabel>
              <MenuCheckboxItem checked={showHidden} onCheckedChange={setShowHidden}>
                Show hidden properties
              </MenuCheckboxItem>
              <MenuRadioGroup value={sort} onValueChange={setSort}>
                <MenuRadioItem value="updated">Sort by last edited</MenuRadioItem>
                <MenuRadioItem value="title">Sort by title</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem icon={Lock} disabled>
                Lock page
              </MenuItem>
              <MenuItem icon={Trash2} destructive shortcut="backspace">
                Move to trash
              </MenuItem>
            </MenuContent>
          </Menu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" icon={CalendarIcon}>
                Popover form
              </Button>
            </PopoverTrigger>
            <PopoverContent form>
              <div className="flex flex-col gap-3 w-[280px]">
                <span className="text-title">Remind me</span>
                <Input label="When" defaultValue="tomorrow 9am" />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost">
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary">
                    Set reminder
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Tooltip content="Encrypted · Locks in 12 min" shortcut="mod+shift+l">
            <Button variant="ghost" icon={Lock}>
              Hover for tooltip
            </Button>
          </Tooltip>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="h-8 px-3 rounded-md flex items-center text-body-sm text-secondary" style={{ border: "1px dashed var(--border-strong)" }}>
                Right-click me
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem icon={Copy} shortcut="mod+c">
                Copy
              </ContextMenuItem>
              <ContextMenuItem icon={Archive}>Archive</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem icon={Trash2} destructive>
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          <Button variant="secondary" onClick={() => setDlg(true)}>
            Open dialog
          </Button>
          <Button variant="destructive-ghost" onClick={() => setAlert(true)}>
            Alert dialog
          </Button>
          <Button variant="secondary" onClick={() => setTyped(true)}>
            Type-to-confirm
          </Button>
          <Button variant="secondary" onClick={() => setSheet(true)}>
            Open sheet
          </Button>
        </div>
      </Card>
      <Dialog
        open={dlg}
        onOpenChange={setDlg}
        title="Rename workspace"
        description="This is how the workspace appears in the sidebar and on the lock screen."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDlg(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setDlg(false)} kbd="enter">
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Name" defaultValue="Personal" />
          <Select
            label="Icon colour"
            value="blue"
            onValueChange={() => {}}
            options={["gray", "blue", "green", "orange", "purple"].map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1), render: <Tag color={c as never}>{c}</Tag> }))}
          />
        </div>
      </Dialog>
      <AlertDialog
        open={alert}
        onOpenChange={setAlert}
        tone="danger"
        title="Move “Q3 Budget” to trash?"
        description="It stays in Trash for 30 days. Linked databases keep their rows."
        confirmLabel="Move to trash"
        onConfirm={() => new Promise((r) => setTimeout(r, 700)).then(() => toast({ title: "Moved to trash", action: { label: "Undo", onClick: () => toast.success("Restored") } }))}
      />
      <AlertDialog
        open={typed}
        onOpenChange={setTyped}
        tone="warning"
        title="Disable encryption?"
        description="Your vault will be decrypted and stored as plain JSON on this device."
        confirmText="DECRYPT"
        confirmLabel="Disable encryption"
        onConfirm={() => toast.warning("Encryption disabled")}
      />
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Connect Google"
        description="Use your own OAuth client. Nothing ships in the binary."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(false)}>
              Cancel
            </Button>
            <Button variant="primary">Continue</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Stepper total={4} current={1} />
          <Input label="Client ID" placeholder="1234-abc.apps.googleusercontent.com" />
          <SecretField label="Client secret" />
          <Banner tone="info" inline>
            Tokens are stored encrypted in your vault.
          </Banner>
        </div>
      </Sheet>
    </Section>
  );
}

/* ─────────────── Feedback ─────────────── */
function Feedback() {
  const [loading, setLoading] = useState(false);
  return (
    <Section id="feedback" title="Toasts, banners, empty states, skeletons" lead="Toasts are opaque paper, in 150ms and out 100ms. Banners are flat tinted bands. Empty states are a line glyph, a sentence and at most one key.">
      <Card>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => toast.success("Imported 248 transactions", { description: "6 duplicates skipped · 12 rules applied" })}>
            Success toast
          </Button>
          <Button variant="secondary" onClick={() => toast("Snapshot saved")}>
            Info toast
          </Button>
          <Button variant="secondary" onClick={() => toast.warning("Market data is delayed", { description: "Showing prices cached 14 minutes ago." })}>
            Warning toast
          </Button>
          <Button variant="secondary" onClick={() => toast.error("Couldn't reach stooq.com", { description: "You're offline. We'll retry when you reconnect." })}>
            Error toast
          </Button>
          <Button variant="secondary" onClick={() => toast({ title: "Page moved to trash", action: { label: "Undo", onClick: () => toast.success("Restored") } })}>
            Toast with action
          </Button>
          <Button variant="secondary" icon={Copy} onClick={() => toast.clipboard(30, () => toast.success("Clipboard cleared"))}>
            Clipboard toast
          </Button>
          <Button
            variant="soft"
            icon={Check}
            onClick={(e) => {
              celebrate(e.currentTarget);
            }}
          >
            Celebrate
          </Button>
        </div>
      </Card>
      <div className="flex flex-col gap-3">
        <Banner tone="warning" action={<Button size="xs" variant="ghost">Strengthen</Button>} onDismiss={() => {}}>
          Your vault uses a below-standard key derivation profile.
        </Banner>
        <Banner tone="danger" inline>
          Integrity check found 2 damaged records.
        </Banner>
        <Banner tone="success" inline>
          Backup completed · 42 MB
        </Banner>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <EmptyState icon={Wallet} title="Track every dollar, automatically" body="Import a bank CSV or start with a guided budget. Everything stays on this device." lifeApp={{ onSetup: () => {}, onBlank: () => {} }} />
        </Card>
        <Card title="Skeleton → content" actions={<Button size="xs" variant="ghost" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1400); }}>Reload</Button>}>
          <SkeletonSwap
            loading={loading}
            skeleton={
              <div className="flex gap-3 items-start">
                <Skeleton width={36} height={36} shape="circle" />
                <div className="flex-1">
                  <SkeletonText lines={3} />
                </div>
              </div>
            }
          >
            <div className="flex gap-3 items-start">
              <Avatar name="Maya Okafor" size={32} />
              <div className="flex-1 text-body text-secondary">
                <span className="text-primary font-medium">Maya Okafor</span> shared “Household budget 2026” and added 3 categories to Groceries.
              </div>
            </div>
          </SkeletonSwap>
          <div className="flex flex-col gap-2 mt-2">
            <Skeleton height={10} width="80%" />
            <Skeleton height={10} width="64%" />
          </div>
        </Card>
      </div>
      <Card>
        <EmptyState hero icon={Search} title="No results for “Quarterly”" body="Try fewer words, or search inside databases with #." actions={<Button variant="secondary">Clear search</Button>} />
      </Card>
    </Section>
  );
}

/* ─────────────── Cards & KPIs ─────────────── */
function DataSection() {
  const [nw, setNw] = useState(184_230.42);
  const spark = [12, 14, 13, 15, 17, 16, 18, 21, 20, 23, 22, 25, 27, 26, 29];
  const spark2 = [30, 28, 29, 27, 26, 27, 24, 25, 23, 21, 22, 19];
  const [price, setPrice] = useState(212.48);
  useEffect(() => {
    const iv = window.setInterval(() => setPrice((p) => +(p + (Math.random() - 0.48) * 1.6).toFixed(2)), 1800);
    return () => window.clearInterval(iv);
  }, []);
  return (
    <Section id="data" title="Cards, KPI tiles, money" lead="Ruled, not boxed: a card is a section with a 14/600 head over a hairline, framed only when it is the one container in view. KPI figures are labelled numbers, final from the first frame.">
      <div className="grid grid-cols-4 gap-4">
        <KpiTile label="Net worth" value={{ amount: nw.toFixed(2), currency: "USD" }} delta={{ value: 0.042 }} spark={spark} info="Assets minus liabilities, in USD" onClick={() => toast("Net worth")} />
        <KpiTile label="Spent this month" value={{ amount: "3412.18", currency: "USD" }} noCents delta={{ value: 0.083, invert: true }} spark={spark.map((v, i) => v + Math.sin(i) * 3)} sparkColor="accent" />
        <KpiTile label="Savings rate" value={0.274 * 100} format={(n) => `${n.toFixed(1)}%`} delta={{ value: -0.012, label: "vs 3-mo avg" }} spark={spark2} />
        <KpiTile label="Portfolio" value={{ amount: "96120.00", currency: "EUR" }} stale="Prices from 14 min ago" delta={{ value: -0.0061, label: "today" }} spark={spark2} />
      </div>
      <div className="grid grid-cols-4 gap-4">
        <KpiTile label="Loading" value={null} loading delta={{ value: 0 }} spark={[]} />
        <KpiTile label="Big number" size="xl" value={{ amount: "1204500.00", currency: "USD" }} noCents />
        <Card interactive light tilt onClick={() => toast("Card clicked")} title="Interactive card" subtitle="Lifts 2px · edge light · presses to .99">
          <span className="text-body text-secondary">Opens the account detail in a side peek.</span>
        </Card>
        <Card title="Live price" subtitle="Flash ≤ 1/s per symbol">
          <div className="flex items-baseline gap-2">
            <span className="text-h2">
              <PriceFlash value={price} symbol="EMPX">
                ${price.toFixed(2)}
              </PriceFlash>
            </span>
            <DeltaPill value={(price - 210) / 210} />
          </div>
        </Card>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex flex-col gap-1">
            <span className="text-caption text-tertiary">Rolling number</span>
            <span className="text-kpi">
              <RollingNumber value={nw} format={(n) => formatCurrency(n, "USD")} sensitive />
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setNw((v) => +(v + (Math.random() * 4000 - 1500)).toFixed(2))}>
            Randomise
          </Button>
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-tertiary">Deltas</span>
            <div className="flex gap-2">
              <DeltaPill value={0.124} />
              <DeltaPill value={-0.031} />
              <DeltaPill value={0} />
              <DeltaPill value={0.05} invert label="vs budget" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-tertiary">Amounts</span>
            <div className="flex gap-4 text-body">
              <Amount value={{ amount: "1204.5", currency: "USD" }} />
              <Amount value={{ amount: "-340.00", currency: "USD" }} colored />
              <Amount value={{ amount: "89.99", currency: "EUR" }} colored signed />
              <Amount value={{ amount: "0.03481200", currency: "BTC" }} />
              <Amount value={{ amount: "15230.75", currency: "USD" }} dimCents />
            </div>
          </div>
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Status ─────────────── */
function Status() {
  const [p, setP] = useState(0.42);
  return (
    <Section id="status" title="Progress, rings, budgets, spinners" lead="Flat 4px tracks with ink fills. Rings are for small progress only; Money, Portfolio and Tax use 4px bars. Budget bars turn loss past 100%.">
      <Card>
        <div className="grid gap-8" style={{ gridTemplateColumns: "1fr 1.2fr 1.3fr" }}>
          <div className="flex flex-col gap-4">
            <Progress value={p} size={2} aria-label="2px" />
            <Progress value={p} aria-label="4px" />
            <Progress value={p} size={8} aria-label="8px" />
            <Progress indeterminate aria-label="Indeterminate" />
            <div className="flex gap-2">
              <Button size="xs" variant="secondary" onClick={() => setP((v) => Math.max(0, v - 0.15))}>
                −
              </Button>
              <Button size="xs" variant="secondary" onClick={() => setP((v) => Math.min(1, v + 0.15))}>
                +
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-5">
            {[
              ["Groceries", 412, 650],
              ["Dining out", 318, 380],
              ["Shopping", 486, 400],
            ].map(([n, s, b]) => (
              <div key={n as string} className="flex flex-col gap-1.5">
                <div className="flex justify-between text-body-sm">
                  <span>{n}</span>
                  <span className="tabular text-secondary">
                    <Amount value={{ amount: String(s), currency: "USD" }} noCents /> <span className="text-tertiary">of ${b}</span>
                  </span>
                </div>
                <BudgetProgress spent={s as number} budget={b as number} pace={0.84} />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-end gap-3 flex-nowrap">
              {([16, 24, 40, 64, 96] as const).map((s) => (
                <Ring key={s} size={s} value={p} aria-label={`Ring ${s}`}>
                  {s >= 64 ? <span className={s === 96 ? "text-h3" : "text-body-sm font-semibold"}>{Math.round(p * 100)}%</span> : null}
                </Ring>
              ))}
            </div>
            <div className="flex items-center gap-4">
              <Spinner size={16} label="Loading" />
              <Spinner size={24} />
              <StrengthMeter score={1} showLabel className="w-28" />
              <StrengthMeter score={3} showLabel className="w-28" />
            </div>
            <Stepper total={5} current={2} />
          </div>
        </div>
      </Card>
    </Section>
  );
}

/* ─────────────── Misc ─────────────── */
function Misc() {
  return (
    <Section id="misc" title="Tags, badges, avatars, keys, drop zone">
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <Row label="Badges">
            <Badge>Default</Badge>
            <Badge tone="accent">Accent</Badge>
            <Badge tone="solid">Solid</Badge>
            <Badge tone="gain" dot>
              Synced
            </Badge>
            <Badge tone="loss">Overdue</Badge>
            <Badge tone="warning">Stale</Badge>
            <Badge tone="info">Beta</Badge>
            <Badge tone="outline">Outline</Badge>
          </Row>
          <Row label="Tags">
            <Tag color="green">Groceries</Tag>
            <Tag color="blue" onRemove={() => {}}>
              Recurring
            </Tag>
            <Tag color="purple" onRemove={() => {}} removeOnHover>
              Hover to remove
            </Tag>
            <Tag color="orange">Travel</Tag>
            <Tag color="red">Urgent</Tag>
            <Tag color="yellow">Waiting</Tag>
          </Row>
          <Row label="Avatars">
            {([16, 20, 24, 32, 40, 64] as const).map((s) => (
              <Avatar key={s} name="Devin Artin" size={s} />
            ))}
            <Avatar name="Workspace" glyph={<House size={16} strokeWidth={1.25} absoluteStrokeWidth aria-hidden />} shape="square" size={32} />
            <AvatarStack size={24}>
              <Avatar name="Ana Lima" />
              <Avatar name="Kenji Mori" />
              <Avatar name="Sam Ortiz" />
            </AvatarStack>
          </Row>
          <Row label="Keys">
            <Kbd keys="mod+k" />
            <Kbd keys="mod+shift+l" />
            <Kbd keys="mod+alt+d" />
            <Kbd keys="esc" />
            <Kbd keys="arrowup" />
          </Row>
        </Card>
        <Card>
          <FileDropZone title="Drop a bank export" hint="CSV, OFX, QFX or QIF · up to 50 MB" accept={[".csv", ".ofx", ".qfx", ".qif"]} onBrowse={() => toast("Opening file picker…")} onFiles={(f) => toast.success(`Got ${f.length} file(s)`)} />
          <div className="grid grid-cols-2 gap-3">
            <ChoiceCardDemo />
          </div>
        </Card>
      </div>
    </Section>
  );
}

function ChoiceCardDemo() {
  const [v, setV] = useState("guided");
  return (
    <>
      <ChoiceCard selected={v === "guided"} onSelect={() => setV("guided")} icon={ListChecks} title="Guided" description="Six questions, then the pages are set up for you." recommended />
      <ChoiceCard selected={v === "blank"} onSelect={() => setV("blank")} icon={FileText} title="Start blank" description="An empty workspace you shape yourself." />
    </>
  );
}
