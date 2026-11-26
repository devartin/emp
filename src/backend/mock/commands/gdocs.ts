/** Google Docs import / export (§17.1): ID extraction, block mapping with warnings, Drive export links. */
import { BackendError } from '../../errors';
import type { MockHandlers } from '../ctx';
import { makeDoc } from '../lib/doc';
import { G, gLog, requireAccount, requireOnline, SCOPES } from '@/features/integrations/mock/googleStore';
import { md } from '@/features/lifeapps/mock/content';

const DOC_RE = /\/document\/d\/([a-zA-Z0-9_-]+)/;

const SAMPLE = `# Q1 planning notes
## Goals
- Ship the new onboarding by **February 14**
- Cut support tickets about billing by 30%
- Hire two engineers
## Risks
1. Design bandwidth in January
2. Payment provider migration overlaps with launch
## Decisions
| Topic | Owner | Status |
|---|---|---|
| Pricing page | Maya | Agreed |
| Analytics | Jordan | In review |
---
> Footnote: numbers are estimates from the November review.`;

export const handlers: MockHandlers = {
  gdocs_import: async (req, ctx) => {
    requireOnline(ctx);
    const m = DOC_RE.exec(req.url ?? '');
    if (!m) throw new BackendError('INVALID', 'Paste a Google Docs link — it contains /document/d/…', { field: 'url' });
    requireAccount(ctx, req.accountId, SCOPES.docs_import[0]);
    ctx.progress(1, 3, 'Fetching the document');
    gLog(ctx, 'GET', 'docs.googleapis.com', '/v1/documents/{documentId}', 200, 48_200);
    await ctx.sleep(500, ctx.signal);
    ctx.progress(2, 3, 'Converting headings, lists and tables');
    await ctx.sleep(300, ctx.signal);
    const page = ctx.pages.create({ workspaceId: req.workspaceId, parentId: req.parentId, kind: 'doc', title: 'Q1 planning notes', icon: { t: 'lucide', v: 'file-text' }, doc: makeDoc(md(SAMPLE).slice(1)) });
    ctx.progress(3, 3, 'Done');
    return { page: ctx.pages.meta(page.id), warnings: ['2 comments were not imported (comments aren’t part of the page)', 'Suggested edits were dropped — accept them in Google Docs first to keep them'] };
  },
  gdocs_export: async (req, ctx) => {
    requireOnline(ctx);
    requireAccount(ctx, req.accountId, SCOPES.export[0]);
    ctx.pages.require(req.pageId);
    ctx.progress(1, 2, 'Converting to HTML');
    await ctx.sleep(300, ctx.signal);
    ctx.progress(2, 2, 'Uploading to Drive');
    gLog(ctx, 'POST', 'www.googleapis.com', '/upload/drive/v3/files?uploadType=multipart', 200, 920);
    await ctx.sleep(400, ctx.signal);
    const fileId = `1${ctx.id().replace(/-/g, '').slice(0, 32)}`;
    void G;
    return { fileId, webViewLink: `https://docs.google.com/document/d/${fileId}/edit` };
  },
};
