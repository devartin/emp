/**
 * Workbook page (route entry for `kind: 'sheet'` pages and `{t:'sheet'}` routes): header (icon, title, find,
 * import / export), toolbar, formula bar, the canvas grid and the sheet tabs with the selection status.
 */
import { AnimatePresence, m } from 'motion/react';
import { ChevronDown, Download, FileSpreadsheet, FileText, FileUp, Search, Sheet as SheetIcon, TableProperties } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerFlush } from '@/app/boot';
import { api, hasCode } from '@/backend';
import type { Id } from '@/backend/types';
import { PageIcon } from '@/features/shell/PageIcon';
import { RouteSkeleton } from '@/features/shell/RouteSkeleton';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { useUi } from '@/stores/ui';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/ui/Menu';
import { transitions } from '@/ui/motion/presets';
import { FindPanel } from './FindPanel';
import { FormulaBar } from './FormulaBar';
import { GridController, useGridSelector } from './GridController';
import { GridView } from './GridView';
import { SheetTabs } from './SheetTabs';
import { Toolbar } from './Toolbar';
import './sheets.css';

export interface SheetPageProps {
  pageId: Id;
  sheetId?: Id;
}

const safeName = (s: string) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'Untitled';

export default function SheetPage({ pageId, sheetId }: SheetPageProps) {
  const ctrl = useMemo(() => new GridController(pageId, sheetId), [pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only the load state lives up here: selection moves and edits re-render the children that subscribe to them
  // (formula bar, grid, status), not the whole workbook chrome.
  useGridSelector(ctrl, (c) => `${c.loaded ? 1 : 0}|${c.loadError ?? ''}`);
  const barRef = useRef<HTMLTextAreaElement | null>(null);
  const [cfOpen, setCfOpen] = useState(false);

  useEffect(() => {
    void ctrl.load();
    const unflush = registerFlush(async () => {
      if (ctrl.edit) await ctrl.commitEdit(null);
    });
    return () => {
      unflush();
      if (ctrl.edit) void ctrl.commitEdit(null);
      ctrl.dispose();
    };
  }, [ctrl]);

  useEffect(() => {
    if (sheetId && ctrl.loaded) void ctrl.setSheet(sheetId);
  }, [sheetId, ctrl]);

  const ui = useMemo(
    () => ({
      openFind: (replace?: boolean) => {
        ctrl.setFind({ open: true, replace: !!replace || ctrl.find.replace });
      },
      openCondFormat: () => setCfOpen(true),
    }),
    [ctrl],
  );

  const onFind = useCallback(() => ui.openFind(false), [ui]);

  if (ctrl.loadError) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center p-8">
        <EmptyState icon={SheetIcon} title="This workbook couldn’t be opened" body={ctrl.loadError} actions={<Button onClick={() => window.location.reload()}>Reload</Button>} />
      </div>
    );
  }

  return (
    <div className="emp-sheet-host">
      <AnimatePresence mode="wait" initial={false}>
        {!ctrl.loaded ? (
          <m.div key="sk" className="emp-sheet-page" exit={{ opacity: 0, transition: transitions.pageOut }}>
            <RouteSkeleton variant="grid" label="Loading workbook" />
          </m.div>
        ) : (
          <m.div key="page" className="emp-sheet-page" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: transitions.crossfade }}>
            <SheetHeader ctrl={ctrl} pageId={pageId} onFind={onFind} />
            <Toolbar ctrl={ctrl} cfOpen={cfOpen} onCfOpenChange={setCfOpen} />
            <FormulaBar ctrl={ctrl} barRef={barRef} />
            <div className="emp-wb-body">
              <GridView ctrl={ctrl} ui={ui} barRef={barRef} />
              <FindPanel ctrl={ctrl} />
            </div>
            <SheetTabs ctrl={ctrl} />
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The active cell as shown in the Import menu; subscribes on its own so the header doesn't follow the selection. */
function SelectionAnchor({ ctrl }: { ctrl: GridController }) {
  return <>{useGridSelector(ctrl, (c) => c.selectionLabel.split(':')[0])}</>;
}

const SheetHeader = memo(function SheetHeader({ ctrl, pageId, onFind }: { ctrl: GridController; pageId: Id; onFind: () => void }) {
  const sheetName = useGridSelector(ctrl, (c) => c.sheet?.name ?? 'Sheet');
  const meta = useTree((s) => s.byId.get(pageId));
  const [title, setTitle] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const shown = title ?? meta?.title ?? '';

  const commitTitle = () => {
    if (title === null) return;
    const next = title.trim();
    setTitle(null);
    if (meta && next !== meta.title) void useTree.getState().rename(pageId, next);
  };

  const exportAs = async (format: 'xlsx' | 'csv') => {
    const base = safeName(meta?.title || 'Workbook');
    try {
      const grant = await api.file.saveGrant({
        purpose: 'export',
        suggestedName: format === 'xlsx' ? `${base}.xlsx` : `${base} - ${safeName(sheetName)}.csv`,
        filters: [format === 'xlsx' ? { name: 'Excel workbook', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }],
      });
      if (!grant) return;
      const id = notify.info(format === 'xlsx' ? 'Exporting workbook…' : `Exporting “${sheetName}”…`, { duration: Infinity });
      try {
        const job = await api.sheet.export({ workbookId: ctrl.workbookId, format, sheetId: format === 'csv' ? ctrl.sheetId : undefined, grantId: grant.grantId });
        await job.result;
        notify.dismiss(id);
        notify.success('Export complete', { description: `Saved to ${grant.displayName}.` });
      } catch (e) {
        notify.dismiss(id);
        throw e;
      }
    } catch (e) {
      if (hasCode(e, 'REAUTH_REQUIRED')) {
        notify.warning('Confirm your password to export', { description: 'Exports leave the vault unencrypted. Re-enter your password in Settings → Security, then try again.' });
        return;
      }
      notify.fromError(e, 'Couldn’t export');
    }
  };

  const insertCsv = async (file: File) => {
    if (file.size > 20 * 1024 * 1024) {
      notify.warning('That file is too large to insert', { description: 'Import it as a new workbook instead.' });
      return;
    }
    const text = await file.text();
    const tsv = text.includes('\t') ? text : csvToTsv(text);
    await ctrl.pasteText(tsv, undefined);
    notify.success(`Inserted ${file.name}`, { description: `At ${ctrl.selectionLabel.split(':')[0]} on “${ctrl.sheet?.name ?? 'this sheet'}”.` });
  };

  return (
    <header className="emp-wb-header">
      <PageIcon icon={meta?.icon} kind="sheet" size={22} />
      <input
        className="emp-wb-title"
        value={shown}
        placeholder="Untitled spreadsheet"
        aria-label="Workbook title"
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitTitle();
            ctrl.focusGrid?.();
          } else if (e.key === 'Escape') {
            setTitle(null);
            ctrl.focusGrid?.();
          }
        }}
      />
      <span className="flex-1" />
      <IconButton size="sm" icon={Search} label="Find and replace" shortcut="mod+f" onClick={onFind} />
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={FileUp} iconRight={ChevronDown}>
            Import
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={280}>
          <MenuLabel>Import</MenuLabel>
          <MenuItem icon={FileSpreadsheet} onSelect={() => useUi.getState().setImportOpen(true)}>
            Excel or CSV as a new workbook…
          </MenuItem>
          <MenuItem icon={TableProperties} onSelect={() => fileRef.current?.click()}>
            CSV into this sheet at <SelectionAnchor ctrl={ctrl} />…
          </MenuItem>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" icon={Download} iconRight={ChevronDown}>
            Export
          </Button>
        </MenuTrigger>
        <MenuContent align="end" width={260}>
          <MenuLabel>Export</MenuLabel>
          <MenuItem icon={FileSpreadsheet} onSelect={() => void exportAs('xlsx')}>
            Excel workbook (.xlsx)
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={FileText} onSelect={() => void exportAs('csv')}>
            “{sheetName}” as CSV
          </MenuItem>
        </MenuContent>
      </Menu>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void insertCsv(f);
        }}
      />
    </header>
  );
});

/** CSV → TSV for pasting (quoted fields keep commas, quotes and newlines). */
function csvToTsv(text: string): string {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      out.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out.map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\n');
}
