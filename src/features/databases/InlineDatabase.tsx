/** Placeholder entry (owned by the databases feature): inline database block inside a doc. */
import type { Id } from "@/backend/types";
import { Skeleton } from "@/ui/Skeleton";

export interface InlineDatabaseProps {
  databaseId: Id;
  viewId?: Id;
}

export default function InlineDatabase(_props: InlineDatabaseProps) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-subtle" role="status" aria-label="Loading database">
      {Array.from({ length: 4 }, (_, r) => (
        <div key={r} className="flex h-9 items-center gap-6 border-b border-subtle px-3 last:border-b-0">
          <Skeleton width={160 - r * 20} height={10} />
          <Skeleton width={70} height={10} />
          <Skeleton width={50} height={10} className="ml-auto" />
        </div>
      ))}
    </div>
  );
}
