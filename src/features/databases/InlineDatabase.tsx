/** Inline / linked database inside a doc (§7.1 `databaseView` block): compact title row + tabs + toolbar + view. */
import { ArrowUpRight, Database } from 'lucide-react';
import { useState } from 'react';
import type { Id } from '@/backend/types';
import { navigate } from '@/app/router';
import { useTree } from '@/stores/tree';
import { DatabaseView } from './DatabaseView';

export interface InlineDatabaseProps {
  databaseId: Id;
  viewId?: Id;
}

export default function InlineDatabase({ databaseId, viewId }: InlineDatabaseProps) {
  const meta = useTree((s) => s.byId.get(databaseId));
  const [view, setView] = useState(viewId);
  return (
    <div className="edb-inline" onKeyDown={(e) => e.stopPropagation()} onPaste={(e) => e.stopPropagation()} contentEditable={false} suppressContentEditableWarning>
      <DatabaseView
        databaseId={databaseId}
        viewId={view}
        inline
        onViewChange={setView}
        titleSlot={(schema) => {
          const icon = meta?.icon ?? schema.database.icon;
          const title = meta?.title ?? schema.database.title;
          return (
            <button type="button" className="edb-inline-title" onClick={() => navigate({ t: 'db', id: databaseId, viewId: view })} title="Open as full page">
              {icon?.t === 'emoji' ? <span aria-hidden>{icon.v}</span> : <Database size={15} aria-hidden />}
              <span className="truncate">{title || 'Untitled database'}</span>
              <ArrowUpRight size={13} className="edb-inline-open" aria-hidden />
            </button>
          );
        }}
      />
    </div>
  );
}
