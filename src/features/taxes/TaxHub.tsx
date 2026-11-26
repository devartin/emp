/** Placeholder entry (owned by the taxes feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface TaxHubProps {
  instanceId: Id;
  tab?: string;
}

export default function TaxHub(_props: TaxHubProps) {
  return <RouteSkeleton variant="dashboard" label="Loading tax organizer" />;
}
