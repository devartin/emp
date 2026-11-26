/**
 * Dev-only editor preview (not part of the app bundle): the full app plus sample answers for commands other
 * features haven't shipped to the browser mock yet (database charts, life-app metrics, watchlists), and a page with
 * every live block. Open http://localhost:1420/src/features/editor/dev/preview.html?seed=demo
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import App from '@/app/App';
import { boot } from '@/app/boot';
import { navigate } from '@/app/router';
import { api } from '@/backend';
import { getTransport } from '@/backend/runtime';
import { initAppearance } from '@/lib/bootPrefs';
import { useTree } from '@/stores/tree';
import { useWorkspace } from '@/stores/workspace';

initAppearance();
const theme = new URLSearchParams(location.search).get('theme');
if (theme) document.documentElement.setAttribute('data-theme', theme);

const months = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'];
const FAKES: Record<string, (req: Record<string, unknown>) => unknown> = {
  db_get_schema: (req) => ({
    database: { id: req.id, pageId: req.id, title: 'Monthly spending', inline: false },
    properties: [
      { id: 'p_title', name: 'Merchant', type: 'title' },
      { id: 'p_cat', name: 'Category', type: 'select' },
      { id: 'p_amt', name: 'Amount', type: 'money' },
      { id: 'p_date', name: 'Date', type: 'date' },
    ],
    views: [{ id: 'v1', name: 'All', layout: 'table' }],
  }),
  db_chart_data: (req) => {
    const spec = req.spec as { type: string; x: { prop: string } };
    if (spec.x.prop === 'p_cat') {
      return { x: ['Housing', 'Groceries', 'Transport', 'Dining', 'Subscriptions', 'Travel'], series: [{ key: 'amt', label: 'Amount', values: [1850, 612, 284, 342, 96, 455] }], currency: 'USD' };
    }
    return { x: months, series: [{ key: 'amt', label: 'Spending', values: [3120, 2980, 3410, 3050, 2870, 3324] }], currency: 'USD' };
  },
  lifeapp_metrics: () => ({ net_worth: { value: 84210.55, display: '$84,210', math: [], asOf: Date.now() } }),
  watchlist_list: () => [{ id: 'w1', name: 'Tech basket', symbols: [{ key: 'EMPX:XNAS' }, { key: 'NOVA:XNAS' }, { key: 'ORBT:XNAS' }, { key: 'KITE:XNAS' }] }],
};

async function patchTransport() {
  const t = await getTransport();
  const orig = t.call.bind(t);
  t.call = async (command, req) => {
    try {
      return await orig(command, req);
    } catch (e) {
      const fake = FAKES[command];
      if (fake && (e as { code?: string }).code === 'UNSUPPORTED') return structuredClone(fake(req));
      throw e;
    }
  };
}

const c = (content: unknown, children?: unknown[]) => ({ type: 'blockContainer', attrs: { id: null, color: null, bg: null, dir: 'auto' }, content: children ? [content, { type: 'blockGroup', content: children }] : [content] });
const p = (text: string) => c({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (level: number, text: string) => c({ type: 'heading', attrs: { level, toggle: false, collapsed: false }, content: [{ type: 'text', text }] });

async function openPreviewPage() {
  const ws = useWorkspace.getState().workspace;
  if (!ws) return;
  const existing = [...useTree.getState().byId.values()].find((m) => m.title === 'Live blocks preview');
  if (existing) return navigate({ t: 'page', id: existing.id });
  const doc = {
    type: 'doc',
    attrs: { schemaVersion: 1 },
    content: [
      {
        type: 'blockGroup',
        content: [
          p('Every EMP block that shows live data, side by side with text.'),
          h(2, 'Spending'),
          c({ type: 'chart', attrs: { source: { kind: 'db', databaseId: 'db_spend' }, spec: { type: 'bar', x: { prop: 'p_cat' }, y: [{ agg: 'sum', prop: 'p_amt' }] } } }),
          c({ type: 'chart', attrs: { source: { kind: 'db', databaseId: 'db_spend' }, spec: { type: 'area', x: { prop: '$created', bucket: 'month' }, y: [{ agg: 'sum', prop: 'p_amt' }] } } }),
          h(2, 'Key numbers'),
          c({
            type: 'columnList',
            attrs: { widths: [0.5, 0.5] },
            content: [
              { type: 'column', content: [{ type: 'blockGroup', content: [c({ type: 'kpi', attrs: { source: { kind: 'db', databaseId: 'db_spend', prop: 'p_amt' }, agg: 'sum', label: 'Spent this half-year', format: 'money' } })] }] },
              { type: 'column', content: [{ type: 'blockGroup', content: [c({ type: 'kpi', attrs: { source: { kind: 'metric', instanceId: 'li_money', metric: 'net_worth' }, agg: 'sum', label: 'Net worth', format: 'money' } })] }] },
            ],
          }),
          h(2, 'Markets'),
          c({ type: 'watchlist', attrs: { watchlistId: 'w1' } }),
          h(2, 'Empty states'),
          c({ type: 'chart', attrs: { source: null, spec: null } }),
          c({ type: 'image', attrs: { assetId: null, width: null, align: 'center', caption: '', pendingUrl: 'https://images.example.com/photo.jpg' } }),
          c({ type: 'file', attrs: { assetId: null } }),
          c({ type: 'mathBlock', attrs: { latex: '' } }),
          p(''),
        ],
      },
    ],
  };
  const res = await api.page.create({ workspaceId: ws.id, parentId: null, kind: 'doc', title: 'Live blocks preview', icon: { t: 'emoji', v: '📈' }, doc: doc as never });
  useTree.getState().upsert([res.meta]);
  navigate({ t: 'page', id: res.meta.id });
}

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void patchTransport()
    .then(() => boot())
    .then(() => setTimeout(() => void openPreviewPage(), 300));
}
