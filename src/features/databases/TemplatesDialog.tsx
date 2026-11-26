/**
 * Row templates (§8.6): `{id, name, icon, values, doc}`, one can be the default. Values can be literal cells or
 * template variables (`@today`, `@today+7d`, `@now`, `@name`, `@seq`) resolved when a row is created.
 */
import { AnimatePresence, m } from 'motion/react';
import { LayoutTemplate, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/backend';
import type { CellValue, Id, RowTemplate } from '@/backend/types';
import { cn } from '@/lib/cn';
import { notify } from '@/stores/toasts';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { IconButton } from '@/ui/IconButton';
import { IconPicker } from '@/ui/IconPicker';
import { glyphName, PageGlyph } from '@/ui/icons/Icon';
import { Select } from '@/ui/Select';
import { transitions } from '@/ui/motion/presets';
import { useDbView } from './context';
import { RowProperties } from './properties/RowProperties';
import { useSchemas } from './store';

const DATE_TOKENS = [
  { value: '', label: 'Fixed value' },
  { value: '@today', label: 'Today' },
  { value: '@today+1d', label: 'Tomorrow' },
  { value: '@today+7d', label: 'In a week' },
  { value: '@today+14d', label: 'In two weeks' },
  { value: '@today+1m', label: 'In a month' },
  { value: '@now', label: 'Now (with time)' },
];

export function TemplatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { schema, databaseId } = useDbView();
  const [list, setList] = useState<RowTemplate[]>(() => structuredClone(schema.database.templates));
  const [defId, setDefId] = useState<Id | undefined>(schema.database.defaultTemplateId);
  const [sel, setSel] = useState<Id | null>(list[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const cur = list.find((t) => t.id === sel) ?? null;
  const update = (patch: Partial<RowTemplate>) => setList((l) => l.map((t) => (t.id === sel ? { ...t, ...patch } : t)));
  const add = () => {
    const t: RowTemplate = { id: `tpl_${Date.now().toString(36)}`, name: 'New template', icon: { t: 'lucide', v: 'clipboard-list' }, values: {} };
    setList((l) => [...l, t]);
    setSel(t.id);
  };
  const save = async () => {
    setSaving(true);
    try {
      let s = await api.db.update({ id: databaseId, patch: { templates: list } });
      if (defId !== s.database.defaultTemplateId) s = await api.db.update({ id: databaseId, patch: { defaultTemplateId: defId ?? null } });
      useSchemas.getState().set(s);
      notify.success('Templates saved');
      onOpenChange(false);
    } catch (e) {
      notify.fromError(e, "Couldn't save templates");
    } finally {
      setSaving(false);
    }
  };
  const values: Record<Id, CellValue> = {};
  const tokens: Record<Id, string> = {};
  if (cur) for (const [k, v] of Object.entries(cur.values)) typeof v === 'string' ? (tokens[k] = v) : (values[k] = v);
  const dateProps = schema.properties.filter((p) => p.type === 'date');
  const title = cur ? cur.values[schema.database.primaryPropId] : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Row templates"
      description="Start new rows with values already filled in. Template variables are resolved when the row is created."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save templates
          </Button>
        </>
      }
    >
      <div className="edb-tpl">
        <aside className="edb-tpl-list">
          {list.map((t) => (
            <button key={t.id} type="button" className={cn('emp-menu-item w-full', t.id === sel && 'is-sel')} onClick={() => setSel(t.id)}>
              <span className="emp-menu-icon">{glyphName(t.icon) ? <PageGlyph icon={t.icon} context="row" /> : <LayoutTemplate size={16} />}</span>
              <span className="emp-menu-label text-left">{t.name}</span>
              {defId === t.id ? <Star size={12} className="text-accent-text" aria-label="Default" /> : null}
            </button>
          ))}
          <Button size="sm" variant="ghost" icon={Plus} onClick={add} block>
            New template
          </Button>
        </aside>
        <AnimatePresence mode="wait" initial={false}>
          <m.section key={sel ?? 'none'} className="edb-tpl-body" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: transitions.crossfade }} exit={{ opacity: 0, transition: transitions.menuOut }}>
            {cur ? (
              <>
                <div className="flex items-center gap-2">
                  <IconPicker value={glyphName(cur.icon)} onSelect={(name) => update({ icon: { t: 'lucide', v: name } })} onRemove={cur.icon ? () => update({ icon: undefined }) : undefined}>
                    <button type="button" className="edb-input inline-flex w-12 items-center justify-center" aria-label="Template icon">
                      {glyphName(cur.icon) ? <PageGlyph icon={cur.icon} context="row" /> : <LayoutTemplate size={16} className="text-tertiary" />}
                    </button>
                  </IconPicker>
                  <input className="edb-input flex-1 text-title" value={cur.name} onChange={(e) => update({ name: e.target.value })} aria-label="Template name" />
                  <Button size="sm" variant={defId === cur.id ? 'soft' : 'ghost'} icon={Star} onClick={() => setDefId(defId === cur.id ? undefined : cur.id)}>
                    {defId === cur.id ? 'Default' : 'Make default'}
                  </Button>
                  <IconButton size="sm" icon={Trash2} label="Delete template" onClick={() => (setList((l) => l.filter((t) => t.id !== cur.id)), setSel(list.find((t) => t.id !== cur.id)?.id ?? null), defId === cur.id && setDefId(undefined))} />
                </div>
                <input
                  className="edb-input w-full"
                  placeholder="Row title (supports @today, @name, @seq)"
                  value={typeof title === 'string' ? title : title && title.t === 'text' ? title.v.map((s) => s.text).join('') : ''}
                  onChange={(e) => update({ values: { ...cur.values, [schema.database.primaryPropId]: e.target.value } })}
                  aria-label="Row title"
                />
                {dateProps.map((p) => (
                  <div key={p.id} className="edb-cfg-row">
                    <span className="edb-cfg-label">{p.name}</span>
                    <div className="edb-cfg-control">
                      <Select size="sm" value={tokens[p.id] ?? ''} onValueChange={(v) => {
                        const next = { ...cur.values };
                        if (v) next[p.id] = v;
                        else delete next[p.id];
                        update({ values: next });
                      }} options={DATE_TOKENS} />
                    </div>
                  </div>
                ))}
                <RowProperties
                  schema={{ ...schema, properties: schema.properties.filter((p) => !tokens[p.id] && p.id !== schema.database.primaryPropId) }}
                  row={null}
                  values={values}
                  template
                  onChange={(pid, v) => {
                    const next = { ...cur.values };
                    if (v === null) delete next[pid];
                    else next[pid] = v;
                    update({ values: next });
                  }}
                />
                <p className="edb-hint">{cur.doc ? 'This template also adds a page body.' : 'Tip: rows created from a template get its page body too.'}</p>
              </>
            ) : (
              <EmptyState icon={LayoutTemplate} title="No templates yet" body="Templates pre-fill properties for new rows, such as “Bug report” or “Weekly review”." actions={<Button variant="primary" icon={Plus} onClick={add}>New template</Button>} />
            )}
          </m.section>
        </AnimatePresence>
      </div>
    </Dialog>
  );
}
