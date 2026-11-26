/** Today's daily note (⌘⌥D, route `today`): opens — or creates from the template — the note for today. */
import { CalendarDays } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/backend';
import type { Id } from '@/backend/types';
import { isoDay } from '@/lib/dates';
import { useTree } from '@/stores/tree';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Skeleton, useSkeletonDelay } from '@/ui/Skeleton';
import PageView from './PageView';

export default function DailyNote() {
  const [pageId, setPageId] = useState<Id | null>(null);
  const [error, setError] = useState(false);
  const [day, setDay] = useState(() => isoDay());
  const show = useSkeletonDelay(!pageId && !error);

  useEffect(() => {
    let live = true;
    setError(false);
    api.daily
      .noteOpen({ date: day })
      .then((meta) => {
        if (!live) return;
        useTree.getState().upsert([meta]);
        if (meta.parentId) useTree.getState().reveal(meta.id);
        setPageId(meta.id);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [day]);

  // Roll over at midnight while the note is open.
  useEffect(() => {
    const t = setInterval(() => {
      const now = isoDay();
      if (now !== day) setDay(now);
    }, 60_000);
    return () => clearInterval(t);
  }, [day]);

  if (error) {
    return (
      <div className="emp-page-missing">
        <EmptyState icon={CalendarDays} title="Today’s note couldn’t be opened" body="Try again in a moment." actions={<Button variant="secondary" onClick={() => setDay(isoDay())}>Try again</Button>} />
      </div>
    );
  }
  if (!pageId) {
    return (
      <div className="emp-page" aria-busy="true">
        {show ? (
          <div className="emp-page-column">
            <Skeleton height={40} width="45%" radius={8} className="mt-16" />
          </div>
        ) : null}
      </div>
    );
  }
  return <PageView key={pageId} pageId={pageId} />;
}
