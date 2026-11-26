/**
 * Loading skeletons for route content (§5.10): used as Suspense fallbacks by routes.tsx and as the resting state of
 * placeholder entry components until their feature owners replace them. Layout mirrors the real screens so the
 * crossfade to content (160ms) does not jump.
 */
import { Skeleton, SkeletonText } from "@/ui/Skeleton";
import { cn } from "@/lib/cn";

export type RouteSkeletonVariant = "doc" | "table" | "dashboard" | "grid" | "list" | "calendar" | "settings";

export interface RouteSkeletonProps {
  variant?: RouteSkeletonVariant;
  /** Accessible label, e.g. "Loading page". */
  label?: string;
  className?: string;
}

export function RouteSkeleton({ variant = "doc", label = "Loading", className }: RouteSkeletonProps) {
  return (
    <div className={cn("emp-route-skeleton", className)} data-variant={variant} role="status" aria-live="polite" aria-label={label}>
      {variant === "doc" ? <DocSkeleton /> : null}
      {variant === "table" ? <TableSkeleton /> : null}
      {variant === "dashboard" ? <DashboardSkeleton /> : null}
      {variant === "grid" ? <GridSkeleton /> : null}
      {variant === "list" ? <ListSkeleton /> : null}
      {variant === "calendar" ? <CalendarSkeleton /> : null}
      {variant === "settings" ? <SettingsSkeleton /> : null}
    </div>
  );
}

function DocSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pt-16">
      <Skeleton width={52} height={52} radius={12} />
      <Skeleton width="58%" height={30} radius={8} className="mt-6" />
      <div className="mt-8 flex flex-col gap-5">
        <SkeletonText lines={3} />
        <SkeletonText lines={2} />
        <Skeleton width="100%" height={88} radius={10} />
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="w-full px-12 pt-14">
      <Skeleton width={44} height={44} radius={10} />
      <Skeleton width={260} height={26} radius={8} className="mt-5" />
      <div className="mt-6 flex gap-2">
        {[72, 64, 80].map((w, i) => (
          <Skeleton key={i} width={w} height={24} radius={6} />
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-lg border border-subtle">
        {Array.from({ length: 9 }, (_, r) => (
          <div key={r} className="flex h-9 items-center gap-6 border-b border-subtle px-3 last:border-b-0">
            <Skeleton width={r === 0 ? 90 : 180 - ((r * 37) % 70)} height={10} />
            <Skeleton width={70} height={10} />
            <Skeleton width={110 - ((r * 13) % 40)} height={10} />
            <Skeleton width={56} height={10} className="ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="w-full px-12 pt-12">
      <Skeleton width={220} height={28} radius={8} />
      <Skeleton width={160} height={12} className="mt-3" />
      <div className="mt-8 grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-xl border border-subtle bg-surface-1 p-4">
            <Skeleton width={80} height={10} />
            <Skeleton width={120} height={22} radius={6} className="mt-3" />
            <Skeleton width="100%" height={28} radius={6} className="mt-4" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="col-span-2 rounded-xl border border-subtle bg-surface-1 p-4">
          <Skeleton width={140} height={12} />
          <Skeleton width="100%" height={220} radius={8} className="mt-4" />
        </div>
        <div className="rounded-xl border border-subtle bg-surface-1 p-4">
          <Skeleton width={110} height={12} />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton width={20} height={20} shape="circle" />
                <Skeleton width={`${60 - i * 5}%`} height={10} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-subtle px-3">
        <Skeleton width={48} height={14} />
        <Skeleton width="40%" height={14} />
      </div>
      <div className="flex-1 overflow-hidden" style={{ backgroundImage: "linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)", backgroundSize: "96px 24px" }} />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-14">
      <Skeleton width={180} height={26} radius={8} />
      <div className="mt-8 flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-11 items-center gap-3 rounded-lg px-2">
            <Skeleton width={20} height={20} radius={5} />
            <Skeleton width={`${54 - ((i * 11) % 24)}%`} height={11} />
            <Skeleton width={64} height={10} className="ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div className="w-full px-10 pt-10">
      <div className="flex items-center gap-3">
        <Skeleton width={180} height={24} radius={8} />
        <Skeleton width={120} height={28} radius={8} className="ml-auto" />
      </div>
      <div className="mt-6 grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-subtle bg-[var(--border-subtle)]">
        {Array.from({ length: 35 }, (_, i) => (
          <div key={i} className="h-[96px] bg-canvas p-2">
            <Skeleton width={18} height={10} />
            {i % 4 === 1 ? <Skeleton width="80%" height={16} radius={4} className="mt-3" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex h-full w-full">
      <div className="w-[220px] flex-none border-r border-subtle p-4">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} width={`${70 - ((i * 9) % 30)}%`} height={12} className="mb-4" />
        ))}
      </div>
      <div className="flex-1 px-12 pt-12">
        <Skeleton width={200} height={24} radius={8} />
        <div className="mt-8 flex flex-col gap-6">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="flex-1">
                <Skeleton width={160} height={12} />
                <Skeleton width={260} height={10} className="mt-2" />
              </div>
              <Skeleton width={120} height={28} radius={8} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default RouteSkeleton;
