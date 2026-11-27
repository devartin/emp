/**
 * The sidebar's "+ New ▾" menu (brief §2.1): Document (⌘N), Spreadsheet, Database, Project, then App…, From a
 * template… and Import… (templates and import live here, not in the sidebar body). It is the first row under the
 * workspace header, with a caret that turns while the menu is open (120ms, register: disclosureCaret).
 */
import { AppWindow, ChevronDown, Database, FileDown, FileText, FolderKanban, LayoutTemplate, Plus, Sheet } from "lucide-react";
import { createDatabaseAndOpen, createPageAndOpen, createProjectAndOpen, createSheetAndOpen, runCommand } from "@/app/commands";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";

const run = (p: Promise<void>, what: string) => void p.catch((e) => notify.fromError(e, `Couldn't create the ${what}`));

export function NewMenu() {
  return (
    <div className="emp-sb-newrow">
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="emp-sb-row emp-sb-new" aria-label="New">
            <span className="ico">
              <Plus aria-hidden />
            </span>
            <span className="label">New</span>
            <ChevronDown aria-hidden className="caret" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" width={232}>
          <MenuItem icon={FileText} shortcut="mod+n" onSelect={() => run(createPageAndOpen(null), "document")}>
            Document
          </MenuItem>
          <MenuItem icon={Sheet} onSelect={() => run(createSheetAndOpen(null), "spreadsheet")}>
            Spreadsheet
          </MenuItem>
          <MenuItem icon={Database} onSelect={() => run(createDatabaseAndOpen(null), "database")}>
            Database
          </MenuItem>
          <MenuItem icon={FolderKanban} onSelect={() => run(createProjectAndOpen(null), "project")}>
            Project
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={AppWindow} onSelect={() => navigate({ t: "lifeapps" })}>
            App…
          </MenuItem>
          <MenuItem icon={LayoutTemplate} onSelect={() => runCommand("templates.open")}>
            From a template…
          </MenuItem>
          <MenuItem icon={FileDown} onSelect={() => runCommand("import.open")}>
            Import…
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
