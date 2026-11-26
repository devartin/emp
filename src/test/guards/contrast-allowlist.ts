/**
 * Token pairs below their contrast target. Format: "<theme>/<accent>: <fg token> on <bg token>".
 * Emptied by the v3 token lane (L1 kit, "paper, ink and keys", 2026-11-26): --border-strong is now the control
 * boundary token at ≥ 3:1 in every theme. The list may only shrink; it is empty, so every new failure fails CI.
 */
export const CONTRAST_ALLOWLIST: string[] = [];
