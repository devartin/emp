/**
 * Recovery key ceremony (§6.2 step 3b; reused by Security Center): 24 words in a 4×6 grid (mono 18/28, in a well),
 * Copy (sensitive clipboard: clears after 30 s), Save as file…, Print, the approved warning, then "I've saved my
 * recovery key" plus 3 randomly chosen words to prove it. "Skip (not recommended)" leaves the key unconfirmed.
 */
import { AlertTriangle, Check, Copy, Download, EyeOff, Printer } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import { usePrivacy } from "@/stores/privacy";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { ease, spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import "./vault.css";

export interface RecoveryCeremonyProps {
  words: string[];
  /** Called after the three words verify (true) or when the user skips (false). */
  onDone: (confirmed: boolean) => void;
  allowSkip?: boolean;
  /** Extra footer content on the left (e.g. a Back button). */
  footerStart?: ReactNode;
  continueLabel?: string;
}

function pickPositions(n: number, count = 3): number[] {
  const out = new Set<number>();
  const buf = new Uint32Array(count * 4);
  crypto.getRandomValues(buf);
  for (const v of buf) {
    out.add(v % n);
    if (out.size === count) break;
  }
  let i = 0;
  while (out.size < count) out.add(i++ % n);
  return Array.from(out).sort((a, b) => a - b);
}

function keyText(words: string[]): string {
  const lines = [];
  for (let r = 0; r < 6; r++) lines.push(words.slice(r * 4, r * 4 + 4).map((w, c) => `${String(r * 4 + c + 1).padStart(2, " ")}. ${w}`.padEnd(18, " ")).join(""));
  return lines.join("\n");
}

function saveAsFile(words: string[]) {
  const body = `Ultra Note recovery key\n\n${keyText(words)}\n\nCreated ${new Date().toLocaleDateString()}.\nStore this somewhere safe. If you lose both your password and this key, your data cannot be recovered.\n`;
  const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "Ultra Note Recovery Key.txt";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printKey(words: string[]) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0;opacity:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  const cells = words.map((w, i) => `<li><span>${i + 1}</span>${esc(w)}</li>`).join("");
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Ultra Note recovery key</title><style>
    body{font:14px/1.5 -apple-system,Segoe UI,Inter,sans-serif;color:#18181b;margin:48px}
    h1{font-size:20px;margin:0 0 4px} p{color:#52525b;margin:0 0 24px}
    ol{list-style:none;padding:20px;margin:0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px 18px;border:1px solid #d4d4d8;border-radius:12px}
    li{font:600 17px/28px ui-monospace,Menlo,monospace} li span{display:inline-block;width:28px;color:#a1a1aa;font-size:11px;font-weight:500}
    .warn{margin-top:24px;padding:12px 14px;border:1px solid #f5a524;border-radius:10px;color:#a15c00}
  </style></head><body><h1>Ultra Note recovery key</h1><p>Printed ${esc(new Date().toLocaleDateString())}</p><ol>${cells}</ol>
  <div class="warn">Store this somewhere safe. If you lose both your password and this key, your data cannot be recovered.</div></body></html>`);
  doc.close();
  const win = frame.contentWindow;
  window.setTimeout(() => {
    win?.focus();
    win?.print();
    window.setTimeout(() => frame.remove(), 1000);
  }, 50);
}

export function RecoveryCeremony({ words, onDone, allowSkip = true, footerStart, continueLabel = "Continue" }: RecoveryCeremonyProps) {
  const positions = useMemo(() => pickPositions(words.length || 24), [words]);
  const [saved, setSaved] = useState(false);
  const [answers, setAnswers] = useState<string[]>(() => positions.map(() => ""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const copySensitive = usePrivacy((s) => s.copySensitive);
  const reduced = useReducedMotionPref();

  const ready = saved && answers.every((a) => a.trim().length > 0);
  const allRight = answers.every((a, i) => a.trim().toLowerCase() === words[positions[i]]?.toLowerCase());

  const confirm = async () => {
    if (!ready || busy) return;
    setError(null);
    if (!allRight) {
      setError("One or more words don't match. Check your saved copy.");
      return;
    }
    setBusy(true);
    try {
      const { confirmed } = await api.vault.recoveryConfirm({ positions, words: answers.map((a) => a.trim().toLowerCase()) });
      if (confirmed) onDone(true);
      else setError("One or more words don't match. Check your saved copy.");
    } catch (e) {
      setError(errorMessage(e) || "Couldn't confirm the recovery key");
    } finally {
      setBusy(false);
    }
  };

  const showWords = !saved || reveal;
  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {showWords ? (
          <m.div
            key="words"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.16 } }}
            exit={{ opacity: 0, transition: { duration: 0.12, ease: ease.in } }}
          >
            {/* S4: each word is a keycap that flips up out of the well, 40ms apart, on the settle spring. */}
            <ol className="emp-words" aria-label="Recovery key, 24 words">
              {words.map((w, i) => (
                <m.li
                  key={i}
                  className="emp-word"
                  initial={reduced ? { opacity: 0 } : { opacity: 0, rotateX: -90, y: 6 }}
                  animate={{ opacity: 1, rotateX: 0, y: 0, transition: reduced ? { duration: 0.14 } : { ...spring.settle, delay: 0.12 + i * 0.04, opacity: { duration: 0.18, delay: 0.12 + i * 0.04 } } }}
                >
                  <span className="emp-word-n">{i + 1}</span>
                  <span className="emp-word-t">{w}</span>
                </m.li>
              ))}
            </ol>
          </m.div>
        ) : (
          <m.div
            key="hidden"
            className="well flex items-center gap-3 rounded-xl px-4 py-3"
            data-static=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.16, delay: 0.1 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          >
            <EyeOff size={16} className="flex-none text-tertiary" aria-hidden />
            <span className="flex-1 text-body-sm text-secondary">Key hidden. Confirm it from the copy you saved.</span>
            <Button size="xs" variant="ghost" onClick={() => setReveal(true)}>
              Show again
            </Button>
          </m.div>
        )}
      </AnimatePresence>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={Copy} onClick={() => copySensitive(words.join(" "))}>
          Copy
        </Button>
        <Button
          size="sm"
          icon={Download}
          onClick={() => {
            saveAsFile(words);
            notify.success("Recovery key saved", { description: "Move the file somewhere safe, like a password manager or a USB drive." });
          }}
        >
          Save as file…
        </Button>
        <Button size="sm" icon={Printer} onClick={() => printKey(words)}>
          Print
        </Button>
      </div>
      <div className="mt-4 flex gap-2.5 rounded-[10px] border px-3.5 py-3 text-body-sm" style={{ background: "var(--warning-soft)", borderColor: "color-mix(in oklab, var(--warning) 30%, transparent)", color: "var(--text-primary)" }} role="note">
        <AlertTriangle size={16} className="mt-px flex-none" style={{ color: "var(--warning-text)" }} aria-hidden />
        <span>Store this somewhere safe. If you lose both your password and this key, your data cannot be recovered.</span>
      </div>

      <div className="mt-5">
        <Checkbox
          checked={saved}
          onCheckedChange={(v) => {
            setSaved(v === true);
            setReveal(false);
          }}
          label="I've saved my recovery key"
        />
      </div>
      <AnimatePresence initial={false}>
        {saved ? (
          <m.div
            key="verify"
            initial={{ opacity: 0, y: reduced ? 0 : -6 }}
            animate={{ opacity: 1, y: 0, transition: reduced ? { duration: 0.14 } : spring.settle }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
          >
            <p className="mt-4 text-body-sm text-secondary">Type these words from your key to confirm:</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {positions.map((p, i) => {
                const ok = answers[i].trim().toLowerCase() === words[p]?.toLowerCase();
                return (
                  <label key={p} className="emp-word-input" data-filled={answers[i] ? "" : undefined} data-ok={ok ? "" : undefined} style={{ height: 38 }}>
                    <span aria-hidden>#{p + 1}</span>
                    <input
                      value={answers[i]}
                      aria-label={`Word ${p + 1}`}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      autoFocus={i === 0}
                      onChange={(e) => {
                        const v = e.currentTarget.value.toLowerCase().replace(/[^a-z]/g, "");
                        setError(null);
                        setAnswers((cur) => cur.map((a, k) => (k === i ? v : a)));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void confirm();
                        }
                      }}
                    />
                    <AnimatePresence>
                      {ok ? (
                        <m.i key="ok" className="mr-2 flex text-gain-text" initial={{ scale: 0 }} animate={{ scale: 1, transition: spring.bouncy }} exit={{ scale: 0 }}>
                          <Check size={14} strokeWidth={2.5} aria-hidden />
                        </m.i>
                      ) : null}
                    </AnimatePresence>
                  </label>
                );
              })}
            </div>
            {error ? (
              <p className="emp-helper mt-2" data-invalid="" role="alert">
                <span>{error}</span>
              </p>
            ) : null}
          </m.div>
        ) : null}
      </AnimatePresence>

      <div className="emp-onb-foot">
        {footerStart}
        {allowSkip ? (
          <Button variant="ghost" className="text-tertiary" onClick={() => onDone(false)}>
            Skip (not recommended)
          </Button>
        ) : null}
        <Button variant="primary" size="lg" className="ml-auto" disabled={!ready} loading={busy} onClick={() => void confirm()}>
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}

export default RecoveryCeremony;
