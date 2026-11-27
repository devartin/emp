/** Which screens show money (brief §2.3: the top bar's "hide numbers" eye appears only there). */
import type { AppRoute } from "@/app/router";
import type { LifeAppInstance } from "@/backend/types";

/** Apps whose screens show money. */
export const MONEY_APPS: ReadonlySet<string> = new Set(["money-hq", "portfolio", "tax-organizer"]);

/**
 * Does this screen show money? The money apps (and any page inside one, by the page's `appInstanceId`), Markets, and
 * Home once a money app is installed (its money line).
 */
export function showsMoney(route: AppRoute, lifeapps: readonly Pick<LifeAppInstance, "id" | "appId" | "detached">[], pageOwner?: string): boolean {
  const live = lifeapps.filter((i) => !i.detached && MONEY_APPS.has(i.appId));
  if (route.t === "markets") return true;
  if (route.t === "home") return live.length > 0;
  if (route.t === "app") return live.some((i) => i.id === route.instanceId);
  if (route.t !== "page" && route.t !== "db" && route.t !== "sheet" && route.t !== "row") return false;
  return !!pageOwner && live.some((i) => i.id === pageOwner);
}
