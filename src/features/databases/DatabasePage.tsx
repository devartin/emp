/**
 * Database route entry (kind 'database' pages and `{t:'db'}` routes): icon, title, description and row counts above
 * the shared DatabaseView. The view id in the route selects the initial tab.
 */
import { Database, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/backend';
import type { Id, RichText } from '@/backend/types';
import { navigate } from '@/app/router';
import { notify } from '@/stores/toasts';
import { useTree } from '@/stores/tree';
import { glyphName, PageGlyph } from '@/ui/icons/Icon';
import { IconPicker } from '@/ui/IconPicker';
import { DatabaseView } from './DatabaseView';
import { plainText, rt } from './engine/values';
import { useSchemas } from './store';

export interface DatabasePageProps {
  pageId: Id;
  viewId?: Id;
}

function TitleInput({ id, title }: { id: Id; title: string }) {
  const [v, setV] = useState(title);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(title), [title]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  }, [v]);
  const save = () => {
    const t = v.trim();
    if (t !== title) void useTree.getState().updateMeta(id, { title: t });
  };
  return (
    <textarea
      ref={ref}
      className="edb-page-title"
      value={v}
      rows={1}
      placeholder="Untitled database"
      onChange={(e) => setV(e.target.value.replace(/\n/g, ''))}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          save();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      aria-label="Database title"
    />
  );
}

function Description({ id, value }: { id: Id; value?: RichText }) {
  const text = plainText(value);
  const [v, setV] = useState(text);
  useEffect(() => setV(text), [text]);
  return (
    <input
      className="edb-page-desc"
      value={v}
      placeholder="Add a description…"
      onChange={(e) => setV(e.target.value)}
      onBlur={async () => {
        if (v.trim() === text) return;
        try {
          const s = await api.db.update({ id, patch: { description: rt(v.trim()) } });
          useSchemas.getState().set(s);
        } catch (e) {
          notify.fromError(e, "Couldn't save the description");
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="Description"
    />
  );
}

export default function DatabasePage({ pageId, viewId }: DatabasePageProps) {
  const meta = useTree((s) => s.byId.get(pageId));
  return (
    <div className="edb-page">
      <DatabaseView
        databaseId={pageId}
        viewId={viewId}
        onViewChange={(v) => navigate({ t: 'db', id: pageId, viewId: v }, { replace: true })}
        header={(schema, counts) => {
          const icon = meta?.icon ?? schema.database.icon;
          const title = meta?.title ?? schema.database.title;
          return (
            <header className="edb-page-head">
              <IconPicker
                value={glyphName(icon)}
                onSelect={(name) => void useTree.getState().updateMeta(pageId, { icon: { t: 'lucide', v: name } })}
                onRemove={icon ? () => void useTree.getState().updateMeta(pageId, { icon: null }) : undefined}
              >
                <button type="button" className="edb-page-icon" aria-label="Change icon">
                  {glyphName(icon) ? <PageGlyph icon={icon} context="header" size={28} /> : <Database size={28} strokeWidth={1.75} absoluteStrokeWidth className="text-tertiary" aria-hidden />}
                </button>
              </IconPicker>
              <TitleInput id={pageId} title={title} />
              <div className="edb-page-meta">
                <Description id={pageId} value={schema.database.description} />
                <span className="edb-page-count tabular-nums">
                  <FileText size={13} aria-hidden />
                  {counts.total.toLocaleString()} {counts.total === 1 ? 'row' : 'rows'}
                  {counts.shown !== null ? <span className="text-tertiary"> · {counts.shown.toLocaleString()} shown</span> : null}
                </span>
              </div>
            </header>
          );
        }}
      />
    </div>
  );
}
