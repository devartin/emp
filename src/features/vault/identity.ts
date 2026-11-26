/**
 * What the lock screen may show while every data command returns LOCKED: the workspace name and its emoji, cached on
 * this device when the shell opens. Nothing else is cached (§9.20 lists what is visible on disk; the name is listed).
 */
import type { Workspace } from "@/backend/types";

const KEY = "emp.lock";

export interface LockIdentity {
  workspaceName?: string;
  emoji?: string;
}

export function readLockIdentity(): LockIdentity {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as LockIdentity;
    return {
      workspaceName: typeof v.workspaceName === "string" ? v.workspaceName.slice(0, 80) : undefined,
      emoji: typeof v.emoji === "string" ? v.emoji.slice(0, 8) : undefined,
    };
  } catch {
    return {};
  }
}

export function writeLockIdentity(ws: Pick<Workspace, "name" | "icon"> | null): void {
  try {
    if (!ws) {
      localStorage.removeItem(KEY);
      return;
    }
    const next: LockIdentity = { workspaceName: ws.name, emoji: ws.icon?.t === "emoji" ? ws.icon.v : undefined };
    const raw = JSON.stringify(next);
    if (localStorage.getItem(KEY) !== raw) localStorage.setItem(KEY, raw);
  } catch {
    /* storage unavailable */
  }
}
