/** Page/row documents with revs, conflict detection and cached plain text. */
import { BackendError } from '../../errors';
import type { Id, TipTapDoc } from '../../types';
import type { DocRecord, DocsService, MockCtx } from '../ctx';
import { docText, emptyDoc } from './doc';

/** Docs above this serialised size are rejected (§11.1 / §7.11 guidance; Rust caps records at 64 MiB). */
export const DOC_MAX_BYTES = 16 * 1024 * 1024;

export function createDocsService(ctx: MockCtx): DocsService {
  const table = () => ctx.db.table<DocRecord>('docs');
  const textCache = new Map<Id, { rev: number; text: string }>();

  const validate = (doc: TipTapDoc) => {
    if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) {
      throw new BackendError('INVALID', 'Not a TipTap document', { field: 'doc' });
    }
    const schemaVersion = doc.attrs?.schemaVersion;
    if (typeof schemaVersion === 'number' && schemaVersion > 1) {
      throw new BackendError('SCHEMA_TOO_NEW', 'This document was written by a newer version of Ultra Note');
    }
  };

  return {
    get: (ownerId) => table().get(ownerId),
    save(ownerId, ownerKind, doc, baseRev) {
      validate(doc);
      const size = JSON.stringify(doc).length;
      if (size > DOC_MAX_BYTES) throw new BackendError('TOO_LARGE', 'This page is too large to save');
      const existing = table().get(ownerId);
      const currentRev = existing?.rev ?? 0;
      if (baseRev !== undefined && baseRev !== currentRev) {
        throw new BackendError('CONFLICT', 'The page changed since it was opened', { currentRev });
      }
      const rec: DocRecord = {
        id: ownerId,
        ownerKind,
        rev: currentRev + 1,
        updatedAt: ctx.clock.now(),
        doc: { ...doc, attrs: { schemaVersion: 1 } },
      };
      table().put(rec);
      return rec;
    },
    delete(ownerId) {
      table().delete(ownerId);
      textCache.delete(ownerId);
    },
    text(ownerId) {
      const rec = table().get(ownerId);
      if (!rec) return '';
      const cached = textCache.get(ownerId);
      if (cached && cached.rev === rec.rev) return cached.text;
      const text = docText(rec.doc);
      textCache.set(ownerId, { rev: rec.rev, text });
      return text;
    },
    emptyDoc,
  };
}
