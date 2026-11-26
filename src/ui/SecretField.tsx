import { Eye, EyeOff } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { IconButton } from "./IconButton";
import { Input, type InputProps } from "./Input";

export type SecretFieldProps = Omit<InputProps, "type">;

/** Masked secret input with an eye toggle that crossfades over 120ms (§5.2). Never autocompletes or spellchecks. */
export function SecretField(props: SecretFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      {...props}
      type={shown ? "text" : "password"}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      className={props.className ?? "slashed"}
      trailing={
        <IconButton
          size="xs"
          label={shown ? "Hide" : "Show"}
          noTooltip
          style={{ marginRight: -4 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((s) => !s)}
          icon={
            <AnimatePresence initial={false} mode="popLayout">
              <m.span
                key={shown ? "off" : "on"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                style={{ display: "flex" }}
              >
                {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              </m.span>
            </AnimatePresence>
          }
        />
      }
    />
  );
}
