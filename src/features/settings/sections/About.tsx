/** About (§6.6, §9.22): version, platform, update check, what EMP promises, and open-source licences. */
import { Check, Copy, RefreshCw, Search } from "lucide-react";
import { m } from "motion/react";
import { useMemo, useState } from "react";
import { api, errorMessage, hasCode } from "@/backend";
import { AppMark, Wordmark } from "@/features/vault/AppMark";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { Button } from "@/ui/Button";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { LICENCES } from "../licences";
import { Group } from "../parts";

const CLAIMS = [
  "Your workspace lives on your computer. Ultra Note has no servers and no accounts, and we never receive your data.",
  "Optional encryption at rest: everything you write is encrypted on your device with 256-bit XChaCha20-Poly1305, under a key protected by your password using Argon2id.",
  "Your password never leaves this device, and we can’t reset it. Your recovery key is the only other way in, so keep it safe.",
  "API keys and account connections are always stored encrypted.",
  "Nothing connects to the internet unless you turn on an integration. You can see every request Ultra Note makes in Security Center.",
  "Tamper-evident: Ultra Note detects if encrypted items are modified outside the app.",
];

const PLATFORM: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export function AboutSection() {
  const info = useSettings((s) => s.appInfo);
  const updates = useSettings((s) => s.device?.updates);
  const [checking, setChecking] = useState(false);
  const [q, setQ] = useState("");
  const reduced = useReducedMotionPref();
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return LICENCES.filter((l) => !needle || `${l.name} ${l.licence} ${l.by}`.toLowerCase().includes(needle));
  }, [q]);
  const kinds = Array.from(new Set(list.map((l) => l.kind)));

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.app.checkUpdate();
      if (r.available) notify.info(`Ultra Note ${r.version} is available`, { description: r.notes });
      else notify.success("You’re up to date");
    } catch (e) {
      if (hasCode(e, "OFFLINE")) notify.info("Update checks are off", { description: updates === "off" ? "Turn on “Check for updates automatically” in General." : errorMessage(e) });
      else notify.fromError(e, "Couldn’t check for updates");
    } finally {
      setChecking(false);
    }
  };

  const copyVersion = async () => {
    if (!info) return;
    await navigator.clipboard.writeText(`Ultra Note ${info.version} (${info.commit}) · ${PLATFORM[info.platform] ?? info.platform} ${info.arch} · ${info.webview}`);
    notify.success("Version copied");
  };

  return (
    <div>
      <div className="st-about emp-aurora">
        <m.div initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring.gentle} className="st-about-inner">
          <AppMark size={72} />
          <Wordmark className="st-about-word" />
          <p className="st-about-tag">Your notes, money, plans and life admin, in one private place on your device.</p>
          <div className="st-about-meta">
            <button type="button" className="st-about-ver" onClick={() => void copyVersion()} title="Copy version details">
              Version {info?.version ?? "—"}
              <Copy size={12} aria-hidden />
            </button>
            {info ? (
              <span>
                {PLATFORM[info.platform] ?? info.platform} · {info.arch} · {info.webview}
              </span>
            ) : null}
          </div>
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={checking} onClick={() => void check()}>
            Check for updates
          </Button>
        </m.div>
      </div>

      <Group title="What Ultra Note promises">
        <ul className="st-claims">
          {CLAIMS.map((c, i) => (
            <m.li key={c} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: reduced ? 0 : 0.1 + i * 0.04 }}>
              <span className="st-claim-check" aria-hidden>
                <Check size={12} strokeWidth={3} />
              </span>
              {c}
            </m.li>
          ))}
        </ul>
      </Group>

      <Group
        id="licences"
        title="Open-source licences"
        description="Ultra Note is MIT-licensed, © 2026 devartin. It’s built on the work of these projects."
        actions={
          <label className="st-search st-search-inline">
            <Search size={13} aria-hidden />
            <input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Filter" aria-label="Filter licences" />
          </label>
        }
        flush
      >
        {kinds.map((k) => (
          <div key={k} className="st-lic-group">
            <div className="st-lic-head">{k}</div>
            {list
              .filter((l) => l.kind === k)
              .map((l) => (
                <div key={l.name} className="st-lic">
                  <span className="st-lic-name">{l.name}</span>
                  <span className="st-lic-by">{l.by}</span>
                  <span className="st-tag">{l.licence}</span>
                </div>
              ))}
          </div>
        ))}
        {!list.length ? <p className="st-noresults px-4 py-3">Nothing matches “{q}”.</p> : null}
      </Group>
      <p className="st-hint">Charts by TradingView Lightweight Charts™. Market data comes from the providers you enable and is delayed unless your plan says otherwise.</p>
    </div>
  );
}
