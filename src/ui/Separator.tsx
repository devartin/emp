import { cn } from "@/lib/cn";

export function Separator({ orientation = "horizontal", className }: { orientation?: "horizontal" | "vertical"; className?: string }) {
  return <div role="separator" aria-orientation={orientation} className={cn("emp-sep", className)} data-orientation={orientation} />;
}
