/**
 * Import wizard (§15.2): file → sniff (CSV / OFX / QFX / QIF, saved profiles) → column mapping with a live parsed
 * preview → review with dedupe (exact skipped, possible duplicates in a review lane), transfer pairs and
 * categorisation (rule / learned / none, overridable) → rules & profile → import with progress.
 */
import { AlertTriangle, ArrowLeftRight, ArrowRight, Check, ChevronLeft, Copy, FileSpreadsheet, FileUp, Wand2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { FinanceImportPreview, FinanceImportStart, Id, ImportMapping } from "@/backend/types";
import { cn } from "@/lib/cn";
import { notify } from "@/stores/toasts";
import { Amount } from "@/ui/Amount";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { FileDropZone } from "@/ui/FileDropZone";
import { Input } from "@/ui/Input";
import { RollingNumber } from "@/ui/motion/RollingNumber";
import { SlabGlyph } from "@/ui/SlabGlyph";
import { Progress, Stepper } from "@/ui/Progress";
import { Segmented } from "@/ui/Segmented";
import { Select } from "@/ui/Select";
import { Sheet } from "@/ui/Sheet";
import { Spinner } from "@/ui/Spinner";
import { Switch } from "@/ui/Switch";
import { Tooltip } from "@/ui/Tooltip";
import { dayLabel, fmtMoney, num, toMoney, todayIso } from "../shared/format";
import { rememberStatement } from "../shared/statements";
import type { FinanceImportFile } from "./request";
import { Sensitive } from "@/ui/Sensitive";
import { Glyph } from "../shared/ui";
import { useLedgerCtx, type Ledger } from "../MoneyHQ/ledger";
import { CategoryPicker } from "../MoneyHQ/Transactions";

type Step = "file" | "map" | "review" | "rules" | "import";
const STEPS: Step[] = ["file", "map", "review", "rules", "import"];
const TITLES: Record<Step, string> = { file: "Choose a statement", map: "Match the columns", review: "Review transactions", rules: "Rules & profile", import: "Import" };
type Role = "date" | "amount" | "debit" | "credit" | "payee" | "memo" | "balance" | "ignore";
const ROLE_LABEL: Record<Role, string> = { date: "Date", amount: "Amount", debit: "Money out", credit: "Money in", payee: "Payee", memo: "Memo", balance: "Balance", ignore: "Ignore" };
const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY", "D MMM YYYY", "MM/DD'YY", "excel"];

export default function ImportWizard({ instanceId, open, onOpenChange, initialFile }: { instanceId: Id; open: boolean; onOpenChange: (o: boolean) => void; initialFile?: FinanceImportFile }) {
  const l = useLedgerCtx();
  const [step, setStep] = useState<Step>("file");
  const [start, setStart] = useState<FinanceImportStart | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [accountId, setAccountId] = useState<Id | null>(null);
  const [preview, setPreview] = useState<FinanceImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [overrides, setOverrides] = useState<Record<number, { categoryId?: Id }>>({});
  const [profileName, setProfileName] = useState("");
  const [saveProfile, setSaveProfile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ inserted: number; skipped: number; transfersLinked: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  const [fileName, setFileName] = useState<string | undefined>(initialFile?.displayName);
  const startWith = async (file: FinanceImportFile) => {
    setError(null);
    setBusy(true);
    try {
      const s = await api.finance.importStart({ instanceId, grantId: file.grantId });
      setStart(s);
      setMapping(s.mappingGuess);
      setAccountId(s.accountGuess ?? null);
      setFileName(file.displayName);
      setProfileName(s.profileMatch?.name ?? file.displayName.replace(/\.[a-z]+$/i, ""));
      setStep(s.profileMatch ? "review" : "map");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file");
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    setError(null);
    try {
      const grants = await api.file.pick({ purpose: "import", filters: [{ name: "Bank statements", extensions: ["csv", "tsv", "txt", "ofx", "qfx", "qif"] }], multiple: false });
      if (!grants.length) return;
      await startWith({ grantId: grants[0].grantId, displayName: grants[0].displayName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that file");
    }
  };
  // Opened from the shell's Import (or ⌘K) with a file already chosen: start from it.
  const started = useRef(false);
  useEffect(() => {
    if (!initialFile || started.current) return;
    started.current = true;
    void startWith(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // Live preview whenever the mapping or account changes (debounced).
  const key = JSON.stringify({ mapping, accountId, id: start?.importId });
  useEffect(() => {
    if (!start || !mapping || !accountId) return;
    let live = true;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const p = await api.finance.importPreview({ importId: start.importId, mapping, accountId });
        if (!live) return;
        setPreview(p);
        // Exact duplicates are skipped; possible duplicates start skipped too, awaiting review.
        setSkip(new Set(p.rows.filter((r) => r.duplicateOf || r.possibleDuplicate).map((r) => r.idx)));
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Couldn't parse with this mapping");
      } finally {
        if (live) setPreviewing(false);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const commit = async () => {
    if (!start || !mapping || !accountId) return;
    setStep("import");
    setProgress({ done: 0, total: preview?.rows.length ?? 1 });
    try {
      const job = await api.finance.importCommit({
        importId: start.importId,
        mapping,
        accountId,
        skip: [...skip],
        overrides,
        saveProfileAs: saveProfile && profileName.trim() ? profileName.trim() : undefined,
        onEvent: (e) => {
          if (e.kind === "progress" && e.total) setProgress({ done: e.done, total: e.total });
        },
      });
      const r = await job.result;
      setResult(r);
      // The file's own closing balance, kept for the reconcile dialog (labelled with its source and date there).
      if (preview?.statement) void rememberStatement(accountId, { ...preview.statement, fileName, importedOn: todayIso() });
      // A chore, not a moment: no confetti (K3). The result line below is the confirmation.
      notify.success(`${r.inserted.toLocaleString()} ${r.inserted === 1 ? "row" : "rows"} imported`, { description: l.acct.get(accountId)?.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setStep("rules");
    }
  };

  const idx = STEPS.indexOf(step);
  const footer = (
    <div className="flex items-center gap-2 w-full">
      {step !== "file" && step !== "import" ? (
        <Button variant="ghost" icon={ChevronLeft} onClick={() => setStep(STEPS[Math.max(0, idx - 1)])}>
          Back
        </Button>
      ) : null}
      <span className="flex-1" />
      {step === "map" ? (
        <Button variant="primary" iconRight={ArrowRight} disabled={!preview || !preview.rows.length || !accountId} onClick={() => setStep("review")}>
          Review {preview ? preview.rows.length : ""} rows
        </Button>
      ) : step === "review" ? (
        <Button variant="primary" iconRight={ArrowRight} disabled={!preview} onClick={() => setStep("rules")}>
          Continue
        </Button>
      ) : step === "rules" ? (
        <Button variant="primary" icon={FileUp} onClick={commit} disabled={!preview}>
          Import {preview ? preview.rows.length - skip.size : ""} transactions
        </Button>
      ) : step === "import" && result ? (
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      ) : null}
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="wizard" title="Import transactions" description={TITLES[step]} footer={footer} dismissible={step !== "import" || !!result}>
      <div className="flex flex-col gap-5">
        <Stepper total={STEPS.length} current={result ? STEPS.length : idx} />
        {error ? (
          <div className="fh-alert" data-tone="warn">
            <AlertTriangle size={16} />
            <span className="text-body-sm">{error}</span>
          </div>
        ) : null}
        {/* Steps swap at once (K3 C0): input never waits on a transition. */}
        <div key={step}>
            {step === "file" ? (
              <div className="flex flex-col gap-4">
                <FileDropZone title={busy ? "Reading the statement…" : "Drop a bank statement or click to choose"} hint="CSV, OFX, QFX or QIF · nothing leaves this device" progress={busy ? null : undefined} onBrowse={() => void pick()} onFiles={() => void pick()} disabled={busy} />
                <ul className="fh-notes">
                  {[
                    { t: "Sniffs the format", d: "CSV delimiters, OFX 1 & 2, QFX and QIF are detected automatically." },
                    { t: "Never double-counts", d: "Exact repeats are skipped; near-matches wait for your review." },
                    { t: "Learns as you go", d: "Rules and past choices categorise most rows for you." },
                  ].map((x) => (
                    <li key={x.t}>
                      <span className="text-body-sm font-semibold">{x.t}</span>
                      <span className="text-body-sm text-secondary"> {x.d}</span>
                    </li>
                  ))}
                </ul>
                {busy ? (
                  <div className="flex items-center gap-2 text-body-sm text-secondary">
                    <Spinner /> Sniffing the file…
                  </div>
                ) : null}
              </div>
            ) : null}

            {step === "map" && start && mapping ? (
              <MapStep start={start} mapping={mapping} setMapping={setMapping} accountId={accountId} setAccountId={setAccountId} accounts={l.accounts.map((a) => ({ value: a.id, label: a.name }))} preview={preview} previewing={previewing} />
            ) : null}

            {step === "review" && preview ? (
              <ReviewStep preview={preview} skip={skip} setSkip={setSkip} overrides={overrides} setOverrides={setOverrides} ledger={l} />
            ) : null}

            {step === "rules" && preview && start ? (
              <div className="flex flex-col gap-4">
                <Summary preview={preview} skip={skip} />
                <div className="fh-card">
                  <div className="flex items-center gap-3">
                    <Switch checked={saveProfile} onCheckedChange={setSaveProfile} aria-label="Save mapping as a profile" />
                    <div className="flex-1">
                      <div className="text-body-sm font-medium">Remember this layout</div>
                      <div className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
                        Next time a file with these columns arrives, the mapping and account are applied automatically.
                      </div>
                    </div>
                  </div>
                  {saveProfile ? <Input className="mt-3" label="Profile name" value={profileName} onChange={(e) => setProfileName(e.target.value)} /> : null}
                </div>
                <RuleSuggestions preview={preview} instanceId={instanceId} ledger={l} overrides={overrides} />
              </div>
            ) : null}

            {step === "import" ? (
              <div className="flex flex-col items-center text-center gap-4 py-10" ref={doneRef}>
                {result ? (
                  <>
                    <span className="fh-done-badge">
                      <Check size={30} strokeWidth={3} />
                    </span>
                    <div className="text-h3 tabular fh-baseline">
                      Imported {result.inserted.toLocaleString()} {result.inserted === 1 ? "transaction" : "transactions"}
                    </div>
                    <div className="text-body text-secondary max-w-[420px]">
                      {result.skipped ? `${result.skipped} skipped as duplicates. ` : ""}
                      {result.transfersLinked ? `${result.transfersLinked} linked as transfers between your accounts.` : ""}
                    </div>
                    {preview?.statement && accountId ? (
                      <div className="text-body-sm text-secondary tabular">
                        Statement balance <Sensitive>{fmtMoney(preview.statement.balance, preview.statement.currency)}</Sensitive>
                        {preview.statement.asOf ? ` on ${dayLabel(preview.statement.asOf, true)}` : ""} · ready to reconcile in Accounts
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <SlabGlyph size={56} animate exploded />
                    <div className="text-title">Committing to your ledger…</div>
                    <div className="w-[360px]">
                      <Progress value={progress ? progress.done / Math.max(1, progress.total) : 0} size={8} aria-label="Import progress" />
                    </div>
                    <div className="text-caption text-tertiary tabular" style={{ fontWeight: 400 }}>
                      {progress ? (
                        <>
                          <RollingNumber value={progress.done} format={(n) => Math.round(n).toLocaleString()} countUp={false} /> of {progress.total.toLocaleString()}
                        </>
                      ) : (
                        ""
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}
        </div>
      </div>
    </Sheet>
  );
}

function MapStep({ start, mapping, setMapping, accountId, setAccountId, accounts, preview, previewing }: { start: FinanceImportStart; mapping: ImportMapping; setMapping: (m: ImportMapping) => void; accountId: Id | null; setAccountId: (id: Id) => void; accounts: { value: string; label: string }[]; preview: FinanceImportPreview | null; previewing: boolean }) {
  const cols = start.columns ?? start.sample[0]?.map((_, i) => `Column ${i + 1}`) ?? [];
  const roleOf = (i: number): Role => {
    for (const r of ["date", "amount", "debit", "credit", "payee", "memo", "balance"] as Role[]) if ((mapping as unknown as Record<string, unknown>)[r] === i) return r;
    return "ignore";
  };
  const setRole = (i: number, role: Role) => {
    const next = { ...mapping } as ImportMapping & Record<string, unknown>;
    for (const r of ["date", "amount", "debit", "credit", "payee", "memo", "balance"]) if (next[r] === i) delete next[r];
    if (role !== "ignore") next[role] = i;
    if (role === "amount") {
      delete next.debit;
      delete next.credit;
    }
    if (role === "debit" || role === "credit") delete next.amount;
    setMapping(next);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="accent" icon={FileSpreadsheet}>
          {start.format.toUpperCase()}
        </Badge>
        <span className="text-body-sm text-secondary">
          {start.rowCount.toLocaleString()} rows · {start.encoding}
        </span>
        {start.profileMatch ? <Badge tone="neutral">Profile: {start.profileMatch.name}</Badge> : null}
        {previewing ? <Spinner size={14} className="ml-auto" /> : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Import into" value={accountId} onValueChange={setAccountId} options={accounts} />
        <Select label="Date format" value={mapping.dateFormat ?? "YYYY-MM-DD"} onValueChange={(v) => setMapping({ ...mapping, dateFormat: v })} options={DATE_FORMATS.map((f) => ({ value: f, label: f === "excel" ? "Excel serial number" : f }))} />
      </div>
      <div className="flex items-center gap-6">
        <Switch size="sm" checked={mapping.invert} onCheckedChange={(v) => setMapping({ ...mapping, invert: v })} label="Flip signs (card exports list purchases as positive)" />
        <Switch size="sm" checked={mapping.decimalComma} onCheckedChange={(v) => setMapping({ ...mapping, decimalComma: v })} label="Decimal comma (1.234,56)" />
      </div>
      <div className="fh-map">
        <table className="fh-table">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} style={{ textTransform: "none", letterSpacing: 0 }}>
                  <div className="flex flex-col gap-1.5 py-2">
                    <span className="text-caption text-tertiary truncate" style={{ fontWeight: 500 }}>
                      {c}
                    </span>
                    <Select size="sm" value={roleOf(i)} onValueChange={(v) => setRole(i, v as Role)} options={(Object.keys(ROLE_LABEL) as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} aria-label={`Use column ${c} as`} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {start.sample.slice(0, 6).map((r, i) => (
              <tr key={i}>
                {cols.map((_, j) => (
                  <td key={j} className={cn("text-secondary fh-cell-role", roleOf(j) === "ignore" && "opacity-40")} data-role={roleOf(j)} style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", transition: "opacity 200ms var(--ease-out)" }}>
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-caption text-secondary mb-2" style={{ fontWeight: 500 }}>
          How Ultra Note reads it
        </div>
        <div className="fh-parsed">
          {(preview?.rows ?? []).slice(0, 4).map((r) => (
            <div key={`${r.idx}:${r.payee}:${r.amount}`} className="flex items-center gap-3 text-body-sm">
              <Check size={14} absoluteStrokeWidth strokeWidth={1.25} className="flex-none text-secondary" />
              <span className="w-[86px] text-tertiary tabular">{dayLabel(r.date, true)}</span>
              <span className="flex-1 truncate font-medium">{r.payee}</span>
              <Amount value={toMoney(r.amount)} signed={num(r.amount) > 0} align="end" />
            </div>
          ))}
          {!preview?.rows.length ? <div className="text-body-sm text-tertiary">Pick at least a date, an amount and a payee column.</div> : null}
        </div>
      </div>
    </div>
  );
}

function Summary({ preview, skip }: { preview: FinanceImportPreview; skip: Set<number> }) {
  const transfers = preview.rows.filter((r) => r.transferPair).length;
  const possible = preview.rows.filter((r) => r.possibleDuplicate).length;
  const items = [
    { n: preview.rows.length - skip.size, l: "to import", tone: "accent" },
    { n: preview.duplicates, l: "exact duplicates skipped", tone: "neutral" },
    { n: possible, l: "possible duplicates", tone: possible ? "warning" : "neutral" },
    { n: transfers, l: "transfers detected", tone: "neutral" },
    { n: preview.categorized, l: "auto-categorised", tone: "gain" },
  ];
  return (
    <div className="fh-import-sum">
      {items.map((x) => (
        <div key={x.l} className="fh-import-stat" data-tone={x.tone}>
          <span className="tabular">
            <RollingNumber value={x.n} format={(n) => Math.round(n).toLocaleString()} countUp={false} />
          </span>
          <span>{x.l}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewStep({ preview, skip, setSkip, overrides, setOverrides, ledger }: { preview: FinanceImportPreview; skip: Set<number>; setSkip: (s: Set<number>) => void; overrides: Record<number, { categoryId?: Id }>; setOverrides: (o: Record<number, { categoryId?: Id }>) => void; ledger: Ledger }) {
  const [lane, setLane] = useState<"all" | "review" | "transfers" | "uncat">("all");
  const rows = useMemo(
    () =>
      preview.rows.filter((r) => {
        if (lane === "review") return !!r.possibleDuplicate || !!r.duplicateOf;
        if (lane === "transfers") return !!r.transferPair;
        if (lane === "uncat") return !r.transferPair && !(overrides[r.idx]?.categoryId ?? r.categoryId);
        return true;
      }),
    [preview.rows, lane, overrides],
  );
  const toggle = (idx: number) => {
    const n = new Set(skip);
    if (n.has(idx)) n.delete(idx);
    else n.add(idx);
    setSkip(n);
  };
  const reviewCount = preview.rows.filter((r) => r.possibleDuplicate || r.duplicateOf).length;
  return (
    <div className="flex flex-col gap-3">
      <Summary preview={preview} skip={skip} />
      <Segmented
        size="sm"
        value={lane}
        onValueChange={setLane}
        aria-label="Show"
        options={[
          { value: "all", label: `All · ${preview.rows.length}` },
          { value: "review", label: `Duplicates · ${reviewCount}` },
          { value: "transfers", label: `Transfers · ${preview.rows.filter((r) => r.transferPair).length}` },
          { value: "uncat", label: "Uncategorised" },
        ]}
      />
      <div className="fh-review">
        {rows.slice(0, 400).map((r) => {
          const catId = overrides[r.idx]?.categoryId ?? r.categoryId;
          const cat = catId ? ledger.cat.get(catId) : undefined;
          const skipped = skip.has(r.idx);
          return (
            <div key={r.idx} className="fh-review-row" data-skipped={skipped ? "" : undefined}>
              <Checkbox checked={!skipped} onCheckedChange={() => toggle(r.idx)} aria-label={skipped ? "Include" : "Skip"} disabled={!!r.duplicateOf} />
              <span className="w-[64px] text-caption text-tertiary tabular">{dayLabel(r.date)}</span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-body-sm font-medium">{r.payee}</span>
                <span className="block truncate text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  {r.rawPayee}
                </span>
              </span>
              {r.duplicateOf ? (
                <Badge tone="neutral" icon={Copy}>
                  Already imported
                </Badge>
              ) : r.possibleDuplicate ? (
                <Tooltip content="Same amount within 3 days and a near-identical payee. Include it only if it's a separate purchase.">
                  <span tabIndex={0}>
                    <Badge tone="warning" icon={AlertTriangle}>
                      Possible duplicate
                    </Badge>
                  </span>
                </Tooltip>
              ) : r.transferPair ? (
                <Badge tone="info" icon={ArrowLeftRight}>
                  Transfer · linked
                </Badge>
              ) : (
                <CategoryPicker
                  categories={ledger.categories}
                  value={catId ?? null}
                  onChange={(c) => setOverrides({ ...overrides, [r.idx]: { categoryId: c ?? undefined } })}
                  trigger={
                    <button type="button" className="fh-chip" data-kind={cat ? "cat" : "none"} style={cat ? ({ "--chip-c": `var(--block-${cat.color}-text)`, "--chip-bg": `var(--block-${cat.color}-bg)` } as React.CSSProperties) : undefined}>
                      {cat ? <Glyph name={cat.icon} color={cat.color} size={14} className="!bg-transparent" /> : null}
                      <span className="truncate max-w-[130px]">{cat ? cat.name : "Categorise"}</span>
                      {cat && !overrides[r.idx] ? <span className="fh-conf" data-c={r.confidence}>{r.confidence === "rule" ? "rule" : r.confidence === "learned" ? "learned" : ""}</span> : null}
                    </button>
                  }
                />
              )}
              <span className="w-[96px] flex justify-end">
                <Amount value={toMoney(r.amount)} signed={num(r.amount) > 0} className="text-body-sm font-medium" align="end" />
              </span>
            </div>
          );
        })}
        {!rows.length ? <div className="py-10 text-center text-body-sm text-tertiary">Nothing in this lane.</div> : null}
      </div>
    </div>
  );
}

function RuleSuggestions({ preview, instanceId, ledger, overrides }: { preview: FinanceImportPreview; instanceId: Id; ledger: Ledger; overrides: Record<number, { categoryId?: Id }> }) {
  const [made, setMade] = useState<Set<string>>(new Set());
  const suggestions = useMemo(() => {
    const m = new Map<string, { payee: string; categoryId?: Id; n: number }>();
    for (const r of preview.rows) {
      if (r.transferPair || r.duplicateOf || r.confidence === "rule") continue;
      const c = overrides[r.idx]?.categoryId ?? r.categoryId;
      const e = m.get(r.payee) ?? { payee: r.payee, categoryId: c, n: 0 };
      e.n++;
      if (c) e.categoryId = c;
      m.set(r.payee, e);
    }
    return [...m.values()].filter((e) => e.n >= 2 && e.categoryId).sort((a, b) => b.n - a.n).slice(0, 6);
  }, [preview.rows, overrides]);
  const create = async (s: { payee: string; categoryId?: Id }) => {
    if (!s.categoryId) return;
    try {
      await api.finance.ruleUpsert({ instanceId, rule: { name: `${s.payee} → ${ledger.cat.get(s.categoryId)?.name ?? ""}`, priority: 20, when: { all: [{ field: "payee", op: "equals", value: s.payee }] }, then: { categoryId: s.categoryId }, continue: false } });
      setMade((x) => new Set(x).add(s.payee));
    } catch (e) {
      notify.fromError(e, "Couldn't create the rule");
    }
  };
  return (
    <div className="fh-card">
      <div className="flex items-center gap-2 mb-1">
        <Wand2 size={15} className="text-accent-text" />
        <span className="text-body-sm font-semibold">Turn repeats into rules</span>
      </div>
      <div className="text-caption text-tertiary mb-3" style={{ fontWeight: 400 }}>
        These payees appear more than once in this file. A rule categorises them automatically from now on.
      </div>
      {suggestions.length ? (
        <div className="flex flex-col gap-1.5">
          {suggestions.map((s) => {
            const cat = s.categoryId ? ledger.cat.get(s.categoryId) : undefined;
            const done = made.has(s.payee);
            return (
              <div key={s.payee} className="flex items-center gap-3 py-1">
                <Wand2 size={13} className="text-tertiary" />
                <span className="flex-1 text-body-sm">
                  <b>{s.payee}</b> <span className="text-tertiary">({s.n}×)</span> → {cat?.name}
                </span>
                <Button size="xs" variant={done ? "ghost" : "secondary"} icon={done ? Check : undefined} disabled={done} onClick={() => void create(s)}>
                  {done ? "Rule created" : "Create rule"}
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-body-sm text-tertiary">Every repeat is already covered by a rule.</div>
      )}
    </div>
  );
}
