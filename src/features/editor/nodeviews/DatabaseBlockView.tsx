/** Inline / linked database block (§7.1): renders the databases feature's InlineDatabase. */
import type { NodeViewProps } from '@tiptap/react';
import { Database, Repeat2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Skeleton } from '@/ui/Skeleton';
import { Button } from '@/ui/Button';
import { PagePicker } from '../menus/PagePicker';

const InlineDatabase = lazy(() => import('@/features/databases/InlineDatabase'));

export default function DatabaseBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const { databaseId, viewId, linked } = node.attrs as { databaseId: string | null; viewId: string | null; linked: boolean };
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!databaseId) {
    return (
      <div className="emp-embed-empty">
        <Database size={18} className="text-tertiary" />
        <span className="emp-embed-empty-title">Link a database</span>
        <span className="emp-embed-empty-sub">Show an existing database on this page.</span>
        <span className="flex-1" />
        {editor.isEditable ? (
          <Button size="sm" variant="secondary" icon={Repeat2} onClick={(e) => { setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); setPicking(true); }}>
            Choose…
          </Button>
        ) : null}
        <PagePicker open={picking} anchor={anchor} title="Databases" kinds={['database']} placeholder="Search databases…" onClose={() => setPicking(false)} onPick={(id) => { setPicking(false); updateAttributes({ databaseId: id, viewId: null, linked: true }); }} />
      </div>
    );
  }
  return (
    <div className="emp-db-block" data-linked={linked ? '' : undefined}>
      <Suspense fallback={<Skeleton height={220} radius={10} />}>
        <InlineDatabase databaseId={databaseId} viewId={viewId ?? undefined} />
      </Suspense>
    </div>
  );
}
