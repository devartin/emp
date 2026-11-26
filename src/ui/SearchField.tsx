import { Search } from "lucide-react";
import { Input, type InputProps } from "./Input";
import { Kbd } from "./Kbd";

export interface SearchFieldProps extends Omit<InputProps, "icon" | "type"> {
  /** Shortcut hint shown while unfocused (default ⌘K). Pass null to hide. */
  shortcut?: string | null;
}

/** Search field (§5.2): leading search icon, trailing Kbd that hides on focus. */
export function SearchField({ shortcut = "mod+k", placeholder = "Search", clearable = true, ...rest }: SearchFieldProps) {
  return (
    <Input
      {...rest}
      type="search"
      icon={Search}
      placeholder={placeholder}
      clearable={clearable}
      autoComplete="off"
      spellCheck={false}
      trailing={shortcut ? <span className="emp-input-kbd">{<Kbd keys={shortcut} />}</span> : rest.trailing}
    />
  );
}
