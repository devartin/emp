import * as RP from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { renderIcon, type IconComponent } from "./Button";
import { Field } from "./Field";
import { floatingZ, useInOverlay } from "./layer";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  icon?: IconComponent | ReactNode;
  description?: string;
  disabled?: boolean;
  group?: string;
  /** Custom rendering in list + trigger (e.g. a Tag). */
  render?: ReactNode;
}

export interface SelectProps<V extends string = string> {
  value: V | null;
  onValueChange: (v: V) => void;
  options: SelectOption<V>[];
  placeholder?: string;
  size?: "sm" | "md" | "lg";
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Force typeahead filtering (auto above 8 options, §5.3). */
  searchable?: boolean;
  /** Shows a "Create '…'" row at the bottom. */
  onCreate?: (label: string) => void;
  className?: string;
  /** Wider list than trigger. */
  listWidth?: number;
  id?: string;
  "aria-label"?: string;
}

/**
 * Select (§5.3): input-like trigger with chevrons-up-down; menu-skinned list matching the trigger width (min 200);
 * typeahead filtering above 8 options; optional "Create '…'" row. Keyboard: ↑↓ ↵ Esc, type to filter.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  size = "md",
  label,
  helper,
  error,
  required,
  disabled,
  searchable,
  onCreate,
  className,
  listWidth,
  id,
  ...aria
}: SelectProps<V>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const z = floatingZ(useInOverlay());
  const selected = options.find((o) => o.value === value) ?? null;
  const search = searchable ?? (options.length > 8 || !!onCreate);
  const groups = useMemo(() => {
    const map = new Map<string, SelectOption<V>[]>();
    for (const o of options) {
      const g = o.group ?? "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(o);
    }
    return [...map.entries()];
  }, [options]);
  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase());

  const trigger = (ids: { id?: string; describedBy?: string; invalid: boolean }) => (
    <RP.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <RP.Trigger asChild disabled={disabled}>
        <button
          type="button"
          id={ids.id}
          className={cn("emp-input emp-select-trigger", className)}
          data-size={size === "md" ? undefined : size}
          data-invalid={ids.invalid ? "" : undefined}
          data-disabled={disabled ? "" : undefined}
          data-placeholder={selected ? undefined : ""}
          aria-describedby={ids.describedBy}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={aria["aria-label"]}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="emp-select-value">
            {selected ? (
              selected.render ?? (
                <>
                  {selected.icon ? <span className="emp-input-icon">{renderIcon(selected.icon)}</span> : null}
                  {selected.label}
                </>
              )
            ) : (
              placeholder
            )}
          </span>
          <ChevronsUpDown className="emp-select-chevron" aria-hidden />
        </button>
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          className="emp-menu emp-pop emp-listbox"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          style={{ ...z, ...(listWidth ? { width: listWidth } : null) }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const root = e.currentTarget as HTMLElement;
            (root.querySelector<HTMLElement>("[cmdk-input]") ?? root.querySelector<HTMLElement>("[cmdk-root]"))?.focus();
          }}
        >
          <Command
            loop
            tabIndex={-1}
            defaultValue={value ?? undefined}
            shouldFilter={search}
            className="outline-none"
            filter={(v, s, keywords) => {
              const hay = (keywords?.join(" ") ?? v).toLowerCase();
              const q = s.toLowerCase().trim();
              if (!q) return 1;
              if (hay.startsWith(q)) return 1;
              return hay.includes(q) ? 0.6 : 0;
            }}
          >
            {search ? (
              <div className="emp-listbox-search">
                <Search aria-hidden />
                <Command.Input value={query} onValueChange={setQuery} placeholder={onCreate ? "Search or create…" : "Search…"} />
              </div>
            ) : null}
            <Command.List role="listbox">
              {search && !onCreate ? <Command.Empty>No matches</Command.Empty> : null}
              {groups.map(([g, opts]) => {
                const items = opts.map((o) => (
                  <Command.Item
                    key={o.value}
                    value={o.value}
                    keywords={[o.label, o.description ?? ""]}
                    disabled={o.disabled}
                    className="emp-menu-item"
                    onSelect={() => {
                      onValueChange(o.value);
                      setOpen(false);
                      setQuery("");
                    }}
                    role="option"
                    aria-selected={o.value === value}
                  >
                    {o.render ? (
                      <span className="emp-menu-label">{o.render}</span>
                    ) : (
                      <>
                        {o.icon ? <span className="emp-menu-icon">{renderIcon(o.icon)}</span> : null}
                        <span className="emp-menu-label flex flex-col">
                          <span className="truncate">{o.label}</span>
                        </span>
                        {o.description ? <span className="emp-menu-trail truncate max-w-[45%]">{o.description}</span> : null}
                      </>
                    )}
                    {o.value === value ? (
                      <span className="emp-menu-check">
                        <Check aria-hidden />
                      </span>
                    ) : null}
                  </Command.Item>
                ));
                return g ? (
                  <Command.Group key={g} heading={g}>
                    {items}
                  </Command.Group>
                ) : (
                  <Command.Group key="_">{items}</Command.Group>
                );
              })}
              {onCreate && query.trim() && !exact ? (
                <Command.Item
                  value={`__create__${query}`}
                  keywords={[query]}
                  className="emp-menu-item"
                  onSelect={() => {
                    onCreate(query.trim());
                    setOpen(false);
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
      <Field label={label} helper={helper} error={error} required={required} id={id}>
        {trigger}
      </Field>
    );
  }
  return trigger({ id, invalid: false });
}
