/**
 * Custom caption buttons (§6.1 Window chrome). Windows uses `decorations: false`, so EMP draws minimise / maximise /
 * close: 46×44 with 10px glyphs, hover `--state-hover`, close hover #C42B1C with a white glyph. On Linux they render
 * only when the window reports no system decorations. macOS keeps the native traffic lights; the browser renders none.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { isLinux, isTauri, isWindows } from "@/lib/platform";
import "./chrome.css";

type Win = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isDecorated(): Promise<boolean>;
  onResized(cb: () => void): Promise<() => void>;
};

async function currentWindow(): Promise<Win | null> {
  if (!isTauri) return null;
  try {
    const mod = await import("@tauri-apps/api/window");
    return mod.getCurrentWindow() as unknown as Win;
  } catch {
    return null;
  }
}

export function useCustomChrome(): boolean {
  const [custom, setCustom] = useState(isTauri && isWindows);
  useEffect(() => {
    if (!isTauri || !isLinux) return;
    let live = true;
    void currentWindow().then(async (w) => {
      if (!w || !live) return;
      try {
        const decorated = await w.isDecorated();
        if (live) setCustom(!decorated);
      } catch {
        /* keep system chrome */
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return custom;
}

export function WindowControls({ className }: { className?: string }) {
  const custom = useCustomChrome();
  const [win, setWin] = useState<Win | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!custom) return;
    let live = true;
    let off: (() => void) | undefined;
    void currentWindow().then(async (w) => {
      if (!w || !live) return;
      setWin(w);
      const sync = () => void w.isMaximized().then((v) => live && setMaximized(v)).catch(() => undefined);
      sync();
      try {
        off = await w.onResized(sync);
      } catch {
        /* no resize events */
      }
    });
    return () => {
      live = false;
      off?.();
    };
  }, [custom]);

  if (!custom) return null;
  return (
    <div className={cn("emp-wincontrols no-drag", className)} role="group" aria-label="Window">
      <button type="button" className="emp-wincontrol" aria-label="Minimise" onClick={() => void win?.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className="emp-wincontrol" aria-label={maximized ? "Restore" : "Maximise"} onClick={() => void win?.toggleMaximize()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2.5 2.5V.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
            <rect x=".5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x=".5" y=".5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </button>
      <button type="button" className="emp-wincontrol" data-close="" aria-label="Close" onClick={() => void win?.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

export default WindowControls;
