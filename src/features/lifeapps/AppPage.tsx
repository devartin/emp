/** Placeholder entry (owned by the life-apps feature). */
import type { Id } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface AppPageProps {
  instanceId: Id;
  tab?: string;
}

export default function AppPage(_props: AppPageProps) {
  return <RouteSkeleton variant="dashboard" label="Loading app" />;
}
