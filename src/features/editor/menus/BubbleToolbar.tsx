/**
 * Bubble toolbar (§5.11): 36px tall, padding 4, radius 10, elev-2, 8px above the selection, shown once the selection
 * has rested for 150ms. Order: Turn into ▾, B, I, U, S, code, link, colour ▾, ⋯. State comes from `useEditorState`
 * with a narrow selector so typing doesn't re-render it.
 */
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Bold, ChevronDown, Code, Eraser, Italic, Link2, MoreHorizontal, Sigma, Strikethrough, Underline } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Tooltip } from '@/ui/Tooltip';
import { TURN_INTO, currentTarget } from '../lib/blockTypes';
import { currentBlock, turnInto } from '../lib/blocks';
import { selectedBlockIds } from '../extensions/blockSelection';
import { getSuggest } from '../extensions/suggest';
import { openLinkPopover } from '../extensions/keymap';
import { useOverlay } from './overlay';
import { ColorMenu } from './ColorMenu';
import { Floating } from './Floating';

interface BubbleState {
  show: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  textColor: string | null;
  bg: string | null;
  turnKey: string | null;
  from: number;
  to: number;
}

function Btn({ label, shortcut, active, onClick, children, className }: { label: string; shortcut?: string; active?: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="top">
      <button type="button" className={cn('emp-bubble-btn slab', !active && 'slab-ghost', className)} data-active={active ? '' : undefined} aria-pressed={active} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        {children}
      </button>
    </Tooltip>
  );
}

export function BubbleToolbar({ editor }: { editor: Editor }) {
  const s = useEditorState<BubbleState>({
    editor,
    selector: ({ editor: e }) => {
      const st = e.state;
      const sel = st.selection;
      const ok =
        e.isEditable &&
        sel instanceof TextSelection &&
        !sel.empty &&
        !sel.$from.parent.type.spec.code &&
        !(sel instanceof NodeSelection) &&
        !selectedBlockIds(st).length &&
        !getSuggest(st).active &&
        st.doc.textBetween(sel.from, sel.to, ' ', ' ').trim().length > 0;
      const info = ok ? currentBlock(st) : null;
      const tc = ok ? (e.getAttributes('textColor').color as string | undefined) ?? null : null;
      const hl = ok ? (e.isActive('highlight') ? ((e.getAttributes('highlight').color as string | undefined) ?? 'yellow') : null) : null;
      return {
        show: ok,
        bold: ok && e.isActive('bold'),
        italic: ok && e.isActive('italic'),
        underline: ok && e.isActive('underline'),
        strike: ok && e.isActive('strike'),
        code: ok && e.isActive('code'),
        link: ok && e.isActive('link'),
        textColor: tc,
        bg: hl,
        turnKey: info ? currentTarget(info.content)?.key ?? null : null,
        from: ok ? sel.from : 0,
        to: ok ? sel.to : 0,
      };
    },
    equalityFn: (a, b) => !!b && JSON.stringify(a) === JSON.stringify(b),
  });

  // Appear after the selection rests 150ms and the mouse is up.
  const [rested, setRested] = useState(false);
  const [pointerDown, setPointerDown] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const overlayOpen = useOverlay((o) => !!o.req && o.req.editorId === editor.instanceId);
  const focused = useEditorState({ editor, selector: ({ editor: e }) => e.isFocused });
  useEffect(() => {
    const dom = editor.view.dom;
    const down = () => setPointerDown(true);
    const up = () => setPointerDown(false);
    dom.addEventListener('mousedown', down);
    window.addEventListener('mouseup', up);
    return () => {
      dom.removeEventListener('mousedown', down);
      window.removeEventListener('mouseup', up);
    };
  }, [editor]);
  useEffect(() => {
    setRested(false);
    if (!s?.show) return;
    const t = setTimeout(() => setRested(true), 150);
    return () => clearTimeout(t);
  }, [s?.show, s?.from, s?.to]);

  const anchor = useCallback(() => {
    const { from, to } = editor.state.selection;
    try {
      const a = editor.view.coordsAtPos(from);
      const b = editor.view.coordsAtPos(to, -1);
      const top = Math.min(a.top, b.top);
      const left = a.top === b.top ? Math.min(a.left, b.left) : editor.view.dom.getBoundingClientRect().left + 24;
      const right = a.top === b.top ? Math.max(a.right, b.right) : Math.max(a.right, b.right);
      return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(a.bottom, b.bottom) - top };
    } catch {
      return null;
    }
  }, [editor]);

  const visible = !!s?.show && rested && !pointerDown && (focused || menuOpen) && !overlayOpen;
  const chain = () => editor.chain().focus();
  const keepRef = useRef(false);
  keepRef.current = menuOpen;

  const turnLabel = TURN_INTO.find((t) => t.key === s?.turnKey)?.label ?? 'Text';
  return (
    <Floating open={visible} anchor={anchor} context={editor.view.dom} placement="top" offsetPx={8} passive className="emp-bubble" role="toolbar" ariaLabel="Formatting">
      <Menu onOpenChange={setMenuOpen} modal={false}>
        <MenuTrigger asChild>
          <button type="button" className="emp-bubble-btn emp-bubble-turn slab slab-ghost" onMouseDown={(e) => e.preventDefault()}>
            <span>{turnLabel}</span>
            <ChevronDown size={12} />
          </button>
        </MenuTrigger>
        <MenuContent side="bottom" align="start" width={240} noReturnFocus>
          {TURN_INTO.filter((t) => t.type !== '$page').map((t) => (
            <MenuItem
              key={t.key}
              icon={t.icon}
              shortcut={t.shortcut}
              trailing={s?.turnKey === t.key ? <span className="emp-menu-check">✓</span> : undefined}
              onSelect={() => {
                const b = currentBlock(editor.state);
                if (b) turnInto(editor.state, (tr) => editor.view.dispatch(tr), [b], t);
                editor.commands.focus();
              }}
            >
              {t.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <span className="emp-bubble-sep" />
      <Btn label="Bold" shortcut="mod+b" active={s?.bold} onClick={() => chain().toggleBold().run()}>
        <Bold size={15} strokeWidth={2.25} />
      </Btn>
      <Btn label="Italic" shortcut="mod+i" active={s?.italic} onClick={() => chain().toggleItalic().run()}>
        <Italic size={15} />
      </Btn>
      <Btn label="Underline" shortcut="mod+u" active={s?.underline} onClick={() => chain().toggleUnderline().run()}>
        <Underline size={15} />
      </Btn>
      <Btn label="Strikethrough" shortcut="mod+shift+s" active={s?.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={15} />
      </Btn>
      <Btn label="Code" shortcut="mod+e" active={s?.code} onClick={() => chain().toggleCode().run()}>
        <Code size={15} />
      </Btn>
      <Btn label={s?.link ? 'Edit link' : 'Link'} shortcut="mod+k" active={s?.link} onClick={() => openLinkPopover(editor)}>
        <Link2 size={15} />
      </Btn>
      <Popover onOpenChange={setMenuOpen}>
        <Tooltip content="Colour" side="top">
          <PopoverTrigger asChild>
            <button type="button" className="emp-bubble-btn emp-bubble-color slab slab-ghost" onMouseDown={(e) => e.preventDefault()} aria-label="Colour">
              <span
                className="emp-bubble-a"
                style={{
                  color: s?.textColor ? `var(--block-${s.textColor}-text)` : undefined,
                  background: s?.bg ? `var(--block-${s.bg}-bg)` : undefined,
                }}
              >
                A
              </span>
              <ChevronDown size={12} />
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side="bottom" align="start" className="emp-color-pop" noAutoFocus>
          <ColorMenu editor={editor} current={{ text: s?.textColor ?? null, bg: s?.bg ?? null }} onDone={() => setMenuOpen(false)} />
        </PopoverContent>
      </Popover>
      <span className="emp-bubble-sep" />
      <Menu onOpenChange={setMenuOpen} modal={false}>
        <MenuTrigger asChild>
          <button type="button" className="emp-bubble-btn slab slab-ghost" aria-label="More" onMouseDown={(e) => e.preventDefault()}>
            <MoreHorizontal size={15} />
          </button>
        </MenuTrigger>
        <MenuContent side="bottom" align="end" width={230} noReturnFocus>
          <MenuItem
            icon={Sigma}
            shortcut="mod+shift+e"
            onSelect={() => {
              const { from, to } = editor.state.selection;
              const latex = editor.state.doc.textBetween(from, to, ' ');
              editor.chain().focus().insertContentAt({ from, to }, { type: 'mathInline', attrs: { latex } }).run();
            }}
          >
            Inline equation
          </MenuItem>
          <MenuItem icon={Eraser} onSelect={() => chain().unsetAllMarks().run()}>
            Clear formatting
          </MenuItem>
        </MenuContent>
      </Menu>
    </Floating>
  );
}
