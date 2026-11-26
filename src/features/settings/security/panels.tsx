/**
 * Security Center reference panels: the security log timeline, "what's visible on disk" (§9.20), the
 * order-of-magnitude password table (§9.10) and the FAQ with the approved copy (§9.22).
 */
import {
  AlertTriangle, Archive, ArchiveRestore, Download, Eye, EyeOff, FileWarning, KeyRound, Link2, Lock, LockOpen, RotateCcw,
  ShieldCheck, ShieldOff, ShieldPlus, Stamp,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { SecurityLogEntry } from "@/backend/types";
import { formatDate, formatTime, isToday } from "@/lib/dates";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Skeleton } from "@/ui/Skeleton";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { Group } from "../parts";
import { useSecurityInfo } from "./score";

// ───────────────────────────────────────────────────────────────────────────── log

const EVENTS: Record<string, { label: string; icon: LucideIcon; tone?: "warn" | "bad" | "ok" }> = {
  unlock_ok: { label: "Unlocked", icon: LockOpen },
  unlock_fail: { label: "Wrong password entered", icon: AlertTriangle, tone: "warn" },
  lock: { label: "Locked", icon: Lock },
  pw_change: { label: "Password changed", icon: KeyRound, tone: "ok" },
  recovery_regen: { label: "New recovery key created", icon: RotateCcw },
  recovery_unlock: { label: "Unlocked with the recovery key", icon: KeyRound, tone: "warn" },
  enc_on: { label: "Encryption turned on", icon: ShieldPlus, tone: "ok" },
  enc_off: { label: "Encryption turned off", icon: ShieldOff, tone: "bad" },
  export_plain: { label: "Unencrypted export", icon: Download, tone: "warn" },
  backup_create: { label: "Backup file created", icon: Archive },
  backup_restore: { label: "Backup restored into a new vault", icon: ArchiveRestore },
  integrity_fail: { label: "Integrity check failed", icon: FileWarning, tone: "bad" },
  reseal: { label: "Manifest re-sealed", icon: Stamp },
  secret_reveal: { label: "Secret revealed", icon: Eye, tone: "warn" },
  integration_connect: { label: "Integration connected", icon: Link2 },
};

interface LogGroup {
  day: string;
  items: { at: number; event: string; count: number }[];
}

function dayLabel(at: number): string {
  if (isToday(at)) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (new Date(at).toDateString() === y.toDateString()) return "Yesterday";
  return formatDate(at);
}

export function SecurityLog() {
  const [rows, setRows] = useState<SecurityLogEntry[] | null>(null);
  const [limit, setLimit] = useState(14);
  const reduced = useReducedMotionPref();
  useEffect(() => {
    api.security.log({ limit: 500 }).then(setRows).catch(() => setRows([]));
  }, []);

  const groups = useMemo<LogGroup[]>(() => {
    if (!rows) return [];
    // Collapse runs of the same event within 10 minutes ("Wrong password entered ×3").
    const collapsed: { at: number; event: string; count: number }[] = [];
    for (const r of rows) {
      const last = collapsed[collapsed.length - 1];
      if (last && last.event === r.event && last.at - r.at < 10 * 60_000) last.count++;
      else collapsed.push({ at: r.at, event: r.event, count: 1 });
    }
    const out: LogGroup[] = [];
    for (const it of collapsed.slice(0, limit)) {
      const day = dayLabel(it.at);
      const g = out[out.length - 1];
      if (g && g.day === day) g.items.push(it);
      else out.push({ day, items: [it] });
    }
    return out;
  }, [rows, limit]);

  const total = rows?.length ?? 0;
  return (
    <Group id="security-log" title="Security log" description="Kept on this device, encrypted with your workspace. It records event types and times only — never content." flush>
      <div className="st-log">
        {!rows ? (
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} height={14} width={`${60 - i * 8}%`} />
            ))}
          </div>
        ) : !rows.length ? (
          <p className="st-log-empty">No security events yet.</p>
        ) : (
          groups.map((g) => (
            <div key={g.day} className="st-log-day">
              <div className="st-log-daylabel">{g.day}</div>
              <ol className="st-log-list">
                {g.items.map((it, i) => {
                  const e = EVENTS[it.event] ?? { label: it.event.replace(/_/g, " "), icon: ShieldCheck };
                  const Icon = e.icon;
                  return (
                    <m.li
                      key={`${it.at}-${i}`}
                      className="st-log-item"
                      data-tone={e.tone}
                      initial={reduced ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...spring.gentle, delay: reduced ? 0 : Math.min(i, 8) * 0.025 }}
                    >
                      <span className="st-log-dot" aria-hidden>
                        <Icon size={13} strokeWidth={2} />
                      </span>
                      <span className="st-log-label">
                        {e.label}
                        {it.count > 1 ? <span className="st-log-count">×{it.count}</span> : null}
                      </span>
                      <time className="st-log-time tabular" dateTime={new Date(it.at).toISOString()}>
                        {formatTime(it.at)}
                      </time>
                    </m.li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
        {rows && total > 0 && groups.reduce((n, g) => n + g.items.length, 0) < rows.length && limit < 400 ? (
          <div className="st-log-more">
            <Button size="xs" variant="ghost" onClick={() => setLimit((l) => l + 30)}>
              Show older events
            </Button>
          </div>
        ) : null}
      </div>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── §9.20 disclosure

const VISIBLE = [
  "That a vault exists, its id, creation day and key-derivation settings",
  "How many workspaces, pages, rows and attachments there are",
  "The shape of the page tree and each page’s kind",
  "Created, updated and deleted times, and revisions",
  "Padded record sizes and attachment sizes",
  "Why a page version was saved",
  "Provider names for connected services",
  "Security log event types",
  "File modification times",
];
const PROTECTED = [
  "Titles, text and documents",
  "Property names and values, and views",
  "Attachment names, types and contents",
  "Tickers, account names and amounts",
  "Remote ids, tokens and keys",
  "The search index",
];

export function DiskDisclosure() {
  const fde = useSecurityInfo((s) => s.fdeAcknowledged);
  return (
    <Group id="disk-visibility" title="What’s visible on disk" description="With encryption on, someone who copies your Ultra Note folder can see some metadata but none of your content.">
      <div className="st-disclose">
        <div className="st-disclose-col" data-kind="protected">
          <div className="st-disclose-head">
            <Lock size={14} aria-hidden /> Encrypted
          </div>
          <ul>
            {PROTECTED.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div className="st-disclose-col" data-kind="visible">
          <div className="st-disclose-head">
            <EyeOff size={14} aria-hidden /> Visible metadata
          </div>
          <ul>
            {VISIBLE.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="st-block st-fde">
        <p className="text-body-sm text-secondary">
          Turn on full-disk encryption — <b>FileVault</b> on macOS, <b>BitLocker</b> on Windows or <b>LUKS</b> on Linux — to cover the remaining metadata.
        </p>
        <Checkbox checked={fde} onCheckedChange={(v) => useSecurityInfo.getState().setFde(v)} label="Full-disk encryption is on for this computer" />
      </div>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── §9.10 table

const STRENGTH: { pw: string; time: string; level: number }[] = [
  { pw: "Leaked top 10 million password", time: "~10 seconds", level: 0 },
  { pw: "8 lowercase letters", time: "~2–3 days", level: 1 },
  { pw: "4 random dictionary words", time: "~100 years", level: 2 },
  { pw: "10 random characters", time: "~1.7 million years", level: 3 },
  { pw: "6 random dictionary words", time: "billions of years", level: 4 },
];

export function StrengthTable() {
  return (
    <Group title="How strong is my password?" description="Time to try every possibility at a million guesses per second against the Standard profile. An order-of-magnitude estimate." flush>
      <table className="st-table">
        <thead>
          <tr>
            <th scope="col">Password</th>
            <th scope="col" className="text-right">
              Time to exhaust
            </th>
          </tr>
        </thead>
        <tbody>
          {STRENGTH.map((r) => (
            <tr key={r.pw}>
              <td>
                <span className="st-strength-bar" data-level={r.level} aria-hidden>
                  {Array.from({ length: 4 }, (_, i) => (
                    <i key={i} data-on={i < r.level ? "" : undefined} />
                  ))}
                </span>
                {r.pw}
              </td>
              <td className="text-right tabular">{r.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}

// ───────────────────────────────────────────────────────────────────────────── FAQ (§9.22)

const FAQ: { q: string; a: string[] }[] = [
  {
    q: "Is Ultra Note military-grade encryption?",
    a: [
      "“Military grade” isn’t a technical standard, so we don’t use the term. Ultra Note uses modern, widely reviewed cryptography (XChaCha20-Poly1305 with 256-bit keys and Argon2id password hashing) with conservative settings. It has not been certified by any government program. In practice, your security depends most on a strong password and keeping your computer free of malware. If someone can run software on your computer while Ultra Note is unlocked, no app-level encryption can stop them.",
    ],
  },
  {
    q: "Where is my data stored?",
    a: ["Your workspace lives on your computer. Ultra Note has no servers and no accounts, and we never receive your data."],
  },
  {
    q: "Can you reset my password?",
    a: ["Your password never leaves this device, and we can’t reset it. Your recovery key is the only other way in, so keep it safe."],
  },
  {
    q: "Does Ultra Note connect to the internet?",
    a: [
      "Nothing connects to the internet unless you turn on an integration. You can see every request Ultra Note makes in Privacy & network.",
      "API keys and account connections are always stored encrypted.",
    ],
  },
  {
    q: "What happens if someone edits my files?",
    a: ["Tamper-evident: Ultra Note detects if encrypted items are modified outside the app. Run an integrity check any time from this page."],
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const reduced = useReducedMotionPref();
  return (
    <Group title="Questions" flush>
      <div className="st-faq">
        {FAQ.map((f, i) => {
          const isOpen = open === i;
          return (
            <div key={f.q} className="st-faq-item" data-open={isOpen ? "" : undefined}>
              <button type="button" className="st-faq-q" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
                <span>{f.q}</span>
                <span className="st-faq-chev" aria-hidden />
              </button>
              <AnimatePresence initial={false}>
                {isOpen ? (
                  <m.div
                    key="a"
                    className="st-faq-a"
                    initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1, transition: { duration: 0.2, ease: ease.out } }}
                    exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.14, ease: ease.in } }}
                  >
                    <div className="st-faq-a-inner">
                      {f.a.map((p) => (
                        <p key={p}>{p}</p>
                      ))}
                    </div>
                  </m.div>
                ) : null}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </Group>
  );
}
