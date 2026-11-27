/** Advanced: search index, background jobs, data folder and vault facts, diagnostics (versions and flags only). */
import { ClipboardCopy, Cpu, FolderOpen, LayoutPanelLeft, ListChecks, ScanText, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { api, errorMessage, hasCode } from "@/backend";
import type { JobEvent } from "@/backend/types";
import { formatRelative } from "@/lib/dates";
import { selectRunningJobs, useJobs } from "@/stores/jobs";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { SIDEBAR_DEFAULT, useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/ui/Button";
import { Progress } from "@/ui/Progress";
import { JobProgress, useJob } from "../JobProgress";
import { Group, Row, SectionHeader } from "../parts";

const JOB_LABEL: Record<string, string> = {
  search_reindex: "Rebuilding the search index",
  snapshot_now: "Taking a snapshot",
  snapshot_verify: "Verifying a snapshot",
  backup_create: "Creating a backup",
  backup_restore: "Restoring a backup",
  export_pages: "Exporting pages",
  export_everything: "Exporting everything",
  import_markdown: "Importing Markdown",
  import_notion: "Importing from Notion",
  import_ics: "Importing a calendar",
  vault_integrity_check: "Checking integrity",
  vault_enable_encryption: "Encrypting",
  vault_disable_encryption: "Decrypting",
};

export function AdvancedSection() {
  const status = useVault((s) => s.status);
  const info = useSettings((s) => s.appInfo);
  const device = useSettings((s) => s.device);
  const [index, setIndex] = useState<{ ready: boolean; docs: number; building: boolean } | null>(null);
  const reindex = useJob<void>();
  const running = useJobs(useShallow(selectRunningJobs));

  const loadIndex = () => api.search.status().then(setIndex).catch(() => setIndex(null));
  useEffect(() => {
    void loadIndex();
  }, []);

  const rebuild = async () => {
    try {
      await reindex.start((onEvent: (e: JobEvent) => void) => api.search.reindex({ onEvent } as unknown as Parameters<typeof api.search.reindex>[0]));
      await loadIndex();
    } catch (e) {
      notify.fromError(e, "Couldn’t rebuild the index");
    }
  };

  const diagnostics = async () => {
    const lines = [
      `Ultranote ${info?.version ?? "?"} (${info?.commit ?? "?"})`,
      `Platform: ${info?.platform ?? "?"} ${info?.arch ?? ""} · ${info?.webview ?? ""}`,
      `Features: ${(info?.features ?? []).join(", ") || "none"}`,
      `Vault: ${status?.encrypted ? "encrypted" : "not encrypted"} · schema ${status?.schemaVersion ?? "?"} · pending migrations ${status?.pendingMigrations ?? 0} · integrity ${status?.integrity ?? "?"} · keychain ${status?.keychainAvailable ? "yes" : "no"}`,
      `KDF: ${status?.kdf ? `m=${status.kdf.mKiB} t=${status.kdf.t} p=${status.kdf.p}${status.kdf.belowStandard ? " (below standard)" : ""}` : "n/a"}`,
      `Auto-lock: idle ${status?.autoLock.idleMinutes ?? "never"} · sleep ${status?.autoLock.onSleep ? "on" : "off"} · screen ${status?.autoLock.onScreenLock ? "on" : "off"}`,
      `Appearance: theme ${device?.theme} · accent ${device?.accent} · density ${device?.density} · text ${device?.textSize} · motion ${device?.motion} · effects ${device?.effects} · contrast ${device?.contrast}`,
      `Search index: ${index ? `${index.ready ? "ready" : "building"} · ${index.docs} docs` : "?"}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      notify.success("Diagnostics copied", { description: "Versions and settings flags only — no content, titles or keys." });
    } catch (e) {
      notify.error("Couldn’t copy", { description: errorMessage(e) });
    }
  };

  return (
    <div>
      <SectionHeader icon={SlidersHorizontal} title="Advanced" description="Maintenance and details you rarely need." />

      <Group id="search-index" title="Search">
        <Row icon={<ScanText size={16} />} label="Search index" description={index ? (index.ready ? `${index.docs.toLocaleString()} pages indexed. Kept encrypted and rebuilt after each unlock.` : "Building…") : "Checking…"}>
          <Button size="sm" variant="secondary" loading={reindex.state.phase === "running"} onClick={() => void rebuild()}>
            Rebuild index
          </Button>
        </Row>
        <AnimatePresence initial={false}>
          {reindex.state.phase !== "idle" ? (
            <m.div key="job" className="st-block" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <JobProgress state={reindex.state} title="Rebuilding the search index" doneLabel="Index rebuilt" />
            </m.div>
          ) : null}
        </AnimatePresence>
      </Group>

      <Group id="jobs" title="Background jobs" description="Long tasks run in the background and can be cancelled." flush>
        {running.length ? (
          running.map((j) => (
            <div key={j.jobId} className="st-block flex items-center gap-4">
              <ListChecks size={16} className="text-tertiary" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-body-sm font-medium text-primary">{JOB_LABEL[j.command] ?? j.command.replace(/_/g, " ")}</div>
                <div className="mt-1.5">
                  <Progress value={j.progress ?? 0} indeterminate={j.progress === null} size={2} aria-label="Job progress" />
                </div>
                <div className="mt-1 text-caption text-tertiary">
                  {j.label ?? "Working"} · started {formatRelative(j.startedAt)}
                </div>
              </div>
              <Button size="xs" variant="ghost" onClick={() => void useJobs.getState().cancel(j.jobId).catch(() => undefined)}>
                Cancel
              </Button>
            </div>
          ))
        ) : (
          <Row icon={<ListChecks size={16} />} label="Nothing running" description="Imports, exports, snapshots and re-encryption show up here while they run." />
        )}
      </Group>

      <Group title="This vault">
        <Row icon={<Cpu size={16} />} label="Vault details">
          <dl className="st-kv">
            <dt>Vault id</dt>
            <dd className="st-mono">{status?.vaultId ? `${status.vaultId.slice(0, 8)}…${status.vaultId.slice(-4)}` : "—"}</dd>
            <dt>Schema</dt>
            <dd className="tabular">
              v{status?.schemaVersion ?? "?"}
              {status?.pendingMigrations ? ` · ${status.pendingMigrations} pending` : ""}
            </dd>
          </dl>
        </Row>
        <Row icon={<FolderOpen size={16} />} label="Data folder" description="Where Ultranote keeps your vault, snapshots and logs.">
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await api.app.revealDataDir();
              } catch (e) {
                if (hasCode(e, "UNSUPPORTED")) notify.info("Not available here", { description: errorMessage(e) });
                else notify.fromError(e, "Couldn’t open the folder");
              }
            }}
          >
            Show in folder
          </Button>
        </Row>
        <Row icon={<LayoutPanelLeft size={16} />} label="Reset window layout" description="Sidebar width, right panel and zoom go back to their defaults.">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const ui = useUi.getState();
              ui.setSidebarWidth(SIDEBAR_DEFAULT);
              ui.setSidebarCollapsed(false);
              ui.zoomReset();
              if (ui.rightPanelOpen) ui.toggleRightPanel();
              notify.success("Layout reset");
            }}
          >
            Reset
          </Button>
        </Row>
      </Group>

      <Group id="diagnostics" title="Support">
        <Row icon={<ClipboardCopy size={16} />} label="Copy diagnostics" description="Versions, operating system and settings flags — never content, titles, queries or keys. Paste it into a bug report.">
          <Button size="sm" variant="secondary" onClick={() => void diagnostics()}>
            Copy
          </Button>
        </Row>
      </Group>
    </div>
  );
}
