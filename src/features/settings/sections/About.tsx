/**
 * About Ultranote (1.0 brief §2.4, the link at the foot of the settings list): version, the update check (one button,
 * one switch), the data folder and logs, diagnostics for a bug report, how encryption works, and open-source licences.
 *
 * The update check asks GitHub for the latest release through NetGuard (Rust `app_check_update`). It runs only when
 * the person presses the button, or once a day while "Check for updates automatically" is on; it fails calmly when
 * offline or when GitHub can't be reached, and offers the release page when there is something new.
 */
import { ClipboardCopy, Copy, ExternalLink, FolderOpen, RefreshCw, ScrollText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api, backendMode, errorMessage, hasCode } from "@/backend";
import type { UpdateCheck } from "@/backend/types";
import { AppMark, Wordmark } from "@/features/vault/AppMark";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useVault } from "@/stores/vault";
import { Button } from "@/ui/Button";
import { Switch } from "@/ui/Switch";
import { LICENCES } from "../licences";
import { Group, Row } from "../parts";
import { Faq, StrengthTable } from "../security/panels";
import { checkForUpdates, openReleasePage } from "../updates";

const PLATFORM: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

async function reveal(which: "data" | "logs") {
  try {
    if (which === "data") await api.app.revealDataDir();
    else await api.app.revealLogs();
  } catch (e) {
    if (hasCode(e, "UNSUPPORTED")) notify.info("Not available here", { description: errorMessage(e) });
    else notify.fromError(e, "Couldn’t open the folder");
  }
}

export function AboutSection() {
  const info = useSettings((s) => s.appInfo);
  const device = useSettings((s) => s.device);
  const setDevice = useSettings((s) => s.setDevice);
  const status = useVault((s) => s.status);
  const [checking, setChecking] = useState(false);
  const [last, setLast] = useState<UpdateCheck | null>(null);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return LICENCES.filter((l) => !needle || `${l.name} ${l.licence} ${l.by}`.toLowerCase().includes(needle));
  }, [q]);
  const kinds = Array.from(new Set(list.map((l) => l.kind)));

  const check = async () => {
    setChecking(true);
    setLast(await checkForUpdates());
    setChecking(false);
  };

  const copyVersion = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(`Ultranote ${info.version} (${info.commit}) · ${PLATFORM[info.platform] ?? info.platform} ${info.arch} · ${info.webview}`);
      notify.success("Version copied");
    } catch (e) {
      notify.error("Couldn’t copy", { description: errorMessage(e) });
    }
  };

  const diagnostics = async () => {
    const lines = [
      `Ultranote ${info?.version ?? "?"} (${info?.commit ?? "?"})`,
      `Platform: ${info?.platform ?? "?"} ${info?.arch ?? ""} · ${info?.webview ?? ""}`,
      `Features: ${(info?.features ?? []).join(", ") || "none"}`,
      `Workspace: ${status?.encrypted ? "encrypted" : "not encrypted"} · schema ${status?.schemaVersion ?? "?"} · pending migrations ${status?.pendingMigrations ?? 0} · integrity ${status?.integrity ?? "?"} · keychain ${status?.keychainAvailable ? "yes" : "no"}`,
      `Auto-lock: idle ${status?.autoLock.idleMinutes ?? "never"} · sleep ${status?.autoLock.onSleep ? "on" : "off"} · screen ${status?.autoLock.onScreenLock ? "on" : "off"}`,
      `Appearance: theme ${device?.theme} · accent ${device?.accent} · density ${device?.density} · text ${device?.textSize} · motion ${device?.motion} · contrast ${device?.contrast}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify.success("Diagnostics copied", { description: "Versions and settings only. No content, titles or keys." });
    } catch (e) {
      notify.error("Couldn’t copy", { description: errorMessage(e) });
    }
  };

  return (
    <div>
      <div className="st-about">
        <AppMark size={56} />
        <div className="min-w-0 flex-1">
          <Wordmark className="st-about-word" />
          <p className="st-about-tag">Your notes, spreadsheets, tasks and money in one private place on this computer.</p>
          <button type="button" className="st-about-ver" onClick={() => void copyVersion()} title="Copy version details">
            Version {info?.version ?? "…"}
            {info ? ` · ${PLATFORM[info.platform] ?? info.platform}` : ""}
            <Copy size={12} aria-hidden />
          </button>
        </div>
      </div>

      <Group>
        <Row
          id="updates"
          label="Check for updates"
          description={
            last?.available ? (
              <>
                Ultranote {last.version} is available.{" "}
                {last.url ? (
                  <Button size="xs" variant="link" icon={ExternalLink} onClick={() => openReleasePage(last.url as string)}>
                    Open release page
                  </Button>
                ) : null}
              </>
            ) : last ? (
              last.version ? `You’re up to date (${last.current}).` : `No release is published yet. You have ${last.current}.`
            ) : (
              "Asks github.com for the latest version. Nothing about you or your workspace is sent."
            )
          }
        >
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={checking} onClick={() => void check()}>
            Check now
          </Button>
        </Row>
        <Row id="update-auto" label="Check automatically" description="Once a day while Ultranote is open. Off by default.">
          <Switch checked={device?.updates === "check"} onCheckedChange={(v) => void setDevice({ updates: v ? "check" : "off" })} aria-label="Check for updates automatically" />
        </Row>
      </Group>

      <Group title="Files and support">
        {backendMode === "tauri" ? (
          <>
            <Row id="data-folder" label="Data folder" description="Where Ultranote keeps your workspace, backups and logs.">
              <Button size="sm" variant="secondary" icon={FolderOpen} onClick={() => void reveal("data")}>
                Show
              </Button>
            </Row>
            <Row id="logs" label="Logs" description="What Ultranote did and when. Never content, titles or keys, so you can attach them to a bug report.">
              <Button size="sm" variant="secondary" icon={ScrollText} onClick={() => void reveal("logs")}>
                Show
              </Button>
            </Row>
          </>
        ) : null}
        <Row id="diagnostics" label="Copy diagnostics" description="Versions, operating system and settings. Never content, titles or keys.">
          <Button size="sm" variant="secondary" icon={ClipboardCopy} onClick={() => void diagnostics()}>
            Copy
          </Button>
        </Row>
      </Group>

      <Faq />
      <StrengthTable />

      <Group
        id="licences"
        title="Open-source licences"
        description="Ultranote is MIT-licensed, © 2026 devartin, and built on the work of these projects."
        actions={
          <label className="st-search st-search-inline">
            <Search size={13} aria-hidden />
            <input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Filter" aria-label="Filter licences" />
          </label>
        }
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
      <p className="st-hint">Charts by TradingView Lightweight Charts™. Market data comes from the providers you turn on and is delayed unless your plan says otherwise.</p>
    </div>
  );
}
