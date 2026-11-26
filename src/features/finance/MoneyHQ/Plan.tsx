/**
 * Plan (PROGRAMME-v3 K4): the forward-looking half of Money HQ in one tab — Recurring, Debt, Forecast and Goals. Each
 * section keeps its own route (`…/recurring`, `…/debt`, `…/forecast`, `…/goals`), so links into the old tabs land
 * here at the right section.
 */
import { lazy, Suspense } from "react";
import { Segmented } from "@/ui/Segmented";
import { PLAN_SECTIONS, useMoney, type PlanSection } from "./MoneyHQ";

const loadRecurring = () => import("./Recurring");
const loadDebt = () => import("../DebtPlanner");
const loadForecast = () => import("../Forecast");
const loadGoals = () => import("./Goals");
const Recurring = lazy(loadRecurring);
const DebtPlanner = lazy(loadDebt);
const Forecast = lazy(loadForecast);
const Goals = lazy(loadGoals);
// Fetched with the tab, so switching sections never paints a placeholder.
void Promise.all([loadRecurring(), loadDebt(), loadForecast(), loadGoals()]).catch(() => undefined);

const LABEL: Record<PlanSection, string> = { recurring: "Recurring", debt: "Debt", forecast: "Forecast", goals: "Goals" };

export default function Plan() {
  const { planSection, go, instanceId } = useMoney();
  return (
    <div className="flex flex-col gap-4">
      <Segmented size="sm" value={planSection} onValueChange={(v) => go(v)} aria-label="Plan section" options={PLAN_SECTIONS.map((s) => ({ value: s, label: LABEL[s] }))} className="self-start" />
      <Suspense fallback={null}>
        {planSection === "recurring" ? <Recurring /> : null}
        {planSection === "debt" ? <DebtPlanner /> : null}
        {planSection === "forecast" ? <Forecast instanceId={instanceId} /> : null}
        {planSection === "goals" ? <Goals /> : null}
      </Suspense>
    </div>
  );
}
