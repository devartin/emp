/** Placeholder entry (owned by the sheets feature): an embedded sheet range. */
import type { Id } from "@/backend/types";
import { Skeleton } from "@/ui/Skeleton";

export interface SheetEmbedProps {
  pageId: Id;
  sheetId?: Id;
  range?: string;
}

export default function SheetEmbed(_props: SheetEmbedProps) {
  return (
    <div className="my-2 h-40 overflow-hidden rounded-lg border border-subtle" role="status" aria-label="Loading sheet">
      <Skeleton width="100%" height="100%" radius={0} />
    </div>
  );
}
