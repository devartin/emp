/**
 * Save conflict (§7.8): the page changed elsewhere. "Keep mine" saves the draft over it (their version stays in
 * history); "Take theirs" keeps the draft in history and loads their version.
 */
import { GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/backend';
import type { Id, TipTapDoc } from '@/backend/types';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { normaliseDocJson } from '../lib/normalize';

export interface ConflictSheetProps {
  open: boolean;
  pageId: Id;
  draft: TipTapDoc | null;
  onResolved: (r: { doc: TipTapDoc | null; rev: number }) => void;
  onOpenChange: (o: boolean) => void;
}

export function ConflictSheet({ open, pageId, draft, onResolved, onOpenChange }: ConflictSheetProps) {
  const [busy, setBusy] = useState<'mine' | 'theirs' | null>(null);
  const keepMine = async () => {
    if (!draft) return;
    setBusy('mine');
    try {
      await api.version.create({ targetId: pageId, targetKind: 'page_doc', label: 'Version from another window' });
      const cur = await api.page.get({ id: pageId });
      const { rev } = await api.page.saveDoc({ ownerId: pageId, ownerKind: 'page', doc: draft, baseRev: cur.docRev });
      onResolved({ doc: null, rev });
      notify.success('Kept your version', { description: 'The other version is in page history.' });
    } catch (e) {
      notify.fromError(e, "Couldn't save your version");
    } finally {
      setBusy(null);
    }
  };
  const takeTheirs = async () => {
    if (!draft) return;
    setBusy('theirs');
    try {
      const theirs = await api.version.create({ targetId: pageId, targetKind: 'page_doc', label: 'Their version' });
      const cur = await api.page.get({ id: pageId });
      await api.page.saveDoc({ ownerId: pageId, ownerKind: 'page', doc: draft, baseRev: cur.docRev });
      await api.version.create({ targetId: pageId, targetKind: 'page_doc', label: 'Your draft (before taking theirs)' });
      const { rev } = await api.version.restore({ id: theirs.id });
      const page = await api.page.get({ id: pageId });
      onResolved({ doc: normaliseDocJson(page.doc), rev });
      notify.success('Loaded the other version', { description: 'Your draft is saved in page history.' });
    } catch (e) {
      notify.fromError(e, "Couldn't load the other version");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      dismissible={false}
      title="This page changed somewhere else"
      description="Another window or an import saved a newer version while you were editing. Choose which one to keep — the other is saved in page history."
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" loading={busy === 'theirs'} disabled={!!busy} onClick={() => void takeTheirs()}>
            Take theirs
          </Button>
          <Button variant="primary" loading={busy === 'mine'} disabled={!!busy} onClick={() => void keepMine()}>
            Keep mine
          </Button>
        </div>
      }
    >
      <div className="emp-conflict">
        <span className="emp-conflict-icon">
          <GitCompareArrows size={22} />
        </span>
        <p>Nothing is lost either way: EMP keeps both versions, and you can restore the other one later from Page history.</p>
      </div>
    </Sheet>
  );
}
