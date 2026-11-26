/** Watchlist block (§7.1): resolves `watchlistId` to symbols and renders the markets feature's WatchlistBlock. */
import type { NodeViewProps } from '@tiptap/react';
import { CandlestickChart, Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '@/backend';
import type { Watchlist } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { Skeleton } from '@/ui/Skeleton';

const WatchlistBlock = lazy(() => import('@/features/markets/WatchlistBlock'));

let cache: Watchlist[] | null = null;

export default function WatchlistView({ node, updateAttributes, editor }: NodeViewProps) {
  const id = node.attrs.watchlistId as string | null;
  const [lists, setLists] = useState<Watchlist[] | null>(cache);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.watchlist
      .list()
      .then((l) => {
        cache = l;
        if (live) setLists(l);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Watchlists are unavailable'));
    return () => {
      live = false;
    };
  }, [id]);

  const wl = id ? lists?.find((l) => l.id === id) : undefined;
  if (id && wl) {
    return (
      <div className="emp-watch-block">
        <div className="emp-embed-caption">
          <CandlestickChart size={14} />
          <span>{wl.name}</span>
        </div>
        <Suspense fallback={<Skeleton height={180} radius={10} />}>
          <WatchlistBlock symbols={wl.symbols.map((s) => s.key)} />
        </Suspense>
      </div>
    );
  }
  if (!lists && !error) return <Skeleton height={120} radius={10} />;
  return (
    <div className="emp-embed-empty is-column">
      <div className="emp-embed-empty-row">
        <CandlestickChart size={18} className="text-tertiary" />
        <span className="emp-embed-empty-title">{id ? 'Watchlist not found' : 'Choose a watchlist'}</span>
        <span className="emp-embed-empty-sub">{error ?? 'Live quotes for the symbols you follow.'}</span>
      </div>
      {editor.isEditable && lists ? (
        <div className="emp-chip-row">
          {lists.map((l) => (
            <button key={l.id} type="button" className={cn('emp-chip')} onClick={() => updateAttributes({ watchlistId: l.id })}>
              {l.name} <span className="emp-chip-count">{l.symbols.length}</span>
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            onClick={async () => {
              try {
                const res = await api.watchlist.save({ name: 'My watchlist', symbols: [{ key: 'EMPX:XNAS' }, { key: 'NOVA:XNAS' }, { key: 'ORBT:XNAS' }] });
                cache = null;
                updateAttributes({ watchlistId: res.id });
              } catch (e) {
                notify.fromError(e, "Couldn't create a watchlist");
              }
            }}
          >
            New watchlist
          </Button>
        </div>
      ) : null}
    </div>
  );
}
