/**
 * Password field for vault screens (§6.3, §9.10): xl by default, reveal toggle (crossfade 120ms), Caps Lock warning
 * chip, never autocompletes or spellchecks. With `strength`, it calls `password_strength` (zxcvbn in Rust / the mock)
 * debounced, drops stale responses, and shows the 4-segment meter plus the estimate and the top suggestion.
 */
import { ArrowBigUp, Eye, EyeOff } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, latestRequest } from "@/backend";
import type { PasswordStrength } from "@/backend/types";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { StrengthMeter } from "@/ui/StrengthMeter";
import "./vault.css";

export interface PasswordFieldProps {
  value: string;
  onChange: (v: string) => void;
  label?: ReactNode;
  placeholder?: string;
  error?: ReactNode;
  helper?: ReactNode;
  size?: "lg" | "xl";
  autoFocus?: boolean;
  disabled?: boolean;
  /** Show the strength meter and report the score. */
  strength?: boolean;
  onStrength?: (s: PasswordStrength | null) => void;
  onEnter?: () => void;
  /** "current-password" for unlock, "new-password" for create. */
  purpose?: "current" | "new";
  name?: string;
  id?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Extra trailing element before the reveal toggle. */
  trailing?: ReactNode;
  "aria-label"?: string;
}

export function PasswordField({
  value,
  onChange,
  label,
  placeholder,
  error,
  helper,
  size = "xl",
  autoFocus,
  disabled,
  strength,
  onStrength,
  onEnter,
  purpose = "current",
  name,
  id,
  className,
  inputRef,
  trailing,
  ...aria
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const result = useStrength(strength ? value : null);
  const onStrengthRef = useRef(onStrength);
  onStrengthRef.current = onStrength;
  useEffect(() => {
    if (strength) onStrengthRef.current?.(result);
  }, [result, strength]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === "function") setCaps(e.getModifierState("CapsLock"));
    if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };

  const meterHelper = strength && value ? <StrengthHelper result={result} length={[...value].length} /> : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Input
        ref={inputRef}
        id={id}
        name={name}
        label={label}
        error={error}
        helper={error ? undefined : helper}
        size={size === "xl" ? "md" : "lg"}
        wrapperClassName={size === "xl" ? "emp-input-xl" : undefined}
        type={shown ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={purpose === "new" ? "new-password" : "current-password"}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        aria-label={aria["aria-label"]}
        className="slashed"
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onKey}
        onKeyUp={onKey}
        onBlur={() => setCaps(false)}
        trailing={
          <span className="flex items-center gap-1.5" style={{ marginRight: -6 }}>
            <AnimatePresence>
              {caps ? (
                <m.span
                  key="caps"
                  className="emp-caps-chip"
                  role="status"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1, transition: { duration: 0.12 } }}
                  exit={{ opacity: 0, transition: { duration: 0.08 } }}
                >
                  <ArrowBigUp aria-hidden /> Caps Lock
                </m.span>
              ) : null}
            </AnimatePresence>
            {trailing}
            <IconButton
              size={size === "xl" ? "sm" : "xs"}
              label={shown ? "Hide password" : "Show password"}
              noTooltip
              tabIndex={-1}
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
                    {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </m.span>
                </AnimatePresence>
              }
            />
          </span>
        }
      />
      {strength ? (
        <div className="flex flex-col gap-1.5">
          <StrengthMeter score={value ? (result?.score ?? null) : null} />
          {meterHelper}
        </div>
      ) : null}
    </div>
  );
}

const SCORE_LABEL = ["Very weak", "Weak", "Fair", "Strong", "Very strong"] as const;

function StrengthHelper({ result, length }: { result: PasswordStrength | null; length: number }) {
  if (!result) return <span className="text-caption text-tertiary" style={{ fontWeight: 400 }}>Checking…</span>;
  const tip = length < 10 ? "Use at least 10 characters." : result.warning || result.suggestions[0];
  const tone = result.score >= 3 ? "var(--gain-text)" : result.score === 2 ? "var(--warning-text)" : "var(--loss-text)";
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 text-caption" style={{ fontWeight: 400 }}>
      <span style={{ color: tone, fontWeight: 600 }}>{SCORE_LABEL[result.score]}</span>
      <span className="text-tertiary">
        {result.common ? "Found in lists of leaked passwords" : `Would take ${result.crackTime} to guess offline`}
        {tip ? ` · ${tip}` : ""}
      </span>
    </span>
  );
}

/** Debounced `password_strength` with stale-response dropping (§11.1 reqId). */
export function useStrength(password: string | null): PasswordStrength | null {
  const [res, setRes] = useState<PasswordStrength | null>(null);
  const latest = useMemo(() => latestRequest(), []);
  useEffect(() => {
    if (password === null || password === "") {
      latest.next();
      setRes(null);
      return;
    }
    const reqId = latest.next();
    const t = window.setTimeout(() => {
      api.password
        .strength({ password })
        .then((r) => {
          if (latest.isLatest(reqId)) setRes(r);
        })
        .catch(() => undefined);
    }, 90);
    return () => window.clearTimeout(t);
  }, [password, latest]);
  return res;
}

/** §9.10: zxcvbn ≥ 3 and ≥ 10 characters (the byte cap is enforced by the backend). */
export function passwordAcceptable(pw: string, s: PasswordStrength | null): boolean {
  return [...pw].length >= 10 && !!s && s.score >= 3 && !s.common;
}

export default PasswordField;
