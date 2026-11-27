/**
 * Glass is gone in Ultranote 1.0 (brief §2.4: the visual effects / transparency / glass controls and the code behind
 * them are deleted; v3 already had no backdrop blur). These two calls are what `app/boot.ts` still makes; they do
 * nothing and can be dropped from boot.ts together with this file.
 */

/** @deprecated No-op (no glass). */
export function installGlass(): void {}

/** @deprecated No-op (no glass). */
export async function syncGlassFromKv(): Promise<void> {}
