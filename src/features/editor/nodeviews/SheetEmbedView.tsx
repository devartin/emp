/** Spreadsheet range embed (§7.1): renders the sheets feature's SheetEmbed; empty blocks pick a workbook. */
import type { NodeViewProps } from '@tiptap/react';
import { Sheet } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/ui/Button';
import { Skeleton } from '@/ui/Skeleton';
import { PagePicker } from '../menus/PagePicker';

const SheetEmbed = lazy(() => import('@/features/sheets/SheetEmbed'));

export default function SheetEmbedView({ node, updateAttributes, editor }: NodeViewProps) {
  const { workbookId, sheetId, range } = node.attrs as { workbookId: string | null; sheetId: string | null; range: string };
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!workbookId) {
    return (
      <div className="emp-embed-empty">
        <Sheet size={18} className="text-tertiary" />
        <span className="emp-embed-empty-title">Embed a spreadsheet</span>
        <span className="emp-embed-empty-sub">Show a live range from a workbook.</span>
        <span className="flex-1" />
        {editor.isEditable ? (
          <Button size="sm" variant="secondary" onClick={(e) => { setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); setPicking(true); }}>
            Choose…
          </Button>
        ) : null}
        <PagePicker open={picking} anchor={anchor} title="Spreadsheets" kinds={['sheet']} placeholder="Search spreadsheets…" onClose={() => setPicking(false)} onPick={(id) => { setPicking(false); updateAttributes({ workbookId: id, sheetId: null, range: '' }); }} />
      </div>
    );
  }
  return (
    <Suspense fallback={<Skeleton height={200} radius={10} />}>
      <SheetEmbed pageId={workbookId} sheetId={sheetId ?? undefined} range={range || undefined} />
    </Suspense>
  );
}
