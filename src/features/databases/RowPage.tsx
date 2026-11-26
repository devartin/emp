/** Placeholder entry (owned by the databases feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface RowPageProps {
  rowId: Id;
}

export default function RowPage(_props: RowPageProps) {
  return <RouteSkeleton variant="doc" label="Loading row" />;
}
