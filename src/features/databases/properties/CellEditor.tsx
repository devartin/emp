/**
 * Inline cell editors (one per property type), shown in a popover anchored over the cell (table, board cards,
 * row page). Text-like editors overlay the cell exactly; pickers open below it. Commit on Enter / blur / Esc.
 */
import * as RP from '@radix-ui/react-popover';
import { addDays, format as dfmt } from 'date-fns';
import { ArrowUpRight, Copy, ExternalLink, Eye, EyeOff, Lock, Paperclip, Plus, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, hasCode } from '@/backend';
import type { CellValue, DateValue, Icon, Id, Property, RecurrenceValue, RowDTO } from '@/backend/types';
import { cn } from '@/lib/cn';
import { parseMoneyInput } from '@/lib/money';
import { parseNatural } from '@/lib/nlp';
import { notify } from '@/stores/toasts';
import { usePrivacy } from '@/stores/privacy';
import { useVault } from '@/stores/vault';
import { useWorkspace } from '@/stores/workspace';
import { Button } from '@/ui/Button';
import { Calendar } from '@/ui/DatePicker';
import { IconButton } from '@/ui/IconButton';
import { Segmented } from '@/ui/Segmented';
import { Slider } from '@/ui/Slider';
import { Switch } from '@/ui/Switch';
import { pickFiles, uploadBlob } from '@/features/editor/lib/assets';
import { describeRRule, formatMoneyValue, moneyCurrency, numberConfig, tickerLabel } from '../engine/format';
import { cellOptionIds, isReadOnlyType, parseDateString, plainText, rt } from '../engine/values';
import { relationCache, useSchemas } from '../store';
import { AssetThumb, openUrl } from './CellView';
import { OptionPicker } from './OptionPicker';

export interface CellEditorProps {
  databaseId: Id;
  prop: Property;
  row: RowDTO | null;
  cell: CellValue | undefined;
  onCommit: (v: CellValue | null) => void;
  onClose: (reason?: 'enter' | 'tab' | 'escape' | 'outside') => void;
  /** First key typed into the cell (starts text editing with that character). */
  initialText?: string;
}

/** Types that open as an overlay matching the cell box. */
const OVERLAY = new Set(['title', 'text', 'number', 'money', 'url', 'email', 'phone', 'ticker']);

export function editorKind(p: Property): 'overlay' | 'popover' | 'none' {
  if (isReadOnlyType(p.type) || p.type === 'checkbox' || p.type === 'rating') return 'none';
  return OVERLAY.has(p.type) ? 'overlay' : 'popover';
}

// ───────────────────────────────────────────────────────────────────────────── host

export function CellEditorPopover({ anchor, overlay, width, children, onOutside }: { anchor: DOMRect; overlay: boolean; width?: number; children: ReactNode; onOutside: () => void }) {
  const ref = useMemo(() => ({ current: { getBoundingClientRect: () => anchor } }), [anchor]);
  return (
    <RP.Root open onOpenChange={(o) => !o && onOutside()}>
      <RP.Anchor virtualRef={ref as never} />
      <RP.Portal>
        <RP.Content
          side="bottom"
          align="start"
          sideOffset={overlay ? -anchor.height : 4}
          alignOffset={0}
          avoidCollisions={!overlay}
          collisionPadding={8}
          className={cn('edb-editor', overlay ? 'edb-editor-overlay' : 'emp-pop edb-editor-pop')}
          style={{ minWidth: overlay ? Math.max(anchor.width, width ?? 0) : undefined, width: overlay ? undefined : width, zIndex: 70 }}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

/** Editor body for a property type. */
export function CellEditor(props: CellEditorProps) {
  const { prop } = props;
  switch (prop.type) {
    case 'title':
    case 'text':
      return <TextEditor {...props} />;
    case 'number':
      return <NumberEditor {...props} />;
    case 'money':
      return <MoneyEditor {...props} />;
    case 'url':
    case 'email':
    case 'phone':
      return <StringEditor {...props} />;
    case 'ticker':
      return <TickerEditor {...props} />;
    case 'select':
    case 'status':
    case 'multi_select':
      return <SelectEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'files':
      return <FilesEditor {...props} />;
    case 'relation':
      return <RelationEditor {...props} />;
    case 'progress':
      return <ProgressEditor {...props} />;
    case 'recurrence':
      return <RecurrenceEditor {...props} />;
    case 'secret':
      return <SecretEditor {...props} />;
    default:
      return null;
  }
}

function useAutoFocus<T extends HTMLInputElement | HTMLTextAreaElement>(selectAll = false) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);
  return ref;
}

function keyNav(e: KeyboardEvent, commit: (reason: 'enter' | 'tab' | 'escape') => void, multiline = false) {
  e.stopPropagation();
  if (e.key === 'Enter' && !(multiline && e.shiftKey) && !e.nativeEvent.isComposing) {
    e.preventDefault();
    commit('enter');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    commit('escape');
  } else if (e.key === 'Tab') {
    e.preventDefault();
    commit('tab');
  }
}

// ───────────────────────────────────────────────────────────────────────────── text

function TextEditor({ prop, cell, onCommit, onClose, initialText }: CellEditorProps) {
  const start = initialText ?? (cell?.t === 'text' ? plainText(cell.v) : '');
  const [v, setV] = useState(start);
  const ref = useAutoFocus<HTMLTextAreaElement>(false);
  const done = useRef(false);
  const commit = (reason?: 'enter' | 'tab' | 'escape' | 'outside') => {
    if (done.current) return;
    done.current = true;
    const orig = cell?.t === 'text' ? plainText(cell.v) : '';
    if (v !== orig) onCommit({ t: 'text', v: cell?.t === 'text' && v === orig ? cell.v : rt(prop.type === 'title' ? v.replace(/\n+/g, ' ') : v) });
    onClose(reason);
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(320, el.scrollHeight) + 'px';
  }, [v, ref]);
  return (
    <textarea
      ref={ref}
      className="edb-text-editor"
      value={v}
      rows={1}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => keyNav(e, commit, prop.type === 'text')}
      onBlur={() => commit('outside')}
      aria-label={prop.name}
      placeholder={prop.type === 'title' ? 'Untitled' : 'Empty'}
    />
  );
}

function StringEditor({ prop, cell, onCommit, onClose, initialText }: CellEditorProps) {
  const t = prop.type as 'url' | 'email' | 'phone';
  const orig = cell && (cell.t === 'url' || cell.t === 'email' || cell.t === 'phone') ? (cell.v ?? '') : '';
  const [v, setV] = useState(initialText ?? orig);
  const ref = useAutoFocus<HTMLInputElement>(false);
  const done = useRef(false);
  const commit = (reason?: 'enter' | 'tab' | 'escape' | 'outside') => {
    if (done.current) return;
    done.current = true;
    if (v.trim() !== orig) onCommit({ t, v: v.trim() || null });
    onClose(reason);
  };
  const href = t === 'url' ? v : t === 'email' ? `mailto:${v}` : `tel:${v.replace(/[^\d+]/g, '')}`;
  return (
    <div className="edb-string-editor">
      <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => keyNav(e, commit)} onBlur={() => commit('outside')} type={t === 'email' ? 'email' : t === 'phone' ? 'tel' : 'url'} placeholder={t === 'url' ? 'https://' : t === 'email' ? 'name@example.com' : '+1 555 0100'} aria-label={prop.name} spellCheck={false} />
      {v && t !== 'phone' ? (
        <IconButton size="xs" icon={ExternalLink} label="Open" onMouseDown={(e) => e.preventDefault()} onClick={() => openUrl(href)} />
      ) : null}
      {v ? <IconButton size="xs" icon={Copy} label="Copy" onMouseDown={(e) => e.preventDefault()} onClick={() => void navigator.clipboard?.writeText(v).then(() => notify.success('Copied'))} /> : null}
    </div>
  );
}

function TickerEditor({ prop, cell, onCommit, onClose, initialText }: CellEditorProps) {
  const orig = cell?.t === 'ticker' ? tickerLabel(cell.v) : '';
  const [v, setV] = useState((initialText ?? orig).toUpperCase());
  const ref = useAutoFocus<HTMLInputElement>(true);
  const done = useRef(false);
  const commit = (reason?: 'enter' | 'tab' | 'escape' | 'outside') => {
    if (done.current) return;
    done.current = true;
    if (v.trim() !== orig) onCommit({ t: 'ticker', v: v.trim() || null });
    onClose(reason);
  };
  return (
    <div className="edb-string-editor">
      <input ref={ref} value={v} onChange={(e) => setV(e.target.value.toUpperCase())} onKeyDown={(e) => keyNav(e, commit)} onBlur={() => commit('outside')} placeholder="EMPX" aria-label={prop.name} className="font-mono" spellCheck={false} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── numbers

function NumberEditor({ prop, cell, onCommit, onClose, initialText }: CellEditorProps) {
  const cfg = numberConfig(prop);
  const pct = cfg.format === 'percent';
  const orig = cell?.t === 'number' && cell.v !== null ? (pct ? +(cell.v * 100).toFixed(6) : cell.v) : null;
  const [v, setV] = useState(initialText ?? (orig === null ? '' : String(orig)));
  const ref = useAutoFocus<HTMLInputElement>(!initialText);
  const done = useRef(false);
  const [err, setErr] = useState(false);
  const commit = (reason?: 'enter' | 'tab' | 'escape' | 'outside') => {
    if (done.current) return;
    const s = v.trim().replace(/[,\s]/g, '').replace(/[−]/g, '-').replace(/%$/, '');
    if (s === '') {
      done.current = true;
      if (orig !== null) onCommit({ t: 'number', v: null });
      return onClose(reason);
    }
    let n = Number(s);
    if (!Number.isFinite(n)) {
      if (reason === 'escape' || reason === 'outside') {
        done.current = true;
        return onClose(reason);
      }
      setErr(true);
      return;
    }
    if (pct) n = n / 100;
    done.current = true;
    if (n !== (cell?.t === 'number' ? cell.v : null)) onCommit({ t: 'number', v: n });
    onClose(reason);
  };
  return (
    <div className={cn('edb-string-editor edb-num-editor', err && 'is-error')}>
      <input
        ref={ref}
        inputMode="decimal"
        value={v}
        onChange={(e) => {
          setErr(false);
          setV(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const cur = Number(v.replace(/,/g, '')) || 0;
            setV(String(+(cur + (e.key === 'ArrowUp' ? step : -step)).toFixed(6)));
            return;
          }
          keyNav(e, commit);
        }}
        onBlur={() => commit('outside')}
        aria-label={prop.name}
        aria-invalid={err || undefined}
      />
      {pct ? <span className="edb-affix">%</span> : null}
    </div>
  );
}

function MoneyEditor({ prop, cell, onCommit, onClose, initialText }: CellEditorProps) {
  const cur = moneyCurrency(prop, cell);
  const orig = cell?.t === 'money' ? (cell.v ?? '') : '';
  const [v, setV] = useState(initialText ?? orig);
  const [currency, setCurrency] = useState(cur);
  const ref = useAutoFocus<HTMLInputElement>(!initialText);
  const done = useRef(false);
  const [err, setErr] = useState(false);
  const perRow = !!prop.config.perRowCurrency;
  const commit = (reason?: 'enter' | 'tab' | 'escape' | 'outside') => {
    if (done.current) return;
    if (!v.trim()) {
      done.current = true;
      if (orig) onCommit({ t: 'money', v: null, cur: currency });
      return onClose(reason);
    }
    const amt = parseMoneyInput(v);
    if (amt === null) {
      if (reason === 'escape' || reason === 'outside') {
        done.current = true;
        return onClose(reason);
      }
      setErr(true);
      return;
    }
    done.current = true;
    if (amt !== orig || currency !== cur) onCommit({ t: 'money', v: amt, cur: currency });
    onClose(reason);
  };
  const sym = formatMoneyValue(0, currency).replace(/[\d.,\s]/g, '').trim() || currency;
  return (
    <div className={cn('edb-string-editor edb-num-editor', err && 'is-error')}>
      <span className="edb-affix">{sym}</span>
      <input ref={ref} inputMode="decimal" value={v} onChange={(e) => (setErr(false), setV(e.target.value))} onKeyDown={(e) => keyNav(e, commit)} onBlur={() => commit('outside')} aria-label={prop.name} aria-invalid={err || undefined} />
      {perRow ? (
        <select className="edb-cur-select" value={currency} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
          {['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'SEK', 'INR', 'BTC'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function ProgressEditor({ prop, cell, onCommit, onClose }: CellEditorProps) {
  const [v, setV] = useState(Math.round(((cell?.t === 'progress' ? cell.v : null) ?? 0) * 100));
  return (
    <div className="edb-pop-body" style={{ width: 240 }} onKeyDown={(e) => e.key === 'Enter' && (onCommit({ t: 'progress', v: v / 100 }), onClose('enter'))}>
      <div className="flex items-center justify-between">
        <span className="text-caption text-secondary">{prop.name}</span>
        <span className="text-body-sm font-semibold tabular-nums">{v}%</span>
      </div>
      <Slider value={[v]} min={0} max={100} step={5} onValueChange={([x]) => setV(x)} onValueCommit={([x]) => onCommit({ t: 'progress', v: x / 100 })} formatValue={(n) => `${n}%`} aria-label={prop.name} />
      <div className="flex gap-1">
        {[0, 25, 50, 75, 100].map((n) => (
          <button key={n} type="button" className="edb-quick" data-on={v === n ? '' : undefined} onClick={() => (setV(n), onCommit({ t: 'progress', v: n / 100 }))}>
            {n}%
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── select

function SelectEditor({ databaseId, prop, cell, onCommit, onClose }: CellEditorProps) {
  const [ids, setIds] = useState<Id[]>(cellOptionIds(cell));
  const multi = prop.type === 'multi_select';
  const write = (next: Id[]) => {
    setIds(next);
    if (multi) onCommit({ t: 'multi', v: next });
    else onCommit({ t: prop.type as 'select' | 'status', v: next[0] ?? null });
  };
  return (
    <div style={{ width: 280 }}>
      <OptionPicker databaseId={databaseId} prop={prop} value={ids} multi={multi} onChange={write} onDone={() => onClose('enter')} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── date

function toLocalDate(s: string | undefined): Date | null {
  const t = parseDateString(s);
  return t === null ? null : new Date(t);
}
function dayStr(d: Date) {
  return dfmt(d, 'yyyy-MM-dd');
}
function timeStr(d: Date) {
  return dfmt(d, 'HH:mm');
}
function withTime(d: Date, hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  const x = new Date(d);
  x.setHours(h || 0, m || 0, 0, 0);
  return x;
}

export function DateEditor({ prop, cell, onCommit, onClose }: CellEditorProps) {
  const init = cell?.t === 'date' ? cell.v : null;
  const [val, setVal] = useState<DateValue | null>(init);
  const [editing, setEditing] = useState<'start' | 'end'>('start');
  const [text, setText] = useState('');
  const start = toLocalDate(val?.start);
  const end = toLocalDate(val?.end);
  const write = (next: DateValue | null) => {
    setVal(next);
    onCommit(next ? { t: 'date', v: next } : { t: 'date', v: null });
  };
  const pick = (d: Date) => {
    const time = val?.time ?? false;
    const mk = (x: Date, prev: Date | null) => (time ? withTime(x, prev ? timeStr(prev) : '09:00').toISOString() : dayStr(x));
    if (!val) return write({ start: mk(d, null), time });
    if (editing === 'end' || (val.end !== undefined && editing === 'start' && false)) {
      const s = start ?? d;
      const [a, b] = d < s ? [d, s] : [s, d];
      write({ ...val, start: mk(a, start), end: mk(b, end ?? start) });
      setEditing('start');
    } else if (val.end !== undefined) {
      write({ ...val, start: mk(d, start), end: end && end < d ? mk(d, end) : val.end });
      setEditing('end');
    } else write({ ...val, start: mk(d, start) });
  };
  const parseText = () => {
    const s = text.trim();
    if (!s) return;
    const r = parseNatural(s, new Date());
    if (r.start) {
      write({ start: r.hasTime ? r.start.toISOString() : dayStr(r.start), ...(r.end ? { end: r.hasTime ? r.end.toISOString() : dayStr(r.end) } : {}), time: r.hasTime });
      setText('');
    } else notify.info("Couldn't read that date", { description: 'Try “next friday”, “dec 3”, or “tomorrow 3pm”.' });
  };
  return (
    <div className="edb-date-editor" onKeyDown={(e) => e.stopPropagation()}>
      <div className="edb-date-fields">
        <input
          className="edb-input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim()) parseText();
              else onClose('enter');
            } else if (e.key === 'Escape') onClose('escape');
          }}
          placeholder={start ? (val?.time ? dfmt(start, 'MMM d, yyyy h:mm a') : dfmt(start, 'MMM d, yyyy')) + (end ? ' → ' + dfmt(end, val?.time ? 'MMM d h:mm a' : 'MMM d, yyyy') : '') : 'Type a date — “next fri”, “dec 3”'}
          aria-label="Date"
        />
      </div>
      {val?.end !== undefined ? (
        <Segmented
          size="sm"
          block
          value={editing}
          onValueChange={setEditing}
          options={[
            { value: 'start', label: start ? dfmt(start, 'MMM d') : 'Start' },
            { value: 'end', label: end ? dfmt(end, 'MMM d') : 'End' },
          ]}
          aria-label="Edit start or end"
        />
      ) : null}
      <Calendar value={start} rangeEnd={end} onSelect={pick} />
      <div className="edb-date-opts">
        <Switch size="sm" label="End date" checked={val?.end !== undefined} onCheckedChange={(on) => {
          if (!val) return;
          if (on) {
            write({ ...val, end: val.time ? addDays(start ?? new Date(), 1).toISOString() : dayStr(addDays(start ?? new Date(), 1)) });
            setEditing('end');
          } else {
            const { end: _e, ...rest } = val;
            write(rest);
            setEditing('start');
          }
        }} />
        <Switch size="sm" label="Include time" checked={!!val?.time} onCheckedChange={(on) => {
          if (!val || !start) return;
          if (on) write({ start: withTime(start, '09:00').toISOString(), ...(end ? { end: withTime(end, '10:00').toISOString() } : {}), time: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
          else write({ start: dayStr(start), ...(end ? { end: dayStr(end) } : {}), time: false });
        }} />
        {val?.time && start ? (
          <div className="flex items-center gap-2">
            <input type="time" className="edb-input edb-time" value={timeStr(start)} onChange={(e) => write({ ...val, start: withTime(start, e.target.value).toISOString() })} aria-label="Start time" />
            {end ? <input type="time" className="edb-input edb-time" value={timeStr(end)} onChange={(e) => write({ ...val, end: withTime(end, e.target.value).toISOString() })} aria-label="End time" /> : null}
          </div>
        ) : null}
      </div>
      <div className="edb-date-foot">
        <Button size="xs" variant="ghost" onClick={() => write({ start: dayStr(new Date()), time: false })}>Today</Button>
        <Button size="xs" variant="ghost" onClick={() => write({ start: dayStr(addDays(new Date(), 1)), time: false })}>Tomorrow</Button>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" icon={Trash2} disabled={!val} onClick={() => write(null)}>Clear</Button>
      </div>
      <span className="sr-only">{prop.name}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── files

function FilesEditor({ prop, cell, onCommit }: CellEditorProps) {
  const [files, setFiles] = useState(cell?.t === 'files' ? cell.v : []);
  const wsId = useWorkspace((s) => s.workspace?.id);
  const [busy, setBusy] = useState(false);
  const write = (next: typeof files) => {
    setFiles(next);
    onCommit({ t: 'files', v: next });
  };
  const add = async () => {
    if (!wsId) return;
    const picked = await pickFiles('*/*', true);
    if (!picked.length) return;
    setBusy(true);
    try {
      const out = [...files];
      for (const f of picked) {
        if (f.size > 50 * 1024 * 1024) {
          notify.warning(`${f.name} is over 50 MB`);
          continue;
        }
        const a = await uploadBlob(wsId, f, f.name);
        out.push({ assetId: a.id, name: f.name });
      }
      write(out);
    } catch (e) {
      notify.fromError(e, "Couldn't attach the file");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="edb-pop-body" style={{ width: 300 }}>
      {files.length ? (
        <div className="flex flex-col gap-1">
          {files.map((f) => (
            <div key={f.assetId} className="edb-file-row">
              <AssetThumb id={f.assetId} className="edb-file-thumb" />
              <span className="flex-1 truncate text-body-sm">{f.name}</span>
              <IconButton size="xs" icon={X} label="Remove" onClick={() => write(files.filter((x) => x.assetId !== f.assetId))} />
            </div>
          ))}
        </div>
      ) : (
        <div className="edb-picker-empty">
          <Paperclip size={14} aria-hidden /> No files yet
        </div>
      )}
      <Button size="sm" variant="secondary" icon={Upload} loading={busy} onClick={() => void add()} block>
        Upload {prop.name.toLowerCase() === 'cover' ? 'a cover' : 'files'}
      </Button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── relation

function RelationEditor({ prop, cell, onCommit }: CellEditorProps) {
  const [ids, setIds] = useState<Id[]>(cell?.t === 'relation' ? cell.v : []);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<{ id: Id; title: string; icon?: Icon }[]>([]);
  const [hi, setHi] = useState(0);
  const target = String(prop.config.targetDatabaseId ?? '');
  const targetSchema = useSchemas((s) => s.schemas[target]);
  const one = prop.config.limit === 'one';
  useEffect(() => {
    if (target) void useSchemas.getState().load(target);
  }, [target]);
  useEffect(() => {
    let live = true;
    const h = setTimeout(() => {
      api.db
        .relationOptions({ propertyId: prop.id, search: q, limit: 50 })
        .then((list) => {
          if (!live) return;
          setOpts(list);
          for (const o of list) relationCache.remember(prop.id, o.id, o.title, o.icon);
        })
        .catch(() => undefined);
    }, q ? 120 : 0);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [q, prop.id]);
  const write = (next: Id[]) => {
    setIds(next);
    onCommit({ t: 'relation', v: next });
  };
  const toggle = (id: Id) => write(ids.includes(id) ? ids.filter((x) => x !== id) : one ? [id] : [...ids, id]);
  const createNew = async () => {
    if (!targetSchema || !q.trim()) return;
    try {
      const row = await api.db.rowCreate({ databaseId: target, values: { [targetSchema.database.primaryPropId]: { t: 'text', v: rt(q.trim()) } } });
      relationCache.remember(prop.id, row.id, q.trim());
      toggle(row.id);
      setQ('');
    } catch (e) {
      notify.fromError(e, "Couldn't create the row");
    }
  };
  const linked = ids.map((id) => ({ id, ...(relationCache.title(prop.id, id) ?? opts.find((o) => o.id === id) ?? { title: '…' }) }));
  const rest = opts.filter((o) => !ids.includes(o.id));
  return (
    <div className="edb-picker" style={{ width: 320 }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="edb-picker-input">
        <input
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setHi(0))}
          placeholder={`Link ${targetSchema?.database.title || 'a row'}…`}
          aria-label="Search rows"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(rest.length, h + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (rest[hi]) toggle(rest[hi].id);
              else if (q.trim()) void createNew();
            }
          }}
        />
      </div>
      <div className="edb-picker-list">
        {linked.length ? <div className="emp-menu-header">Linked{one ? ' (one)' : ''}</div> : null}
        {linked.map((o) => (
          <div key={o.id} className="edb-picker-item">
            <span className="edb-rel-icon">{o.icon?.t === 'emoji' ? o.icon.v : <ArrowUpRight size={12} aria-hidden />}</span>
            <span className="flex-1 truncate">{o.title}</span>
            <IconButton size="xs" icon={X} label="Unlink" onClick={() => toggle(o.id)} />
          </div>
        ))}
        <div className="emp-menu-header">{q ? 'Results' : 'Recent'}</div>
        {rest.map((o, i) => (
          <div key={o.id} className={cn('edb-picker-item', i === hi && 'is-hi')} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.id)}>
            <span className="edb-rel-icon">{o.icon?.t === 'emoji' ? o.icon.v : <ArrowUpRight size={12} aria-hidden />}</span>
            <span className="flex-1 truncate">{o.title}</span>
            <Plus size={14} className="text-tertiary" aria-hidden />
          </div>
        ))}
        {q.trim() && targetSchema ? (
          <div className={cn('edb-picker-item', hi === rest.length && 'is-hi')} onMouseDown={(e) => e.preventDefault()} onClick={() => void createNew()}>
            <Plus size={14} className="text-tertiary" aria-hidden />
            <span className="truncate">
              New row “{q.trim()}” in {targetSchema.database.title || 'Untitled'}
            </span>
          </div>
        ) : null}
        {!rest.length && !q ? <div className="edb-picker-empty">No rows in {targetSchema?.database.title || 'the linked database'} yet.</div> : null}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── recurrence

const FREQS = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'YEARLY', label: 'Yearly' },
] as const;
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

function parseRule(r: RecurrenceValue | null) {
  const parts = Object.fromEntries((r?.rrule ?? 'FREQ=WEEKLY').replace(/^RRULE:/i, '').split(';').map((kv) => kv.split('=') as [string, string]));
  return { freq: (parts.FREQ ?? 'WEEKLY') as (typeof FREQS)[number]['value'], interval: Number(parts.INTERVAL ?? 1) || 1, byDay: parts.BYDAY ? parts.BYDAY.split(',') : [] };
}

function RecurrenceEditor({ cell, onCommit }: CellEditorProps) {
  const init = cell?.t === 'recurrence' ? cell.v : null;
  const r0 = parseRule(init);
  const [freq, setFreq] = useState(r0.freq);
  const [interval, setInterval] = useState(r0.interval);
  const [byDay, setByDay] = useState<string[]>(r0.byDay);
  const [mode, setMode] = useState<RecurrenceValue['mode']>(init?.mode ?? 'schedule');
  const [dtstart, setDtstart] = useState(init?.dtstart ?? dfmt(new Date(), 'yyyy-MM-dd'));
  const value: RecurrenceValue = { rrule: `FREQ=${freq}${interval > 1 ? `;INTERVAL=${interval}` : ''}${freq === 'WEEKLY' && byDay.length ? `;BYDAY=${byDay.join(',')}` : ''}`, dtstart, mode };
  const save = (v: RecurrenceValue | null) => onCommit({ t: 'recurrence', v });
  return (
    <div className="edb-pop-body" style={{ width: 300 }}>
      <Segmented size="sm" block value={freq} onValueChange={(f) => setFreq(f)} options={FREQS.map((f) => ({ value: f.value, label: f.label }))} aria-label="Frequency" />
      <label className="edb-field-row">
        <span>Every</span>
        <input type="number" min={1} max={99} className="edb-input w-16" value={interval} onChange={(e) => setInterval(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} />
        <span>{freq === 'DAILY' ? 'day' : freq === 'WEEKLY' ? 'week' : freq === 'MONTHLY' ? 'month' : 'year'}{interval > 1 ? 's' : ''}</span>
      </label>
      {freq === 'WEEKLY' ? (
        <div className="flex gap-1">
          {WEEKDAYS.map((d) => (
            <button key={d} type="button" className="edb-quick edb-weekday" data-on={byDay.includes(d) ? '' : undefined} onClick={() => setByDay(byDay.includes(d) ? byDay.filter((x) => x !== d) : [...byDay, d])} aria-pressed={byDay.includes(d)}>
              {d.slice(0, 1)}
            </button>
          ))}
        </div>
      ) : null}
      <label className="edb-field-row">
        <span>Starting</span>
        <input type="date" className="edb-input" value={dtstart.slice(0, 10)} onChange={(e) => setDtstart(e.target.value)} />
      </label>
      <Segmented size="sm" block value={mode} onValueChange={setMode} options={[{ value: 'schedule', label: 'On schedule' }, { value: 'completion', label: 'After completion' }]} aria-label="Repeat mode" />
      <div className="edb-hint">{describeRRule(value)}</div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => save(value)}>Save</Button>
        {init ? <Button size="sm" variant="ghost" onClick={() => save(null)}>Remove</Button> : null}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────── secret

function SecretEditor({ prop, row, cell, onCommit, onClose }: CellEditorProps) {
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [needAuth, setNeedAuth] = useState(false);
  const [pw, setPw] = useState('');
  const hidden = usePrivacy((s) => s.hidden);
  const masked = cell?.t === 'secret' ? cell.v?.masked : undefined;
  useEffect(() => {
    if (!revealed) return;
    const h = setTimeout(() => setRevealed(null), 30_000);
    return () => clearTimeout(h);
  }, [revealed]);
  const reveal = async () => {
    if (!row) return;
    try {
      const r = await api.row.secretReveal({ rowId: row.id, propertyId: prop.id });
      setRevealed(r.value);
      setNeedAuth(false);
    } catch (e) {
      if (hasCode(e, 'REAUTH_REQUIRED')) setNeedAuth(true);
      else notify.fromError(e, "Couldn't reveal the secret");
    }
  };
  return (
    <div className="edb-pop-body" style={{ width: 300 }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 text-body-sm">
        <Lock size={14} className="text-tertiary" aria-hidden />
        <span className="flex-1 font-mono slashed">{revealed ?? masked ?? 'Nothing stored'}</span>
        {masked ? <IconButton size="xs" icon={revealed ? EyeOff : Eye} label={revealed ? 'Hide' : 'Reveal for 30 s'} disabled={hidden} onClick={() => (revealed ? setRevealed(null) : void reveal())} /> : null}
        {revealed ? <IconButton size="xs" icon={Copy} label="Copy" onClick={() => void usePrivacy.getState().copySensitive(revealed)} /> : null}
      </div>
      {needAuth ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await useVault.getState().reauth(pw);
              setPw('');
              await reveal();
            } catch (err) {
              notify.fromError(err, 'That password didn’t work');
            }
          }}
        >
          <input type="password" className="edb-input flex-1" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Confirm your password" autoComplete="off" />
          <Button size="sm" type="submit" variant="secondary">Confirm</Button>
        </form>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value) return;
          onCommit({ t: 'secret', v: { masked: value } });
          setValue('');
          onClose('enter');
        }}
      >
        <input type="password" className="edb-input flex-1" value={value} onChange={(e) => setValue(e.target.value)} placeholder={masked ? 'Replace value' : 'Enter a value'} autoComplete="off" spellCheck={false} data-1p-ignore aria-label="Secret value" />
        <Button size="sm" type="submit" variant="primary" disabled={!value}>Save</Button>
      </form>
      <div className="edb-hint">Stored encrypted. Excluded from search, export and previews.</div>
    </div>
  );
}
