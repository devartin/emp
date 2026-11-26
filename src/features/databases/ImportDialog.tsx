/**
 * Import CSV / XLSX into this database: pick a file (grant), preview the columns with inferred types, map each
 * column to an existing property / a new property / skip, then run `db_import_csv` with live progress.
 */
import { ArrowRight, FileSpreadsheet } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { useState } from 'react';
import { api, errorMessage, hasCode } from '@/backend';
import type { DbImportPreview, FileGrant, Id } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { FileDropZone } from '@/ui/FileDropZone';
import { Progress } from '@/ui/Progress';
import { Select } from '@/ui/Select';
import { useDbView } from './context';
import { TYPE_META } from './engine/schema';
import { TypeIcon } from './properties/meta';
import { reloadSchema } from './store';

type Phase =
  | { t: 'pick' }
  | { t: 'reading' }
  | { t: 'map'; grant: FileGrant; preview: DbImportPreview }
  | { t: 'running'; done: number; total: number }
  | { t: 'done'; inserted: number }
  | { t: 'error'; message: string };

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { schema, databaseId, controller } = useDbView();
  const [phase, setPhase] = useState<Phase>({ t: 'pick' });
  const [mapping, setMapping] = useState<Record<string, Id | 'new' | 'skip'>>({});

  const pick = async () => {
    try {
      const grants = await api.file.pick({ purpose: 'import', filters: [{ name: 'Spreadsheets', extensions: ['csv', 'tsv', 'xlsx'] }], multiple: false });
      const g = grants[0];
      if (!g) return;
      setPhase({ t: 'reading' });
      const preview = await api.db.importPreview({ grantId: g.grantId });
      const m: Record<string, Id | 'new' | 'skip'> = {};
      preview.columns.forEach((c, i) => {
        const match = schema.properties.find((p) => p.name.toLowerCase() === c.name.toLowerCase()) ?? (i === 0 ? schema.properties.find((p) => p.type === 'title') : undefined);
        m[c.name] = match && match.type !== 'formula' && match.type !== 'rollup' ? match.id : 'new';
      });
      setMapping(m);
      setPhase({ t: 'map', grant: g, preview });
    } catch (e) {
      setPhase({ t: 'error', message: errorMessage(e) || "Couldn't read that file" });
    }
  };

  const run = async (grant: FileGrant, total: number) => {
    setPhase({ t: 'running', done: 0, total });
    try {
      const job = await api.db.importCsv({
        grantId: grant.grantId,
        target: { databaseId, mapping },
        onEvent: (e) => e.kind === 'progress' && e.total > 0 && setPhase({ t: 'running', done: e.done, total: e.total }),
      });
      const r = await job.result;
      await reloadSchema(databaseId);
      controller.reset();
      setPhase({ t: 'done', inserted: r.inserted });
      notify.success(`Imported ${r.inserted} ${r.inserted === 1 ? 'row' : 'rows'}`);
    } catch (e) {
      if (hasCode(e, 'CANCELLED')) return setPhase({ t: 'pick' });
      setPhase({ t: 'error', message: errorMessage(e) || 'The import didn’t finish' });
    }
  };

  const targets = schema.properties.filter((p) => !['formula', 'rollup', 'created_time', 'updated_time', 'unique_id', 'computed', 'relation', 'files', 'secret'].includes(p.type));
  const busy = phase.t === 'running' || phase.t === 'reading';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      dismissible={!busy}
      size={phase.t === 'map' ? 'lg' : 'md'}
      title={`Import into ${schema.database.title || 'this database'}`}
      description="CSV, TSV or Excel (.xlsx). Files are read on this device; formulas in spreadsheets are never run."
      footer={
        phase.t === 'map' ? (
          <>
            <Button variant="ghost" onClick={() => setPhase({ t: 'pick' })}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void run(phase.grant, phase.preview.rows)} disabled={!Object.values(mapping).some((v) => v !== 'skip')}>
              Import {phase.preview.rows.toLocaleString()} rows
            </Button>
          </>
        ) : phase.t === 'done' ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : undefined
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={phase.t} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.16 } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          {phase.t === 'pick' || phase.t === 'reading' ? (
            <FileDropZone title="Choose a CSV or Excel file" hint="Click to browse · .csv, .tsv or .xlsx up to 50 MB" onBrowse={() => void pick()} onFiles={() => void pick()} />
          ) : phase.t === 'map' ? (
            <div className="edb-import">
              <div className="edb-import-meta">
                <FileSpreadsheet size={16} aria-hidden />
                <span className="font-medium">{phase.grant.displayName}</span>
                <span className="text-tertiary">
                  · {phase.preview.rows.toLocaleString()} rows · {phase.preview.columns.length} columns
                  {phase.preview.delimiter !== 'xlsx' ? ` · delimiter “${phase.preview.delimiter === '\t' ? 'tab' : phase.preview.delimiter}”` : ''}
                </span>
              </div>
              <div className="edb-import-grid">
                <div className="edb-import-head">
                  <span>Column</span>
                  <span />
                  <span>Imports into</span>
                  <span>Sample</span>
                </div>
                {phase.preview.columns.map((c) => (
                  <div key={c.name} className="edb-import-row">
                    <span className="truncate font-medium">{c.name}</span>
                    <ArrowRight size={14} className="text-tertiary" aria-hidden />
                    <Select
                      size="sm"
                      searchable
                      value={mapping[c.name] ?? 'skip'}
                      onValueChange={(v) => setMapping((m0) => ({ ...m0, [c.name]: v }))}
                      options={[
                        { value: 'new', label: `New ${TYPE_META[c.inferred === 'title' ? 'text' : c.inferred].label} property`, icon: <TypeIcon type={c.inferred === 'title' ? 'text' : c.inferred} /> },
                        { value: 'skip', label: "Don't import" },
                        ...targets.map((p) => ({ value: p.id, label: p.name, icon: <TypeIcon type={p.type} />, group: 'Existing properties' })),
                      ]}
                    />
                    <span className="truncate text-tertiary text-body-sm">{c.sample.filter(Boolean).slice(0, 3).join(' · ') || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : phase.t === 'running' ? (
            <div className="flex flex-col gap-3 py-6">
              <div className="flex justify-between text-body-sm">
                <span>Importing…</span>
                <span className="tabular-nums text-secondary">
                  {phase.done.toLocaleString()} / {phase.total.toLocaleString()}
                </span>
              </div>
              <Progress value={phase.total ? phase.done / phase.total : 0} indeterminate={!phase.total} />
            </div>
          ) : phase.t === 'done' ? (
            <div className="py-6 text-body">
              Added <b>{phase.inserted.toLocaleString()}</b> {phase.inserted === 1 ? 'row' : 'rows'}.
              {Object.values(mapping).includes('new') ? ' New properties were created for unmatched columns.' : ''}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-loss-text">{phase.message}</div>
              <Button variant="secondary" onClick={() => setPhase({ t: 'pick' })}>
                Try another file
              </Button>
            </div>
          )}
        </m.div>
      </AnimatePresence>
    </Dialog>
  );
}
