/**
 * Edge light + specular spans (docs/DESIGN.md §4.6). Render as the FIRST child of a `[data-light]` surface
 * (`.panel` already uses ::before for grain and ::after for the raise shadow, so these are real spans).
 * The global pointer tracker (pointerLight.ts) writes --mx/--my on the surface under the pointer.
 *
 *   <div className="panel" data-light data-specular><EdgeLight specular />…</div>
 */
export function EdgeLight({ specular }: { specular?: boolean }) {
  return (
    <>
      {specular ? <span className="emp-specular" aria-hidden /> : null}
      <span className="emp-edge" aria-hidden />
    </>
  );
}
