/** Shared context for one rendered database view (schema, view, controller and view-level actions). */
import { createContext, useContext } from 'react';
import type { CellValue, DbSchema, Id, Property, View } from '@/backend/types';
import type { ViewController } from './ViewController';

export interface DbViewCtx {
  databaseId: Id;
  schema: DbSchema;
  view: View;
  controller: ViewController;
  propsById: Map<Id, Property>;
  inline: boolean;
  readOnly: boolean;
  patchView(patch: Partial<View>): void;
  openRow(rowId: Id, mode?: 'peek' | 'page'): void;
  /** Open the filter builder, optionally adding a condition for a property. */
  openFilter(propId?: Id): void;
  newRow(values?: Record<Id, CellValue>, opts?: { group?: string; afterId?: Id; open?: boolean; templateId?: Id }): Promise<Id | null>;
  editProperty(propId: Id, anchor?: HTMLElement | null): void;
}

export const DbViewContext = createContext<DbViewCtx | null>(null);

export function useDbView(): DbViewCtx {
  const c = useContext(DbViewContext);
  if (!c) throw new Error('useDbView outside a database view');
  return c;
}
