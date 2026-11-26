/** Placeholder entry (owned by the settings feature). */
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface SettingsPageProps {
  section: string;
}

export default function SettingsPage(_props: SettingsPageProps) {
  return <RouteSkeleton variant="settings" label="Loading settings" />;
}
