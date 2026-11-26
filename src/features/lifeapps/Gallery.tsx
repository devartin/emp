/** Placeholder entry (owned by the life-apps feature): the life-app gallery. */
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface GalleryProps {
  appId?: string;
}

export default function Gallery(_props: GalleryProps) {
  return <RouteSkeleton variant="dashboard" label="Loading life apps" />;
}
