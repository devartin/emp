/** Placeholder entry (owned by the markets feature). */
import type { SymbolKey } from "@/backend/types";
import { RouteSkeleton } from "@/features/shell/RouteSkeleton";

export interface MarketsPageProps {
  symbol?: SymbolKey;
}

export default function MarketsPage(_props: MarketsPageProps) {
  return <RouteSkeleton variant="dashboard" label="Loading markets" />;
}
