/** Block equation (§7.11): KaTeX display mode; click to edit in a popover with a live preview. */
import type { NodeViewProps } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { Sigma } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { renderKatex } from '../lib/katex';
import { Floating } from '../menus/Floating';
import { MathEditor } from '../menus/OverlayHost';

export default function MathBlockView({ node, updateAttributes, editor, getPos, selected, deleteNode }: NodeViewProps) {
  const latex = String(node.attrs.latex ?? '');
  const out = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const readOnly = !editor.isEditable;

  useEffect(() => {
    if (out.current && latex.trim()) void renderKatex(latex, out.current, true);
  }, [latex]);

  // A freshly inserted empty equation opens its editor.
  useEffect(() => {
    if (selected && !latex.trim() && !readOnly) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const select = () => {
    const pos = getPos();
    if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  };

  return (
    <div ref={box} className="emp-math-block" data-empty={latex.trim() ? undefined : ''} onClick={() => {
      select();
      if (!readOnly) setEditing(true);
    }}>
      {latex.trim() ? <div ref={out} className="emp-math-out" /> : (
        <div className="emp-math-empty">
          <Sigma size={16} />
          <span>Add a TeX equation</span>
        </div>
      )}
      <Floating
        open={editing}
        anchor={() => {
          const r = box.current?.getBoundingClientRect();
          return r ? { x: r.left + r.width / 2 - 180, y: r.top, width: 360, height: r.height } : null;
        }}
        placement="bottom"
        onClose={() => {
          setEditing(false);
          if (!String(node.attrs.latex ?? '').trim()) deleteNode();
        }}
        className="emp-popover-card"
        role="dialog"
        ariaLabel="Edit equation"
        zIndex={45}
      >
        <MathEditor
          initial={latex}
          display
          onCancel={() => {
            setEditing(false);
            if (!latex.trim()) deleteNode();
            else editor.commands.focus();
          }}
          onDelete={() => {
            setEditing(false);
            deleteNode();
          }}
          onCommit={(v) => {
            setEditing(false);
            if (!v.trim()) return deleteNode();
            updateAttributes({ latex: v });
            editor.commands.focus();
          }}
        />
      </Floating>
    </div>
  );
}
