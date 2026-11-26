/**
 * Top-bar page controls (§6.1): Favorite, the Export menu (PDF, Markdown, CSV, XLSX — HTML is P1) and the `…` page
 * menu (page actions plus display options: font, small text, full width, lock page).
 */
import { Download, Ellipsis, FileJson, FileSpreadsheet, FileText, LockKeyhole, Printer, Share, Star, Table } from "lucide-react";
import { useState } from "react";
import { api, hasCode, type JobHandle } from "@/backend";
import type { FileFilter, PageMeta } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { PageMenuItems, pageActions } from "./PageMenu";

export function FavoriteButton({ meta }: { meta: PageMeta }) {
  const fav = useWorkspace((s) => !!s.workspace?.favorites.includes(meta.id));
  return (
    <IconButton
      size="sm"
      icon={<Star size={16} aria-hidden fill={fav ? "currentColor" : "none"} className={fav ? "text-primary" : "text-tertiary"} />}
      label={fav ? "Remove from Favorites" : "Add to Favorites"}
      active={fav}
      onClick={() => useWorkspace.getState().toggleFavorite(meta.id)}
    />
  );
}

const safeName = (s: string) => (s || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "Untitled";

async function exportWith(
  meta: PageMeta,
  ext: string,
  filter: FileFilter,
  run: (grantId: string) => Promise<JobHandle<unknown>>,
  describe: (res: unknown) => string,
) {
  try {
    const grant = await api.file.saveGrant({ purpose: "export", suggestedName: `${safeName(meta.title)}.${ext}`, filters: [filter] });
    if (!grant) return;
    const id = notify.info(`Exporting “${meta.title || "Untitled"}”…`, { duration: Infinity });
    try {
      const job = await run(grant.grantId);
      const res = await job.result;
      notify.dismiss(id);
      notify.success("Export complete", { description: `${describe(res)} saved to ${grant.displayName}.` });
    } catch (e) {
      notify.dismiss(id);
      throw e;
    }
  } catch (e) {
    if (hasCode(e, "REAUTH_REQUIRED")) {
      notify.warning("Confirm your password to export", { description: "Exports of an encrypted workspace leave the vault unencrypted. Re-enter your password in Settings → Security, then try again." });
      return;
    }
    notify.fromError(e, "Couldn't export");
  }
}

export function ExportMenu({ meta }: { meta: PageMeta }) {
  const [open, setOpen] = useState(false);
  const isDb = meta.kind === "database";
  const isSheet = meta.kind === "sheet";
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <span>
          <IconButton size="sm" icon={Share} label="Export" active={open} />
        </span>
      </MenuTrigger>
      <MenuContent align="end" width={240}>
        <MenuLabel>Export</MenuLabel>
        <MenuItem icon={Printer} shortcut="mod+p" onSelect={() => window.setTimeout(() => window.print(), 50)}>
          PDF…
        </MenuItem>
        {!isSheet ? (
          <MenuItem
            icon={FileText}
            onSelect={() =>
              void exportWith(
                meta,
                "md",
                { name: "Markdown", extensions: ["md"] },
                (grantId) => api.export.pages({ pageIds: [meta.id], format: "markdown", includeChildren: true, includeAssets: true, grantId }),
                (r) => `${(r as { files?: number }).files ?? 1} file${(r as { files?: number }).files === 1 ? "" : "s"}`,
              )
            }
          >
            Markdown
          </MenuItem>
        ) : null}
        {!isSheet && !isDb ? (
          <MenuItem
            icon={FileJson}
            onSelect={() =>
              void exportWith(
                meta,
                "json",
                { name: "JSON", extensions: ["json"] },
                (grantId) => api.export.pages({ pageIds: [meta.id], format: "json", includeChildren: true, includeAssets: false, grantId }),
                () => "Page data",
              )
            }
          >
            JSON
          </MenuItem>
        ) : null}
        {isDb ? (
          <>
            <MenuItem
              icon={Table}
              onSelect={() =>
                void exportWith(
                  meta,
                  "csv",
                  { name: "CSV", extensions: ["csv"] },
                  (grantId) => api.db.export({ databaseId: meta.id, format: "csv", grantId }),
                  (r) => `${(r as { rows?: number }).rows ?? 0} rows`,
                )
              }
            >
              CSV
            </MenuItem>
            <MenuItem
              icon={FileSpreadsheet}
              onSelect={() =>
                void exportWith(
                  meta,
                  "xlsx",
                  { name: "Excel workbook", extensions: ["xlsx"] },
                  (grantId) => api.db.export({ databaseId: meta.id, format: "xlsx", grantId }),
                  (r) => `${(r as { rows?: number }).rows ?? 0} rows`,
                )
              }
            >
              XLSX
            </MenuItem>
          </>
        ) : null}
        {isSheet ? (
          <>
            <MenuItem
              icon={FileSpreadsheet}
              onSelect={() =>
                void exportWith(meta, "xlsx", { name: "Excel workbook", extensions: ["xlsx"] }, (grantId) => api.sheet.export({ workbookId: meta.id, format: "xlsx", grantId }), () => "Workbook")
              }
            >
              XLSX
            </MenuItem>
            <MenuItem
              icon={Table}
              onSelect={() => void exportWith(meta, "csv", { name: "CSV", extensions: ["csv"] }, (grantId) => api.sheet.export({ workbookId: meta.id, format: "csv", grantId }), () => "Sheet")}
            >
              CSV
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem icon={Download} onSelect={() => void exportWith(meta, "md", { name: "Markdown", extensions: ["md"] }, (grantId) => api.export.pages({ pageIds: [meta.id], format: "markdown", includeChildren: true, includeAssets: true, grantId }), () => "Page and sub-pages")}>
          Page and sub-pages…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function PageMoreMenu({ meta }: { meta: PageMeta }) {
  const [open, setOpen] = useState(false);
  const flags = meta.flags;
  const setFlag = (patch: Partial<PageMeta["flags"]>) => void useTree.getState().updateMeta(meta.id, { flags: patch });
  const isDoc = meta.kind === "doc";
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <span>
          <IconButton size="sm" icon={Ellipsis} label="Page options" active={open} />
        </span>
      </MenuTrigger>
      {open ? (
        <MenuContent align="end" width={260}>
          {isDoc ? (
            <>
              <MenuLabel>Font</MenuLabel>
              <MenuRadioGroup value={flags.font ?? "sans"} onValueChange={(v) => setFlag({ font: v as "sans" | "serif" | "mono" })}>
                <MenuRadioItem value="sans">Default</MenuRadioItem>
                <MenuRadioItem value="serif">Serif</MenuRadioItem>
                <MenuRadioItem value="mono">Mono</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuCheckboxItem checked={!!flags.smallText} onCheckedChange={(v) => setFlag({ smallText: v })}>
                Small text
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={!!flags.fullWidth} onCheckedChange={(v) => setFlag({ fullWidth: v })}>
                Full width
              </MenuCheckboxItem>
              <MenuCheckboxItem checked={!!flags.locked} onCheckedChange={(v) => setFlag({ locked: v })} icon={LockKeyhole}>
                Lock page
              </MenuCheckboxItem>
              <MenuSeparator />
            </>
          ) : null}
          <PageMenuItems actions={pageActions(meta, { current: true })} />
        </MenuContent>
      ) : null}
    </Menu>
  );
}
