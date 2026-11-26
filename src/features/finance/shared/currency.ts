/**
 * The workspace's base currency (Settings → General → Base currency, `VaultSettings.baseCurrency`) for figures the
 * finance screens compute themselves (ledger sums, planner what-ifs, forecasts). A figure that arrives from the backend
 * as `Money` keeps its own ISO 4217 code — format it with `m.currency`, never with this.
 *
 * Read at call time, so the formatter defaults follow a change of base currency without a reload.
 */
import { selectBaseCurrency, useSettings } from "@/stores/settings";

/** The base currency now (ISO 4217, e.g. "EUR"). */
export function baseCurrency(): string {
  return selectBaseCurrency(useSettings.getState());
}

/** The base currency as React state: re-renders when it changes in Settings. */
export function useBaseCurrency(): string {
  return useSettings(selectBaseCurrency);
}
