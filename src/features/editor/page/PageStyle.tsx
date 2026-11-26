/** Page style options: font (Default / Serif / Mono), small text, full width, lock page (§11.2 PageFlags). */
import { Lock } from 'lucide-react';
import type { ReactElement } from 'react';
import type { PageFlags, PageFont } from '@/backend/types';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/Popover';
import { Switch } from '@/ui/Switch';

const FONTS: { id: PageFont; label: string; cls: string }[] = [
  { id: 'sans', label: 'Default', cls: 'emp-font-sans' },
  { id: 'serif', label: 'Serif', cls: 'emp-font-serif' },
  { id: 'mono', label: 'Mono', cls: 'emp-font-mono' },
];

export function PageStyle({ flags, onChange, children }: { flags: PageFlags; onChange: (patch: Partial<PageFlags>) => void; children: ReactElement }) {
  const font = flags.font ?? 'sans';
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="emp-style-pop">
        <div className="emp-menu-header">Font</div>
        <div className="emp-font-cards" role="radiogroup" aria-label="Page font">
          {FONTS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={font === f.id} className={cn('emp-font-card', font === f.id && 'is-active')} onClick={() => onChange({ font: f.id })}>
              <span className={cn('emp-font-ag', f.cls)}>Ag</span>
              <span className="emp-font-label">{f.label}</span>
            </button>
          ))}
        </div>
        <div className="emp-style-rows">
          <Switch size="sm" labelFirst label="Small text" checked={!!flags.smallText} onCheckedChange={(v) => onChange({ smallText: v })} />
          <Switch size="sm" labelFirst label="Full width" checked={!!flags.fullWidth} onCheckedChange={(v) => onChange({ fullWidth: v })} />
          <Switch
            size="sm"
            labelFirst
            label={
              <span className="inline-flex items-center gap-1.5">
                <Lock size={12} /> Lock page
              </span>
            }
            description="Prevent accidental edits"
            checked={!!flags.locked}
            onCheckedChange={(v) => onChange({ locked: v })}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
