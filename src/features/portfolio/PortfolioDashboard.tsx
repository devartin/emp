/** Placeholder entry (owned by the portfolio feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface PortfolioDashboardProps {
  instanceId: Id;
  tab?: string;
}

export default function PortfolioDashboard(_props: PortfolioDashboardProps) {
  return <RouteSkeleton variant="dashboard" label="Loading portfolio" />;
}
