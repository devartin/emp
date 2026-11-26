/**
 * Investment Policy Statement (§16.3): objectives, horizon, risk (education range), targets from the allocation,
 * rebalancing and contribution policy, "rules I follow when markets fall", review date and a signature line.
 * Saved per instance in kv `ui.portfolio`; printable.
 */
import { Check, Plus, Printer, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/backend";
import type { Id, PortfolioSummary } from "@/backend/types";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Segmented } from "@/ui/Segmented";
import { Textarea } from "@/ui/Textarea";
import { dayLabel, todayIso } from "../finance/shared/format";
import { Section } from "../finance/shared/ui";
import { CLASS_ORDER } from "./data";

interface IpsDoc {
  v: 1;
  purpose: string;
  horizon: "<3" | "3-10" | ">10";
  drop: "sell" | "hold" | "buy";
  rebalance: string;
  contributions: string;
  rules: string[];
  reviewDate: string;
  signedBy: string;
  signedOn: string;
}

const DEFAULT: IpsDoc = {
  v: 1,
  purpose: "Grow long-term savings for financial independence, while keeping an emergency fund in cash outside this portfolio.",
  horizon: ">10",
  drop: "hold",
  rebalance: "Check allocation every quarter. Rebalance when a class drifts more than 5 percentage points (or 25% of its target), using new contributions first and avoiding taxable sales.",
  contributions: "Invest $1,000 a month through payroll and automatic transfers, split by target allocation.",
  rules: ["I will not sell because prices have fallen — a 30% drop is expected a few times in a lifetime.", "I keep 6 months of essential spending in cash so I never have to sell in a downturn.", "I rebalance into whatever has fallen, on schedule, without forecasting.", "I wait 72 hours before any change that isn't on this page."],
  reviewDate: `${new Date().getFullYear() + 1}-01-15`,
  signedBy: "",
  signedOn: "",
};

const RISK: Record<string, string> = {
  "<3|sell": "20–40% stocks",
  "<3|hold": "30–50% stocks",
  "<3|buy": "40–60% stocks",
  "3-10|sell": "40–60% stocks",
  "3-10|hold": "50–70% stocks",
  "3-10|buy": "60–80% stocks",
  ">10|sell": "50–70% stocks",
  ">10|hold": "70–90% stocks",
  ">10|buy": "80–100% stocks",
};

export default function IPS({ instanceId, summary: s }: { instanceId: Id; summary?: PortfolioSummary }) {
  const [doc, setDoc] = useState<IpsDoc | null>(null);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `ips:${instanceId}`;
  useEffect(() => {
    api.kv
      .get({ ns: "ui.portfolio", key })
      .then((v) => setDoc({ ...DEFAULT, ...((v as Partial<IpsDoc> | null) ?? {}) }))
      .catch(() => setDoc(DEFAULT));
  }, [key]);
  const update = (patch: Partial<IpsDoc>) => {
    setDoc((d) => {
      const next = { ...(d ?? DEFAULT), ...patch };
      if (timer.current) clearTimeout(timer.current);
      setSaved("saving");
      timer.current = setTimeout(() => {
        api.kv
          .set({ ns: "ui.portfolio", key, value: next })
          .then(() => setSaved("saved"))
          .catch(() => setSaved("idle"));
      }, 500);
      return next;
    });
  };
  if (!doc) return null;
  const targets = (s?.allocation ?? []).filter((a) => a.target > 0).sort((a, b) => CLASS_ORDER.indexOf(a.assetClass) - CLASS_ORDER.indexOf(b.assetClass));
  const stocks = targets.filter((a) => ["US equity", "Intl developed", "Emerging", "REIT"].includes(a.assetClass)).reduce((x, a) => x + a.target, 0);
  return (
    <div className="pf-ips">
      <div className="flex items-center gap-2 mb-4 print:hidden">
        <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>
          {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved on this device" : "Edits save automatically"}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" icon={Printer} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <article className="pf-ips-paper">
        <header className="pf-ips-head">
          <div className="text-micro text-tertiary">Investment policy statement</div>
          <h2 className="m-0 text-h2">My rules for investing</h2>
          <p className="text-body text-secondary m-0">Written while calm, to be read when markets are not. Example starting points, not recommendations.</p>
        </header>

        <Section title="1 · Purpose">
          <Textarea value={doc.purpose} onChange={(e) => update({ purpose: e.target.value })} aria-label="Purpose" />
        </Section>

        <Section title="2 · Horizon and risk" subtitle="Education: a common way to translate time and temperament into a stock range.">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-caption text-secondary mb-1.5" style={{ fontWeight: 500 }}>When will I need most of this money?</div>
              <Segmented block value={doc.horizon} onValueChange={(v) => update({ horizon: v })} options={[{ value: "<3", label: "< 3 years" }, { value: "3-10", label: "3–10 years" }, { value: ">10", label: "10+ years" }]} aria-label="Horizon" />
            </div>
            <div>
              <div className="text-caption text-secondary mb-1.5" style={{ fontWeight: 500 }}>If my portfolio fell 30%, I would…</div>
              <Segmented block value={doc.drop} onValueChange={(v) => update({ drop: v })} options={[{ value: "sell", label: "Sell" }, { value: "hold", label: "Hold" }, { value: "buy", label: "Buy more" }]} aria-label="Reaction to a drop" />
            </div>
          </div>
          <div className="pf-ips-range">
            Typical range for this profile: <b>{RISK[`${doc.horizon}|${doc.drop}`]}</b>. Your targets hold <b>{stocks}% in stocks</b>
            {(() => {
              const [lo, hi] = RISK[`${doc.horizon}|${doc.drop}`].match(/\d+/g)!.map(Number);
              return stocks < lo || stocks > hi ? <span className="text-warning-text"> — outside that range; worth a second look.</span> : <span className="text-gain-text"> — inside it.</span>;
            })()}
          </div>
        </Section>

        <Section title="3 · Target allocation" subtitle="From the Target allocation database.">
          <div className="pf-ips-targets">
            {targets.map((a) => (
              <div key={a.assetClass} className="pf-ips-target">
                <span className="tabular">{a.target}%</span>
                <span>{a.assetClass}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="4 · Rebalancing and contributions">
          <div className="flex flex-col gap-3">
            <Textarea value={doc.rebalance} onChange={(e) => update({ rebalance: e.target.value })} aria-label="Rebalancing policy" />
            <Textarea value={doc.contributions} onChange={(e) => update({ contributions: e.target.value })} aria-label="Contribution plan" />
          </div>
        </Section>

        <Section title="5 · Rules I follow when markets fall">
          <ol className="pf-ips-rules">
            <AnimatePresence initial={false}>
              {doc.rules.map((r, i) => (
                <m.li key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                  <span className="pf-ips-n">{i + 1}</span>
                  <Input value={r} onChange={(e) => update({ rules: doc.rules.map((x, j) => (j === i ? e.target.value : x)) })} wrapperClassName="flex-1" aria-label={`Rule ${i + 1}`} />
                  <IconButton icon={X} size="sm" label="Remove rule" onClick={() => update({ rules: doc.rules.filter((_, j) => j !== i) })} />
                </m.li>
              ))}
            </AnimatePresence>
          </ol>
          <Button size="sm" variant="ghost" icon={Plus} className="mt-2" onClick={() => update({ rules: [...doc.rules, ""] })}>
            Add a rule
          </Button>
        </Section>

        <Section title="6 · Review and signature">
          <div className="grid grid-cols-3 gap-4 items-end">
            <Input label="Next review" type="date" value={doc.reviewDate} onChange={(e) => update({ reviewDate: e.target.value })} helper={doc.reviewDate ? `Reminds you to revisit on ${dayLabel(doc.reviewDate, true)}` : undefined} />
            <Input label="Signed" value={doc.signedBy} placeholder="Your name" onChange={(e) => update({ signedBy: e.target.value })} />
            <div className="flex items-center gap-2">
              {doc.signedOn ? (
                <span className="inline-flex items-center gap-1.5 text-body-sm text-gain-text"><Check size={15} /> Signed {dayLabel(doc.signedOn, true)}</span>
              ) : (
                <Button variant="primary" disabled={!doc.signedBy.trim()} onClick={() => update({ signedOn: todayIso() })}>
                  Sign and date
                </Button>
              )}
            </div>
          </div>
        </Section>
      </article>
    </div>
  );
}
