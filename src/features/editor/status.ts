/**
 * Save status of the page on screen, for the editor's saved indicator and the shell's "Edited 2m ago" (§6.1).
 *   useEditorStatus(s => s.savedAt)   // ms timestamp of the last successful save, or null
 */
import { create } from 'zustand';
import type { Id } from '@/backend/types';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict' | 'offline';

export interface EditorStatus {
  ownerId: Id | null;
  state: SaveState;
  savedAt: number | null;
  error: string | null;
  set(p: Partial<Omit<EditorStatus, 'set'>>): void;
}

export const useEditorStatus = create<EditorStatus>()((set) => ({
  ownerId: null,
  state: 'idle',
  savedAt: null,
  error: null,
  set: (p) => set(p),
}));
