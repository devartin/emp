/** Placeholder entry (owned by the sheets feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface SheetPageProps {
  pageId: Id;
  sheetId?: Id;
}

export default function SheetPage(_props: SheetPageProps) {
  return <RouteSkeleton variant="grid" label="Loading workbook" />;
}
