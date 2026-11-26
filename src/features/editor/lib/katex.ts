/** KaTeX, loaded lazily with its CSS and fonts bundled locally (§7.11). Errors render inline in loss-text. */
type Katex = typeof import('katex');

let katexPromise: Promise<Katex> | null = null;

export function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => (m as unknown as { default: Katex }).default ?? (m as unknown as Katex));
  return katexPromise;
}

export const KATEX_OPTIONS = { trust: false, strict: 'warn' as const, maxSize: 10, maxExpand: 1000, throwOnError: true, output: 'htmlAndMathml' as const };

/** Render into `el` (replacing its children). Returns the error message, if any. */
export async function renderKatex(latex: string, el: HTMLElement, display: boolean): Promise<string | null> {
  const katex = await loadKatex();
  try {
    katex.render(latex, el, { ...KATEX_OPTIONS, displayMode: display });
    el.removeAttribute('data-error');
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^KaTeX parse error: /, '') : 'Invalid equation';
    el.replaceChildren();
    const span = document.createElement('span');
    span.className = 'emp-math-error';
    span.textContent = latex || msg;
    span.title = msg;
    el.appendChild(span);
    el.setAttribute('data-error', msg);
    return msg;
  }
}
