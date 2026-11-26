/**
 * React overlays requested by plain-DOM node views and keymaps: callout icon / emoji insert, code language, inline
 * equation, date mention, link editing and paste prompts ("Paste as mention", "Insert as database / spreadsheet").
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { AtSign, Check, ExternalLink, Link2, Sheet as SheetIcon, Table2, Trash2, X, Database } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/backend';
import type { CellValue, DateValue } from '@/backend/types';
import { cn } from '@/lib/cn';
import { formatDateValue, isoDay } from '@/lib/dates';
import { parseNatural } from '@/lib/nlp';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { Button } from '@/ui/Button';
import { Calendar } from '@/ui/DatePicker';
import { EmojiPicker } from '@/ui/EmojiPicker';
import { Switch } from '@/ui/Switch';
import { insertEmoji } from '../lib/editorCommands';
import { editorContext } from '../lib/context';
import { renderKatex } from '../lib/katex';
import { LANGUAGES, resolveLanguage } from '../lib/languages';
import { normaliseHref } from '../lib/links';
import { fuzzy } from '../lib/fuzzy';
import { openHref } from '../extensions/keymap';
import { findBlockById, currentBlock } from '../lib/blocks';
import { Floating } from './Floating';
import { useOverlay, type OverlayRequest } from './overlay';

function useReq(editor: Editor) {
  const req = useOverlay((s) => (s.req && s.req.editorId === editor.instanceId ? s.req : null));
  const close = useOverlay((s) => s.close);
  return { req, close };
}

export function OverlayHost({ editor }: { editor: Editor }) {
  const { req, close } = useReq(editor);
  if (!req) return null;
  const done = () => {
    close();
    requestAnimationFrame(() => editor.view.focus());
  };
  switch (req.kind) {
    case 'calloutIcon':
      return <IconOverlay key={req.pos} editor={editor} req={req} onDone={done} />;
    case 'codeLang':
      return <LanguageOverlay key={req.pos} editor={editor} req={req} onDone={done} />;
    case 'mathInline':
      return <MathInlineOverlay key={req.pos} editor={editor} req={req} onDone={done} />;
    case 'date':
      return <DateOverlay key={req.pos} editor={editor} req={req} onDone={done} />;
    case 'link':
      return <LinkOverlay key={`${req.pos}:${req.to}`} editor={editor} req={req} onDone={done} />;
    case 'pastePrompt':
      return <PastePrompt key={req.pos} editor={editor} req={req} onDone={close} />;
    default:
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────── icon / emoji

function IconOverlay({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const insert = !!req.data?.insert;
  return (
    <EmojiPicker
      open
      onOpenChange={(o) => !o && onDone()}
      onSelect={(emoji) => {
        if (insert) insertEmoji(editor, emoji, '');
        else {
          const node = editor.state.doc.nodeAt(req.pos);
          if (node?.type.name === 'callout') editor.view.dispatch(editor.state.tr.setNodeMarkup(req.pos, undefined, { ...node.attrs, icon: { t: 'emoji', v: emoji } }));
        }
        onDone();
      }}
    >
      <span aria-hidden style={{ position: 'fixed', left: req.rect.x, top: req.rect.y, width: req.rect.width, height: req.rect.height, pointerEvents: 'none' }} />
    </EmojiPicker>
  );
}

// ───────────────────────────────────────────────────────────────────────────── code language

function LanguageOverlay({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const node = editor.state.doc.nodeAt(req.pos);
  const current = resolveLanguage(node?.attrs.language as string).id;
  const list = useMemo(() => {
    if (!q.trim()) return LANGUAGES;
    return LANGUAGES.map((l) => ({ l, r: fuzzy(q, l.label) ?? (l.aliases.some((a) => a.startsWith(q.toLowerCase())) ? { score: 50, indices: [] } : null) }))
      .filter((x) => x.r)
      .sort((a, b) => (b.r?.score ?? 0) - (a.r?.score ?? 0))
      .map((x) => x.l);
  }, [q]);
  useEffect(() => setActive(0), [q]);
  const pick = (id: string) => {
    const n = editor.state.doc.nodeAt(req.pos);
    if (n?.type.name === 'codeBlock') editor.view.dispatch(editor.state.tr.setNodeMarkup(req.pos, undefined, { ...n.attrs, language: id }));
    onDone();
  };
  return (
    <Floating open anchor={req.rect} onClose={onDone} className="emp-picker emp-lang-picker" role="dialog" ariaLabel="Language" zIndex={45}>
      <div className="emp-picker-head">
        <input
          autoFocus
          className="emp-picker-input"
          placeholder="Search languages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(list.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (list[active]) pick(list[active].id);
            }
          }}
        />
      </div>
      <div className="emp-picker-list">
        {list.map((l, i) => (
          <button key={l.id} type="button" className={cn('emp-picker-item', i === active && 'is-active')} onMouseEnter={() => setActive(i)} onClick={() => pick(l.id)}>
            <span className="emp-picker-title">{l.label}</span>
            {l.id === current ? <Check size={14} className="emp-picker-check" /> : null}
          </button>
        ))}
      </div>
    </Floating>
  );
}

// ───────────────────────────────────────────────────────────────────────────── inline maths

export function MathEditor({ initial, display, onCommit, onCancel, onDelete }: { initial: string; display: boolean; onCommit: (latex: string) => void; onCancel: () => void; onDelete?: () => void }) {
  const [latex, setLatex] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!preview.current) return;
    if (!latex.trim()) {
      preview.current.replaceChildren();
      setError(null);
      return;
    }
    let live = true;
    void renderKatex(latex, preview.current, display).then((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [latex, display]);
  return (
    <div className="emp-math-editor">
      <textarea
        autoFocus
        className="emp-math-input"
        value={latex}
        spellCheck={false}
        placeholder={display ? 'E = mc^2' : 'x^2'}
        rows={display ? 3 : 1}
        onChange={(e) => setLatex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (!display || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit(latex);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="emp-math-preview" ref={preview} aria-live="polite" />
      <div className="emp-math-foot">
        <span className={cn('emp-math-status', error && 'is-error')}>{error ? error : latex.trim() ? 'Looks good' : 'TeX syntax, rendered with KaTeX'}</span>
        {onDelete ? (
          <Button size="xs" variant="ghost" icon={Trash2} onClick={onDelete}>
            Remove
          </Button>
        ) : null}
        <Button size="xs" variant="primary" kbd={display ? 'mod+enter' : 'enter'} onClick={() => onCommit(latex)}>
          Done
        </Button>
      </div>
    </div>
  );
}

function MathInlineOverlay({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const node = editor.state.doc.nodeAt(req.pos);
  const remove = () => {
    const n = editor.state.doc.nodeAt(req.pos);
    if (n?.type.name === 'mathInline') editor.view.dispatch(editor.state.tr.delete(req.pos, req.pos + n.nodeSize));
    onDone();
  };
  return (
    <Floating open anchor={req.rect} onClose={() => {
      const n = editor.state.doc.nodeAt(req.pos);
      if (n?.type.name === 'mathInline' && !String(n.attrs.latex ?? '').trim()) remove();
      else onDone();
    }} className="emp-popover-card" role="dialog" ariaLabel="Edit equation" zIndex={45}>
      <MathEditor
        initial={String(node?.attrs.latex ?? '')}
        display={false}
        onCancel={() => {
          if (!String(node?.attrs.latex ?? '').trim()) remove();
          else onDone();
        }}
        onDelete={remove}
        onCommit={(latex) => {
          const n = editor.state.doc.nodeAt(req.pos);
          if (!latex.trim()) return remove();
          if (n?.type.name === 'mathInline') {
            const tr = editor.state.tr.setNodeMarkup(req.pos, undefined, { latex });
            tr.setSelection(TextSelection.create(tr.doc, req.pos + 1));
            editor.view.dispatch(tr);
          }
          onDone();
        }}
      />
    </Floating>
  );
}

// ───────────────────────────────────────────────────────────────────────────── date mention

function DateOverlay({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const node = editor.state.doc.nodeAt(req.pos);
  const initial = (node?.attrs.date as DateValue | null) ?? { start: isoDay(), time: false };
  const [value, setValue] = useState<DateValue>(initial);
  const [text, setText] = useState('');
  const date = new Date(value.time ? value.start : `${value.start}T12:00:00`);
  const commit = (v: DateValue) => {
    const n = editor.state.doc.nodeAt(req.pos);
    if (n?.type.name === 'mention') editor.view.dispatch(editor.state.tr.setNodeMarkup(req.pos, undefined, { ...n.attrs, date: v }));
  };
  const set = (v: DateValue) => {
    setValue(v);
    commit(v);
  };
  const timeStr = value.time ? new Date(value.start).toTimeString().slice(0, 5) : '09:00';
  return (
    <Floating open anchor={req.rect} onClose={onDone} className="emp-popover-card emp-date-pop" role="dialog" ariaLabel="Edit date" zIndex={45}>
      <input
        autoFocus
        className="emp-date-nl"
        placeholder="Type a date, e.g. next fri 3pm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const p = parseNatural(text);
            if (p.start) {
              set(p.hasTime ? { start: p.start.toISOString(), time: true } : { start: isoDay(p.start), time: false });
              setText('');
            }
          } else if (e.key === 'Escape') onDone();
        }}
      />
      {text ? <div className="emp-date-parse">{(() => { const p = parseNatural(text); return p.start ? formatDateValue(p.hasTime ? { start: p.start.toISOString(), time: true } : { start: isoDay(p.start), time: false }) : 'Keep typing…'; })()}</div> : null}
      <Calendar
        value={date}
        onSelect={(d) => {
          if (value.time) {
            const [h, mm] = timeStr.split(':').map(Number);
            const nd = new Date(d);
            nd.setHours(h, mm, 0, 0);
            set({ start: nd.toISOString(), time: true });
          } else set({ start: isoDay(d), time: false });
        }}
      />
      <div className="emp-date-row">
        <Switch
          size="sm"
          checked={value.time}
          label="Include time"
          onCheckedChange={(on) => {
            if (on) {
              const d = new Date(`${value.start.slice(0, 10)}T09:00:00`);
              set({ start: d.toISOString(), time: true });
            } else set({ start: isoDay(new Date(value.start)), time: false });
          }}
        />
        {value.time ? (
          <input
            type="time"
            className="emp-date-time"
            value={timeStr}
            onChange={(e) => {
              const [h, mm] = e.target.value.split(':').map(Number);
              const d = new Date(value.start);
              d.setHours(h || 0, mm || 0, 0, 0);
              set({ start: d.toISOString(), time: true });
            }}
          />
        ) : null}
      </div>
      <div className="emp-date-foot">
        <span className="emp-date-value">{formatDateValue(value)}</span>
        <Button
          size="xs"
          variant="ghost"
          icon={Trash2}
          onClick={() => {
            const n = editor.state.doc.nodeAt(req.pos);
            if (n?.type.name === 'mention') editor.view.dispatch(editor.state.tr.delete(req.pos, req.pos + n.nodeSize));
            onDone();
          }}
        >
          Remove
        </Button>
      </div>
    </Floating>
  );
}

// ───────────────────────────────────────────────────────────────────────────── link

function LinkOverlay({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const [value, setValue] = useState(String(req.data?.href ?? ''));
  const [invalid, setInvalid] = useState(false);
  const from = req.pos;
  const to = req.to ?? req.pos;
  const apply = () => {
    const href = normaliseHref(value);
    const { state } = editor;
    if (!value.trim()) {
      editor.view.dispatch(state.tr.removeMark(from, to, state.schema.marks.link));
      onDone();
      return;
    }
    if (!href) {
      setInvalid(true);
      return;
    }
    const tr = state.tr.removeMark(from, to, state.schema.marks.link).addMark(from, to, state.schema.marks.link.create({ href }));
    tr.setSelection(TextSelection.create(tr.doc, to));
    editor.view.dispatch(tr);
    onDone();
  };
  return (
    <Floating open anchor={req.rect} onClose={onDone} placement="bottom-start" className="emp-popover-card emp-link-pop" role="dialog" ariaLabel="Edit link" zIndex={45}>
      <div className={cn('emp-link-field', invalid && 'is-invalid')}>
        <Link2 size={14} className="text-tertiary" />
        <input
          autoFocus
          value={value}
          placeholder="Paste a link, or emp://page/…"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onDone();
            }
          }}
        />
      </div>
      {invalid ? <div className="emp-link-error">Links must start with https://, http:// or mailto:</div> : null}
      <div className="emp-link-actions">
        {req.data?.href ? (
          <>
            <Button size="xs" variant="ghost" icon={ExternalLink} onClick={() => openHref(String(req.data?.href))}>
              Open
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={X}
              onClick={() => {
                editor.view.dispatch(editor.state.tr.removeMark(from, to, editor.state.schema.marks.link));
                onDone();
              }}
            >
              Remove
            </Button>
          </>
        ) : null}
        <span className="flex-1" />
        <Button size="xs" variant="primary" kbd="enter" onClick={apply}>
          {req.data?.href ? 'Save' : 'Link'}
        </Button>
      </div>
    </Floating>
  );
}

// ───────────────────────────────────────────────────────────────────────────── paste prompts

function PastePrompt({ editor, req, onDone }: { editor: Editor; req: OverlayRequest; onDone: () => void }) {
  const mode = req.data?.mode as 'mention' | 'grid';
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(onDone, 8000);
    const key = () => onDone();
    editor.view.dom.addEventListener('keydown', key, { once: true });
    return () => {
      clearTimeout(t);
      editor.view.dom.removeEventListener('keydown', key);
    };
  }, [editor, onDone]);

  if (mode === 'mention') {
    const pageId = String(req.data?.pageId ?? '');
    const title = useTree.getState().byId.get(pageId)?.title || 'page';
    return (
      <Floating open anchor={req.rect} onClose={onDone} className="emp-paste-chip" zIndex={45}>
        <button
          type="button"
          className="emp-paste-option"
          onClick={() => {
            const to = req.to ?? req.pos;
            const node = editor.schema.nodes.mention.create({ kind: 'page', pageId, date: null, reminderId: null });
            editor.view.dispatch(editor.state.tr.replaceWith(req.pos, to, node));
            onDone();
          }}
        >
          <AtSign size={14} /> Paste as mention of “{title}”
        </button>
        <button type="button" className="emp-paste-option is-muted" onClick={onDone}>
          Keep link
        </button>
      </Floating>
    );
  }

  const rows = (req.data?.rows as string[][] | undefined) ?? [];
  const findTable = () => {
    const info = currentBlock(editor.state);
    // The pasted table sits at (or just before) the caret.
    let pos = info?.pos ?? 0;
    const $p = editor.state.doc.resolve(Math.min(req.pos, editor.state.doc.content.size));
    for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'blockContainer') pos = $p.before(d);
    const b = editor.state.doc.nodeAt(pos);
    if (b?.firstChild?.type.name === 'table') return { pos, node: b };
    const after = info ? findBlockById(editor.state.doc, info.id) : null;
    return after ? { pos: after.pos, node: after.node } : null;
  };
  const replaceTableWith = (node: Parameters<typeof editor.schema.nodes.blockContainer.create>[1]) => {
    const t = findTable();
    if (!t || t.node.firstChild?.type.name !== 'table') return;
    const container = editor.schema.nodes.blockContainer.create(null, node);
    editor.view.dispatch(editor.state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, container));
  };
  const asDatabase = async () => {
    setBusy(true);
    const ctx = editorContext(editor);
    try {
      const [header, ...body] = rows;
      const res = await api.db.create({
        workspaceId: ctx.workspaceId,
        parentId: ctx.parentPageId,
        title: 'Pasted data',
        inline: true,
        properties: header.slice(1).map((name) => ({ name: name || 'Column', type: 'text' as const })),
      });
      const titleProp = res.schema.properties.find((p) => p.type === 'title');
      const others = res.schema.properties.filter((p) => p.type !== 'title');
      for (const r of body) {
        const values: Record<string, CellValue> = {};
        if (titleProp) values[titleProp.id] = { t: 'text', v: [{ text: r[0] ?? '' }] };
        others.forEach((p, i) => (values[p.id] = { t: 'text', v: [{ text: r[i + 1] ?? '' }] }));
        await api.db.rowCreate({ databaseId: res.schema.database.id, values });
      }
      useTree.getState().upsert([res.page]);
      replaceTableWith(editor.schema.nodes.databaseView.create({ databaseId: res.schema.database.id, viewId: res.schema.views[0]?.id ?? null, linked: false, height: null }));
      onDone();
    } catch (e) {
      notify.fromError(e, "Couldn't create a database from that data");
      setBusy(false);
    }
  };
  const asSheet = async () => {
    setBusy(true);
    const ctx = editorContext(editor);
    try {
      const res = await api.sheet.workbookCreate({ workspaceId: ctx.workspaceId, parentId: ctx.parentPageId, title: 'Pasted data' });
      const sheet = res.sheets[0];
      if (sheet) {
        const edits = rows.flatMap((r, ri) => r.map((c, ci) => ({ row: ri, col: ci, input: c || null })));
        await api.sheet.setCells({ sheetId: sheet.id, edits, visible: { r0: 0, c0: 0, r1: rows.length, c1: rows[0]?.length ?? 1 } });
      }
      useTree.getState().upsert([res.page]);
      const range = `A1:${String.fromCharCode(64 + Math.min(26, rows[0]?.length ?? 1))}${rows.length}`;
      replaceTableWith(editor.schema.nodes.sheetEmbed.create({ workbookId: res.page.id, sheetId: sheet?.id ?? null, range }));
      onDone();
    } catch (e) {
      notify.fromError(e, "Couldn't create a spreadsheet from that data");
      setBusy(false);
    }
  };
  return (
    <Floating open anchor={req.rect} onClose={onDone} placement="top-start" className="emp-paste-chip" zIndex={45}>
      <span className="emp-paste-label">
        <Table2 size={14} /> Inserted as table
      </span>
      <button type="button" className="emp-paste-option" disabled={busy} onClick={() => void asDatabase()}>
        <Database size={14} /> Database
      </button>
      <button type="button" className="emp-paste-option" disabled={busy} onClick={() => void asSheet()}>
        <SheetIcon size={14} /> Spreadsheet
      </button>
      <button type="button" className="emp-paste-option is-muted" onClick={onDone} aria-label="Dismiss">
        <X size={14} />
      </button>
    </Floating>
  );
}
