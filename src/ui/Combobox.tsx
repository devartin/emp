import * as RP from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, Plus } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Field } from "./Field";
import { GlideHighlight } from "./GlideHighlight";
import { floatingZ, useInOverlay } from "./layer";
import { Tag, type TagColor } from "./Tag";

export interface ComboOption {
  value: string;
  label: string;
  color?: TagColor;
}

export interface ComboboxProps {
  /** Selected values (multi-select). */
  value: string[];
  onValueChange: (v: string[]) => void;
  options: ComboOption[];
  /** "Create '…'" → return the new option's value (caller persists it). */
  onCreate?: (label: string) => string | void;
  placeholder?: string;
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  /** Max selected (1 = single select with tag display). */
  max?: number;
  className?: string;
  id?: string;
}

/**
 * Tag combobox (§5.3): an input-like field holding Tag pills; typing filters the menu-skinned list; Backspace removes
 * the last tag; "Create '…'" row at the bottom.
 */
export function Combobox({ value, onValueChange, options, onCreate, placeholder = "Add…", label, helper, error, disabled, max, className, id }: ComboboxProps) {
  const auto = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const z = floatingZ(useInOverlay());
  const byValue = new Map(options.map((o) => [o.value, o]));
  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());

  const toggle = (v: string) => {
    if (value.includes(v)) onValueChange(value.filter((x) => x !== v));
    else if (max === 1) onValueChange([v]);
    else if (!max || value.length < max) onValueChange([...value, v]);
    setQuery("");
    if (max === 1) setOpen(false);
  };

  const field = (ids: { id?: string; describedBy?: string; invalid: boolean }) => (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Anchor asChild>
        <div
          className={cn("emp-input emp-tagfield", className)}
          data-invalid={ids.invalid ? "" : undefined}
          data-disabled={disabled ? "" : undefined}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }}
        >
          {value.map((v) => {
            const o = byValue.get(v);
            return (
              <Tag key={v} color={o?.color ?? "gray"} onRemove={() => onValueChange(value.filter((x) => x !== v))}>
                {o?.label ?? v}
              </Tag>
            );
          })}
          <input
            ref={inputRef}
            id={ids.id}
            aria-describedby={ids.describedBy}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            value={query}
            disabled={disabled}
            placeholder={value.length ? "" : placeholder}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !query && value.length) onValueChange(value.slice(0, -1));
              if (e.key === "Escape") setOpen(false);
              // forward navigation keys to cmdk
              if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
                e.preventDefault();
                const list = document.querySelector<HTMLElement>(`[data-combobox-for="${CSS.escape(ids.id ?? "")}"]`);
                list?.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true }));
              }
            }}
          />
        </div>
      </RP.Anchor>
      <RP.Portal>
        <RP.Content
          className="emp-menu emp-pop emp-listbox"
          data-opaque={z ? "" : undefined}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          style={z}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement)?.closest?.(".emp-tagfield")) e.preventDefault();
          }}
        >
          <Command loop data-combobox-for={ids.id} className="outline-none" filter={(v, s, k) => ((k?.join(" ") ?? v).toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}>
            <Command.Input value={query} onValueChange={setQuery} style={{ position: "absolute", opacity: 0, pointerEvents: "none", height: 0 }} tabIndex={-1} aria-hidden />
            <Command.List>
              <GlideHighlight selector={'[cmdk-item][data-selected="true"]'} />
              {!onCreate ? <Command.Empty>No matches</Command.Empty> : null}
              {options.map((o) => (
                <Command.Item key={o.value} value={o.value} keywords={[o.label]} className="emp-menu-item" onSelect={() => toggle(o.value)}>
                  <span className="emp-menu-label">
                    <Tag color={o.color ?? "gray"}>{o.label}</Tag>
                  </span>
                  {value.includes(o.value) ? (
                    <span className="emp-menu-check">
                      <Check aria-hidden />
                    </span>
                  ) : null}
                </Command.Item>
              ))}
              {onCreate && query.trim() && !exact ? (
                <Command.Item
                  value={`__create__${query}`}
                  keywords={[query]}
                  className="emp-menu-item"
                  onSelect={() => {
                    const v = onCreate(query.trim());
                    if (v) toggle(v);
                    setQuery("");
                  }}
                >
                  <span className="emp-menu-icon">
                    <Plus aria-hidden />
                  </span>
                  <span className="emp-menu-label">
                    Create <span className="font-medium">“{query.trim()}”</span>
                  </span>
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );

  if (label || helper || error) {
    return (
      <Field label={label} helper={helper} error={error} id={id}>
        {field}
      </Field>
    );
  }
  return field({ id: id ?? `cbx${auto}`, invalid: false });
}
