/**
 * Formula editor (§14.6): syntax-highlighted input with error spans, property and function palettes with docs,
 * and a live preview of the first rows through `db_formula_check` (debounced; stale responses dropped).
 */
import { AlertCircle, CheckCircle2, Sigma } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, latestRequest } from '@/backend';
import type { FormulaCheckResult, Id, Property } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { SearchField } from '@/ui/SearchField';
import { FUNCTIONS, highlight, toDisplay } from './engine/formula';
import { TYPE_META } from './engine/schema';
import { TypeIcon } from './properties/meta';

export interface FormulaEditorProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  databaseId: Id;
  properties: Property[];
  /** Storage form (`prop("#id")`) or display form. */
  expression: string;
  propertyId?: Id;
  title?: string;
  onSave: (displayExpression: string) => void;
}

const KIND_LABEL: Record<string, string> = { number: 'Number', money: 'Money', text: 'Text', bool: 'Checkbox', date: 'Date', list: 'List' };

const EXAMPLES: { label: string; expr: string }[] = [
  { label: 'Days until a date', expr: 'dateBetween(prop("Date"), today(), "days")' },
  { label: 'Status label', expr: 'if(prop("Done"), "Done", "Open")' },
  { label: 'Sum related amounts', expr: 'prop("Related").map(current.prop("Amount")).sum()' },
  { label: 'Monthly payment', expr: 'round(pmt(0.05 / 12, 360, 250000), 2)' },
];

function Highlighted({ text, error }: { text: string; error?: { from: number; to: number } }) {
  const toks = useMemo(() => highlight(text), [text]);
  const out: ReactNode[] = [];
  let pos = 0;
  toks.forEach((t, i) => {
    if (t.from > pos) out.push(<span key={`g${i}`}>{text.slice(pos, t.from)}</span>);
    const isErr = error && t.from < error.to && t.to > error.from;
    out.push(
      <span key={i} className={cn(`edb-fx-${t.cls}`, isErr && 'edb-fx-err')}>
        {text.slice(t.from, t.to)}
      </span>,
    );
    pos = t.to;
  });
  if (pos < text.length) out.push(<span key="tail">{text.slice(pos)}</span>);
  if (error && error.from >= text.length) out.push(<span key="eof" className="edb-fx-err edb-fx-eof"> </span>);
  return <>{out}{'\n'}</>;
}

export function FormulaEditor({ open, onOpenChange, databaseId, properties, expression, propertyId, title = 'Formula', onSave }: FormulaEditorProps) {
  const [text, setText] = useState(() => toDisplay(expression, properties));
  const [res, setRes] = useState<FormulaCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<{ sig: string; doc: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const latest = useMemo(() => latestRequest(), []);

  useEffect(() => {
    if (open) setText(toDisplay(expression, properties));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!text.trim()) {
      setRes(null);
      return;
    }
    setChecking(true);
    const id = latest.next();
    const h = setTimeout(() => {
      api.db
        .formulaCheck({ databaseId, expression: text })
        .then((r) => latest.isLatest(id) && setRes(r))
        .catch(() => undefined)
        .finally(() => latest.isLatest(id) && setChecking(false));
    }, 180);
    return () => clearTimeout(h);
  }, [text, open, databaseId, latest]);

  const insert = (s: string, caretBack = 0) => {
    const el = ta.current;
    if (!el) return setText((t) => t + s);
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const next = text.slice(0, a) + s + text.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const p = a + s.length - caretBack;
      el.setSelectionRange(p, p);
    });
  };

  const others = properties.filter((p) => p.id !== propertyId && p.type !== 'secret');
  const s = q.trim().toLowerCase();
  const propList = others.filter((p) => !s || p.name.toLowerCase().includes(s));
  const groups = useMemo(() => {
    const g = new Map<string, [string, (typeof FUNCTIONS)[string]][]>();
    for (const [name, spec] of Object.entries(FUNCTIONS)) {
      if (s && !name.toLowerCase().includes(s)) continue;
      const list = g.get(spec.group) ?? [];
      list.push([name, spec]);
      g.set(spec.group, list);
    }
    return [...g.entries()];
  }, [s]);

  const err = res && !res.ok ? res.error : undefined;
  const preview = (res?.preview ?? []).map((p) => p.split('\u0000') as [string, string]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={title}
      description="Compute a value from other properties. Changes preview live on your first rows."
      icon={<Sigma size={18} aria-hidden />}
      bodyClassName="!pt-2"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!!err || !text.trim()} onClick={() => onSave(text)} kbd="mod+enter">
            Save formula
          </Button>
        </>
      }
    >
      <div className="edb-fx">
        <div className="edb-fx-main">
          <div className={cn('edb-fx-code', err && 'is-error')}>
            <pre ref={pre} aria-hidden className="edb-fx-pre">
              <Highlighted text={text} error={err ?? undefined} />
            </pre>
            <textarea
              ref={ta}
              className="edb-fx-input"
              value={text}
              spellCheck={false}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => {
                if (pre.current) pre.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  if (!err && text.trim()) onSave(text);
                } else if (e.key === '(' && !e.metaKey) {
                  // auto-close parens
                  e.preventDefault();
                  insert('()', 1);
                } else if (e.key === '"' && text[ta.current?.selectionStart ?? 0] !== '"') {
                  e.preventDefault();
                  insert('""', 1);
                }
              }}
              placeholder='e.g. prop("Price") * prop("Quantity")'
              aria-label="Formula"
              aria-invalid={!!err || undefined}
            />
          </div>
          <div className="edb-fx-status" role="status" aria-live="polite">
            {!text.trim() ? (
              <span className="text-tertiary">Type a formula, or start from an example below.</span>
            ) : err ? (
              <span className="text-loss-text flex items-center gap-1.5">
                <AlertCircle size={14} aria-hidden /> {err.message}
              </span>
            ) : res?.ok ? (
              <span className="flex items-center gap-1.5 text-secondary">
                <CheckCircle2 size={14} className="text-gain-text" aria-hidden /> Returns <b className="text-primary font-medium">{KIND_LABEL[res.type ?? 'text'] ?? res.type}</b>
                {checking ? <span className="text-tertiary"> · checking…</span> : null}
              </span>
            ) : (
              <span className="text-tertiary">Checking…</span>
            )}
          </div>
          {preview.length ? (
            <div className="edb-fx-preview">
              <div className="emp-menu-header !px-0">Preview</div>
              {preview.map(([title, value], i) => (
                <div key={i} className="edb-fx-prow">
                  <span className="truncate text-secondary">{title}</span>
                  <span className="truncate tabular-nums text-primary font-medium">{value || <span className="text-tertiary">Empty</span>}</span>
                </div>
              ))}
            </div>
          ) : !text.trim() ? (
            <div className="edb-fx-examples">
              {EXAMPLES.map((x) => (
                <button key={x.label} type="button" className="edb-fx-example" onClick={() => setText(x.expr)}>
                  <span className="text-body-sm font-medium">{x.label}</span>
                  <code>{x.expr}</code>
                </button>
              ))}
            </div>
          ) : null}
          <div className="edb-fx-doc">
            {hover ? (
              <>
                <code className="text-primary">{hover.sig}</code>
                <span className="text-secondary">{hover.doc}</span>
              </>
            ) : (
              <span className="text-tertiary">Hover a function to see how it works. Click to insert.</span>
            )}
          </div>
        </div>
        <aside className="edb-fx-side">
          <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Properties & functions" shortcut={null} size="sm" />
          <div className="edb-fx-list">
            {propList.length ? <div className="emp-menu-header">Properties</div> : null}
            {propList.map((p) => (
              <button key={p.id} type="button" className="emp-menu-item w-full" onClick={() => insert(`prop("${p.name.replace(/"/g, '\\"')}")`)} onMouseEnter={() => setHover({ sig: `prop("${p.name}")`, doc: `${TYPE_META[p.type].label} property.` })}>
                <span className="emp-menu-icon">
                  <TypeIcon type={p.type} size={14} />
                </span>
                <span className="emp-menu-label">{p.name}</span>
              </button>
            ))}
            {groups.map(([g, fns]) => (
              <div key={g}>
                <div className="emp-menu-header">{g}</div>
                {fns.map(([name, spec]) => (
                  <button key={name} type="button" className="emp-menu-item w-full font-mono" onClick={() => insert(spec.max === 0 ? `${name}()` : `${name}()`, spec.max === 0 ? 0 : 1)} onMouseEnter={() => setHover({ sig: spec.sig, doc: spec.doc })}>
                    <span className="emp-menu-label text-body-sm">{name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>
      </div>
    </Dialog>
  );
}

export default FormulaEditor;
