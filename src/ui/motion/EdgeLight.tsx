/**
 * Edge light + specular — retired in v3 ("paper, ink and keys": no pointer light, no specular). Kept as a component
 * that renders nothing so feature code that still mounts it compiles.
 */
export function EdgeLight(_props: { specular?: boolean }) {
  void _props;
  return null;
}
