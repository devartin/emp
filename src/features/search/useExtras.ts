/** Loads paletteExtras.ts on first use (a separate chunk) and re-renders once it has arrived. */
import { useEffect, useState } from "react";
import type { PaletteExtras } from "./paletteExtras";

let cache: PaletteExtras | null = null;
let pending: Promise<PaletteExtras> | null = null;

export function loadExtras(): Promise<PaletteExtras> {
  pending ??= import("./paletteExtras").then((m) => (cache = m));
  return pending;
}

export function useExtras(enabled = true): PaletteExtras | null {
  const [mod, setMod] = useState<PaletteExtras | null>(cache);
  useEffect(() => {
    if (mod || !enabled) return;
    let live = true;
    loadExtras()
      .then((m) => live && setMod(m))
      .catch(() => {
        pending = null;
      });
    return () => {
      live = false;
    };
  }, [mod, enabled]);
  return mod;
}
