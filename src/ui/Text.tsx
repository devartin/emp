import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

/**
 * Text roles (docs/DESIGN.md §2.3). Four weights only (400/500/600/700); tracking 0 below 20px, −0.01em at 20–30px.
 *   title 30/39 600 · h1 24/31 600 · h2 20/26 600 · h3 16/24 600 · section 14/20 600 over a hairline (ruled, not boxed)
 *   body 14/20 400 (UI) · doc 16/24 400 (documents) · ui 13/18 · small 12/16 · micro 11/14 500 · mono 13/20
 */
export type TextVariant = "title" | "h1" | "h2" | "h3" | "section" | "body" | "doc" | "ui" | "small" | "micro" | "mono";

const DEFAULT_TAG: Record<TextVariant, "h1" | "h2" | "h3" | "h4" | "p" | "span" | "code"> = {
  title: "h1",
  h1: "h2",
  h2: "h3",
  h3: "h4",
  section: "h3",
  body: "p",
  doc: "p",
  ui: "span",
  small: "span",
  micro: "span",
  mono: "code",
};

export interface TextProps extends HTMLAttributes<HTMLElement> {
  v?: TextVariant;
  /** Element to render; defaults by variant (title → h1, h1 → h2, body → p, small → span …). */
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span" | "div" | "label" | "code" | "strong";
  tone?: "primary" | "secondary" | "tertiary";
  /** Override the variant's weight (on-scale only). */
  weight?: 400 | 500 | 600 | 700;
  /** Tabular figures (on by default app-wide; set to force inside overrides). */
  tabular?: boolean;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

/** The one type primitive: every heading and run of UI text resolves to a role, never to ad-hoc sizes. */
export function Text({ v = "body", as, tone, weight, tabular, className, children, ref, ...rest }: TextProps) {
  const Tag = (as ?? DEFAULT_TAG[v]) as "span";
  return (
    <Tag
      ref={ref as Ref<HTMLSpanElement>}
      className={cn("emp-text", className)}
      data-v={v}
      data-tone={tone && tone !== "primary" ? tone : undefined}
      data-weight={weight ? String(weight) : undefined}
      data-tabular={tabular ? "" : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}
