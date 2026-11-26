/** Colour menu (§3.4, §5.6): text colours and backgrounds by name; remembers the last pick for ⌘⌥H. */
import type { Editor } from '@tiptap/core';
import { Check } from 'lucide-react';
import { Kbd } from '@/ui/Kbd';
import { BLOCK_COLOR_NAMES, COLOR_LABEL } from '../lib/blockTypes';
import { applyColor, getLastColor, type LastColor } from '../lib/lastColor';

export interface ColorMenuProps {
  editor: Editor;
  /** Apply to whole blocks instead of the text selection. */
  blocks?: boolean;
  current?: { text?: string | null; bg?: string | null };
  onDone?: () => void;
}

export function ColorMenu({ editor, blocks, current, onDone }: ColorMenuProps) {
  const last = getLastColor();
  const pick = (c: LastColor) => {
    applyColor(editor, c, { blocks });
    onDone?.();
  };
  const all = [null, ...BLOCK_COLOR_NAMES] as (string | null)[];
  const isLast = (kind: 'text' | 'bg', c: string | null) => last?.kind === kind && last.color === c;
  return (
    <div className="emp-color-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="emp-menu-header">Text</div>
      <div className="emp-color-grid">
        {all.map((c) => (
          <button
            key={`t-${c ?? 'default'}`}
            type="button"
            className="emp-color-swatch"
            data-kind="text"
            data-selected={(current?.text ?? null) === c ? '' : undefined}
            title={`${c ? COLOR_LABEL[c] : 'Default'} text${isLast('text', c) ? ' · last used' : ''}`}
            aria-label={`${c ? COLOR_LABEL[c] : 'Default'} text`}
            style={{ color: c ? `var(--block-${c}-text)` : 'var(--text-primary)' }}
            onClick={() => pick({ kind: 'text', color: c })}
          >
            A{(current?.text ?? null) === c ? <Check className="emp-color-check" aria-hidden /> : null}
          </button>
        ))}
      </div>
      <div className="emp-menu-header">Background</div>
      <div className="emp-color-grid">
        {all.map((c) => (
          <button
            key={`b-${c ?? 'default'}`}
            type="button"
            className="emp-color-swatch"
            data-kind="bg"
            data-selected={(current?.bg ?? null) === c ? '' : undefined}
            title={`${c ? COLOR_LABEL[c] : 'Default'} background${isLast('bg', c) ? ' · last used' : ''}`}
            aria-label={`${c ? COLOR_LABEL[c] : 'Default'} background`}
            style={{ background: c ? `var(--block-${c}-bg)` : 'var(--bg-surface-1)', color: c ? `var(--block-${c}-text)` : 'var(--text-secondary)' }}
            onClick={() => pick({ kind: 'bg', color: c })}
          >
            {(current?.bg ?? null) === c ? <Check className="emp-color-check" aria-hidden /> : null}
          </button>
        ))}
      </div>
      {last ? (
        <div className="emp-color-hint">
          Last used: {last.color ? COLOR_LABEL[last.color] : 'Default'} {last.kind === 'bg' ? 'background' : 'text'} · <Kbd keys="mod+alt+h" size="xs" />
        </div>
      ) : null}
    </div>
  );
}
