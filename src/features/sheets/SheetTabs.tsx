/**
 * Sheet tabs: add, switch, rename (double-click), reorder (drag), colour, hide and delete — plus the "all sheets"
 * menu (hidden sheets included) and the selection status (Sum · Average · Count) on the right.
 */
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LayoutGroup, m } from 'motion/react';
import { Eye, EyeOff, List, Palette, PenLine, Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { BlockColor, SheetMeta } from '@/backend/types';
import { cn } from '@/lib/cn';
import { AlertDialog } from '@/ui/AlertDialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/ui/ContextMenu';
import { IconButton } from '@/ui/IconButton';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/ui/Menu';
import { spring } from '@/ui/motion/tokens';
import { useGridSelector, type GridController } from './GridController';
import { TAB_COLORS } from './palette';
import { StatusBar } from './StatusBar';

export interface SheetTabsProps {
  ctrl: GridController;
}

/** Re-renders only when the sheet list or the current sheet changes — not on selection moves (the status bar on the
 *  right subscribes to the selection on its own). */
export const SheetTabs = memo(function SheetTabs({ ctrl }: SheetTabsProps) {
  useGridSelector(ctrl, (c) => `${c.sheetId}|${c.sheets.map((s) => `${s.id}:${s.name}:${s.color ?? ''}:${s.hidden ? 1 : 0}`).join('|')}`);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SheetMeta | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = ctrl.sheets.filter((s) => !s.hidden);
  const hidden = ctrl.sheets.filter((s) => s.hidden);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = visible.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    if (to > from) void ctrl.reorderSheet(String(active.id), undefined, ids[to]);
    else void ctrl.reorderSheet(String(active.id), ids[to]);
  };

  return (
    <div className="emp-wb-footer">
      <div className="emp-sheet-tabbar" role="tablist" aria-label="Sheets">
        <IconButton size="sm" icon={Plus} label="Add sheet" onClick={() => void ctrl.addSheet()} />
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="sm" icon={List} label="All sheets" />
          </MenuTrigger>
          <MenuContent width={240} side="top">
            <MenuLabel>Sheets</MenuLabel>
            {ctrl.sheets.map((s) => (
              <MenuItem
                key={s.id}
                icon={s.hidden ? EyeOff : <span className="emp-tab-dot" data-color={s.color ?? undefined} />}
                trailing={s.id === ctrl.sheetId ? <span className="emp-tab-current">Current</span> : s.hidden ? <span className="emp-tab-current">Hidden</span> : undefined}
                onSelect={() => (s.hidden ? void ctrl.hideSheet(s.id, false) : void ctrl.setSheet(s.id))}
              >
                {s.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <div className="emp-sheet-tabs-scroll">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={visible.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
              <LayoutGroup id={`tabs-${ctrl.workbookId}`}>
                {visible.map((s) => (
                  <SheetTab
                    key={s.id}
                    sheet={s}
                    active={s.id === ctrl.sheetId}
                    renaming={renaming === s.id}
                    canDelete={ctrl.sheets.length > 1}
                    canHide={visible.length > 1}
                    onSelect={() => void ctrl.setSheet(s.id).then(() => ctrl.focusGrid?.())}
                    onRename={() => setRenaming(s.id)}
                    onRenameDone={async (name) => {
                      setRenaming(null);
                      if (name && name !== s.name) await ctrl.renameSheet(s.id, name);
                      ctrl.focusGrid?.();
                    }}
                    onColor={(c) => void ctrl.colorSheet(s.id, c)}
                    onHide={() => void ctrl.hideSheet(s.id, true)}
                    onDelete={() => setConfirmDelete(s)}
                  />
                ))}
              </LayoutGroup>
            </SortableContext>
          </DndContext>
          {hidden.length ? <span className="emp-tab-hidden-note">{hidden.length} hidden</span> : null}
        </div>
      </div>
      <StatusBar ctrl={ctrl} />
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.name ?? ''}”?`}
        description="Formulas on other sheets that refer to it will show #REF!. This can’t be undone."
        confirmLabel="Delete sheet"
        tone="danger"
        onConfirm={async () => {
          if (confirmDelete) await ctrl.removeSheet(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
});

interface SheetTabProps {
  sheet: SheetMeta;
  active: boolean;
  renaming: boolean;
  canDelete: boolean;
  canHide: boolean;
  onSelect(): void;
  onRename(): void;
  onRenameDone(name: string | null): void;
  onColor(c: BlockColor | null): void;
  onHide(): void;
  onDelete(): void;
}

function SheetTab({ sheet, active, renaming, canDelete, canHide, onSelect, onRename, onRenameDone, onColor, onHide, onDelete }: SheetTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sheet.id, disabled: renaming });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(sheet.name);
  useEffect(() => {
    if (renaming) {
      setDraft(sheet.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, sheet.name]);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          className={cn('emp-sheet-tab', active && 'is-active', isDragging && 'is-dragging')}
          style={{ transform: CSS.Translate.toString(transform), transition }}
          data-color={sheet.color ?? undefined}
          onClick={() => !renaming && onSelect()}
          onDoubleClick={onRename}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter' || e.key === 'F2') {
              e.preventDefault();
              onRename();
            }
          }}
          {...attributes}
          {...listeners}
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
        >
          {active ? <m.span layoutId="emp-sheet-tab-active" className="emp-sheet-tab-bg" transition={spring.ui} /> : null}
          {sheet.color ? <span className="emp-sheet-tab-color" aria-hidden /> : null}
          {renaming ? (
            <input
              ref={inputRef}
              className="emp-sheet-tab-input"
              value={draft}
              maxLength={31}
              size={Math.max(4, draft.length)}
              aria-label="Sheet name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => onRenameDone(draft.trim() || null)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') onRenameDone(draft.trim() || null);
                if (e.key === 'Escape') onRenameDone(null);
              }}
            />
          ) : (
            <span className="emp-sheet-tab-label">{sheet.name}</span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent width={220}>
        <ContextMenuItem icon={PenLine} onSelect={onRename}>
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={Palette}>Tab colour</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <div className="emp-tab-colors">
              <button type="button" className="emp-tab-color-swatch is-none" aria-label="No colour" onClick={() => onColor(null)} />
              {TAB_COLORS.map((c) => (
                <button key={c} type="button" className={cn('emp-tab-color-swatch', sheet.color === c && 'is-current')} data-color={c} aria-label={c} onClick={() => onColor(c)} />
              ))}
            </div>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem icon={Eye} disabled={!canHide} onSelect={onHide}>
          Hide sheet
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon={Trash2} destructive disabled={!canDelete} onSelect={onDelete}>
          Delete sheet
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default SheetTabs;
