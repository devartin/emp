/** Placeholder entry (owned by the databases feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface DatabasePageProps {
  pageId: Id;
  viewId?: Id;
}

export default function DatabasePage(_props: DatabasePageProps) {
  return <RouteSkeleton variant="table" label="Loading database" />;
}
