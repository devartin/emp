/** Suggestions (§6.4 row 5): advisor insights from every installed app, each dismissible. */
import { Lightbulb } from "lucide-react";
import { InsightsFeed } from "@/features/lifeapps/Insights";

export function SuggestionsWidget() {
  return (
    <div className="flex h-full flex-col gap-3">
      <h2 data-widget-head="" className="hm-title"><Lightbulb size={15} aria-hidden />Suggestions</h2>
      <InsightsFeed limit={3} showApp compact empty="Nothing needs your attention right now." />
    </div>
  );
}
