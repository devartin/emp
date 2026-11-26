/** Placeholder entry (owned by the finance feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface MoneyHQProps {
  instanceId: Id;
  tab?: string;
}

export default function MoneyHQ(_props: MoneyHQProps) {
  return <RouteSkeleton variant="dashboard" label="Loading Money HQ" />;
}
