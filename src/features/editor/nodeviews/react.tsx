/**
 * React node views (§7.1): only for databaseView, chart, kpi, sheetEmbed, watchlist, image and mathBlock. Each one
 * stops keyboard/pointer events inside it, ignores DOM mutations, and mounts lazily via IntersectionObserver
 * (rootMargin 400px) with a skeleton until then.
 */
import type { AnyExtension, Node as TNode } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Skeleton } from '@/ui/Skeleton';
import { cn } from '@/lib/cn';

const VIEWS: Record<string, { load: () => Promise<{ default: ComponentType<NodeViewProps> }>; height: number }> = {
  image: { load: () => import('./ImageView'), height: 220 },
  mathBlock: { load: () => import('./MathBlockView'), height: 64 },
  databaseView: { load: () => import('./DatabaseBlockView'), height: 260 },
  chart: { load: () => import('./ChartBlockView'), height: 280 },
  kpi: { load: () => import('./KpiBlockView'), height: 128 },
  sheetEmbed: { load: () => import('./SheetEmbedView'), height: 240 },
  watchlist: { load: () => import('./WatchlistView'), height: 220 },
};

const lazies = new Map<string, ComponentType<NodeViewProps>>();
function lazyFor(name: string): ComponentType<NodeViewProps> {
  let c = lazies.get(name);
  if (!c) {
    c = lazy(VIEWS[name].load);
    lazies.set(name, c);
  }
  return c;
}

class BlockBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="emp-embed-error" role="alert">
          <span>{this.props.label} couldn’t be displayed.</span>
          <button type="button" className="emp-embed-retry" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Mount children once the block is within 400px of the viewport. */
export function LazyMount({ height, children, className }: { height: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return (
    <div ref={ref} className={className}>
      {visible ? children : <Skeleton height={height} radius={10} />}
    </div>
  );
}

const LABELS: Record<string, string> = {
  image: 'This image',
  mathBlock: 'This equation',
  databaseView: 'This database',
  chart: 'This chart',
  kpi: 'This KPI',
  sheetEmbed: 'This spreadsheet range',
  watchlist: 'This watchlist',
};

function Shell(props: NodeViewProps) {
  const name = props.node.type.name;
  const View = lazyFor(name);
  const { height } = VIEWS[name];
  return (
    <NodeViewWrapper className={cn('emp-embed', `emp-embed-${name}`, props.selected && 'is-selected')} data-content-type={name} contentEditable={false}>
      <LazyMount height={height}>
        <BlockBoundary label={LABELS[name] ?? 'This block'}>
          <Suspense fallback={<Skeleton height={height} radius={10} />}>
            <View {...props} />
          </Suspense>
        </BlockBoundary>
      </LazyMount>
    </NodeViewWrapper>
  );
}

const STOP = /^(key|mouse|pointer|click|dblclick|input|focus|blur|wheel|paste|copy|cut|compos|touch|beforeinput|contextmenu)/;

export function reactBlockViews(nodes: AnyExtension[]): AnyExtension[] {
  return nodes.map((ext) => {
    if (!(ext.name in VIEWS)) return ext;
    return (ext as TNode).extend({
      addNodeView() {
        return ReactNodeViewRenderer(Shell, {
          stopEvent: ({ event }) => {
            if (event.type.startsWith('drag') || event.type === 'drop') return false;
            const t = event.target as HTMLElement | null;
            // Let ProseMirror select the block when the frame itself (not a control) is clicked.
            if (event.type === 'mousedown' && t?.classList?.contains('emp-embed')) return false;
            return STOP.test(event.type);
          },
          ignoreMutation: () => true,
        });
      },
    });
  });
}
