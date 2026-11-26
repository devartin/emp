/** Grid context menu (§5.6 skin): clipboard, insert / delete, clear, sort, merge, freeze and conditional formats. */
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Brush,
  ClipboardPaste,
  Columns3,
  Copy,
  Eraser,
  Hash,
  Merge,
  Paintbrush,
  Rows3,
  Scissors,
  Snowflake,
  SplitSquareHorizontal,
  Trash2,
  WrapText,
} from 'lucide-react';
import { memo } from 'react';
import { notify } from '@/stores/toasts';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/ui/ContextMenu';
import { colName } from './engine/addr';
import type { GridController } from './GridController';

export interface GridContextMenuProps {
  ctrl: GridController;
  zone: 'cell' | 'colhead' | 'rowhead';
  onCondFormat: () => void;
}

async function readClipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The content panel is memoised and its items are a separate component, so they're only built while the menu is
 * open (reading the selection fresh at that moment) instead of on every selection move of the grid.
 */
export const GridContextMenu = memo(function GridContextMenu(props: GridContextMenuProps) {
  return (
    <ContextMenuContent width={248}>
      <GridMenuItems {...props} />
    </ContextMenuContent>
  );
});

function GridMenuItems({ ctrl, zone, onCondFormat }: GridContextMenuProps) {
  const p = ctrl.primary;
  const rows = p.r1 - p.r0 + 1;
  const cols = p.c1 - p.c0 + 1;
  const rowsLabel = rows > 1 && rows < 1_000_000 ? `${rows} rows` : 'row';
  const colsLabel = cols > 1 && cols < 16_384 ? `${cols} columns` : 'column';
  const merged = !!ctrl.mergeAt(ctrl.active.r, ctrl.active.c);
  const multi = rows > 1 || cols > 1;
  const exec = (cmd: 'copy' | 'cut') => {
    ctrl.focusGrid?.();
    // Fires the grid's copy / cut handler with clipboard access.
    if (!document.execCommand(cmd)) notify.info(`Use ${cmd === 'copy' ? '⌘C' : '⌘X'} to ${cmd}`);
  };
  const paste = async (mode: 'all' | 'values' | 'formats') => {
    if (mode !== 'all' && ctrl.hasInternalClip()) return ctrl.pasteSpecial(mode);
    const text = await readClipboard();
    if (text === null) {
      if (ctrl.hasInternalClip()) return ctrl.pasteText('', undefined, mode);
      notify.info('Use ⌘V to paste', { description: 'The browser needs a keyboard shortcut to read the clipboard.' });
      return;
    }
    await ctrl.pasteText(text, undefined, mode);
  };
  return (
    <>
      <ContextMenuItem icon={Scissors} shortcut="mod+x" onSelect={() => exec('cut')}>
        Cut
      </ContextMenuItem>
      <ContextMenuItem icon={Copy} shortcut="mod+c" onSelect={() => exec('copy')}>
        Copy
      </ContextMenuItem>
      <ContextMenuItem icon={ClipboardPaste} shortcut="mod+v" onSelect={() => void paste('all')}>
        Paste
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger icon={Paintbrush}>Paste special</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem icon={Hash} disabled={!ctrl.hasInternalClip()} onSelect={() => void paste('values')}>
            Values only
          </ContextMenuItem>
          <ContextMenuItem icon={Brush} disabled={!ctrl.hasInternalClip()} onSelect={() => void paste('formats')}>
            Formatting only
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      {zone !== 'colhead' ? (
        <>
          <ContextMenuItem icon={Rows3} onSelect={() => void ctrl.insert('rows', 'before')}>
            Insert {rowsLabel} above
          </ContextMenuItem>
          <ContextMenuItem icon={Rows3} onSelect={() => void ctrl.insert('rows', 'after')}>
            Insert {rowsLabel} below
          </ContextMenuItem>
        </>
      ) : null}
      {zone !== 'rowhead' ? (
        <>
          <ContextMenuItem icon={Columns3} onSelect={() => void ctrl.insert('cols', 'before')}>
            Insert {colsLabel} left
          </ContextMenuItem>
          <ContextMenuItem icon={Columns3} onSelect={() => void ctrl.insert('cols', 'after')}>
            Insert {colsLabel} right
          </ContextMenuItem>
        </>
      ) : null}
      {zone !== 'colhead' ? (
        <ContextMenuItem icon={Trash2} destructive onSelect={() => void ctrl.deleteSpan('rows')}>
          Delete {rows > 1 && rows < 1_000_000 ? `rows ${p.r0 + 1}–${p.r1 + 1}` : `row ${p.r0 + 1}`}
        </ContextMenuItem>
      ) : null}
      {zone !== 'rowhead' ? (
        <ContextMenuItem icon={Trash2} destructive onSelect={() => void ctrl.deleteSpan('cols')}>
          Delete {cols > 1 && cols < 16_384 ? `columns ${colName(p.c0)}–${colName(p.c1)}` : `column ${colName(p.c0)}`}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem icon={Eraser} shortcut="delete" onSelect={() => void ctrl.clear('contents')}>
        Clear contents
      </ContextMenuItem>
      <ContextMenuItem icon={Brush} onSelect={() => void ctrl.clear('formats')}>
        Clear formatting
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem icon={ArrowDownAZ} onSelect={() => void ctrl.sort('asc')}>
        Sort A → Z
      </ContextMenuItem>
      <ContextMenuItem icon={ArrowUpAZ} onSelect={() => void ctrl.sort('desc')}>
        Sort Z → A
      </ContextMenuItem>
      {zone === 'colhead' ? (
        <ContextMenuItem icon={WrapText} onSelect={() => void ctrl.resize('cols', ctrl.selectedIndices('cols'), 'auto')}>
          Fit to data
        </ContextMenuItem>
      ) : null}
      <ContextMenuSeparator />
      {merged ? (
        <ContextMenuItem icon={SplitSquareHorizontal} onSelect={() => void ctrl.merge(false)}>
          Unmerge cells
        </ContextMenuItem>
      ) : (
        <ContextMenuItem icon={Merge} disabled={!multi || rows * cols > 100_000} onSelect={() => void ctrl.merge(true)}>
          Merge cells
        </ContextMenuItem>
      )}
      <ContextMenuItem icon={Snowflake} onSelect={() => void ctrl.freeze(zone === 'colhead' ? 0 : ctrl.active.r, zone === 'rowhead' ? 0 : ctrl.active.c)}>
        {zone === 'colhead' ? `Freeze up to column ${colName(Math.max(0, ctrl.active.c - 1))}` : zone === 'rowhead' ? `Freeze up to row ${ctrl.active.r}` : 'Freeze panes here'}
      </ContextMenuItem>
      <ContextMenuItem icon={Paintbrush} onSelect={onCondFormat}>
        Conditional formatting…
      </ContextMenuItem>
    </>
  );
}

export default GridContextMenu;
