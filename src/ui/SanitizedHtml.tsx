import DOMPurify from "dompurify";
import { useMemo } from "react";

export interface SanitizedHtmlProps {
  html: string;
  className?: string;
  /** Allow <img> (remote images are still subject to the CSP and the remoteImages setting). */
  allowImages?: boolean;
  as?: "div" | "span";
}

const FORBID_TAGS = ["style", "script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base"];

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  // Force safe link behaviour; navigation goes through open_external (the shell intercepts clicks).
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node instanceof Element && node.tagName === "A") {
      node.setAttribute("rel", "noopener noreferrer nofollow");
      node.setAttribute("target", "_blank");
    }
  });
}

/**
 * The ONLY place allowed to use dangerouslySetInnerHTML (§9.15, CLAUDE.md). DOMPurify with a strict profile:
 * no scripts/styles/forms/frames, no event handlers, no javascript:/data: URLs except data:image when images are on.
 */
export function SanitizedHtml({ html, className, allowImages = false, as = "div" }: SanitizedHtmlProps) {
  const clean = useMemo(() => {
    ensureHooks();
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: allowImages ? FORBID_TAGS : [...FORBID_TAGS, "img", "picture", "source", "video", "audio"],
      FORBID_ATTR: ["style", "srcset", "formaction", "xlink:href"],
      ALLOW_DATA_ATTR: false,
      ALLOWED_URI_REGEXP: allowImages ? /^(?:https?:|mailto:|emp-asset:|data:image\/(?:png|jpe?g|gif|webp);base64,|#)/i : /^(?:https?:|mailto:|#)/i,
    });
  }, [html, allowImages]);
  const Tag = as;
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}
