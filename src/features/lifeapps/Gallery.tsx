/**
 * Life-app gallery (§6.5 entry point "Life Apps +", DESIGN §8.5): a hero with the life stack, a category filter, and
 * app tiles that are raised panels (edge light, specular, ≤ 3° tilt) with a recessed art bay that plays a short
 * preview of the app on hover. `#/lifeapps/<appId>` opens that app's wizard directly (palette, onboarding hand-off).
 */
import { ArrowRight, Clock, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/backend";
import type { LifeAppSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { EdgeLight } from "@/ui/motion/EdgeLight";
import { Reveal, Stagger } from "@/ui/motion/primitives";
import { isReducedMotion } from "@/ui/motion/useReducedEffects";
import { AppArt } from "./Art";
import { AppTile } from "./AppTile";
import { beginHandoff } from "./handoff";
import { appVars, CATEGORY_LABEL, identity, OWN_HUBS } from "./identity";
import { LifeStack } from "./LifeStack";
import { WizardSheet } from "./WizardSheet";
import { openWizard, useWizard } from "./wizardStore";
import "./lifeapps.css";

export interface GalleryProps {
  appId?: string;
}

/**
 * Open an installed app with its tile flying from the card into the app header (shared element via the hand-off
 * layer, transform only), or start its wizard.
 */
function openApp(appId: string, instanceId: string | undefined, from?: Element | null) {
  if (!instanceId) return openWizard(appId);
  const tile = from?.closest(".la-card")?.querySelector<HTMLElement>(".la-card-stage .la-tile") ?? null;
  if (tile && OWN_HUBS.has(appId) && !isReducedMotion()) beginHandoff({ instanceId, appId, tile });
  navigate({ t: "app", instanceId });
}

export default function Gallery({ appId }: GalleryProps) {
  const [apps, setApps] = useState<LifeAppSummary[] | null>(null);
  const [cat, setCat] = useState("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [hot, setHot] = useState<string | null>(null);
  const instances = useWorkspace((s) => s.lifeapps);
  const wizardOpen = useWizard((s) => s.open);
  const firstLoad = useRef(true);

  useEffect(() => {
    api.lifeapp.list().then(setApps).catch(() => setApps([]));
  }, [instances.length, wizardOpen]);
  useEffect(() => {
    api.kv
      .get({ ns: "ui.onboarding", key: "starterApps" })
      .then((v) => setPicked(Array.isArray(v) ? (v as string[]) : []))
      .catch(() => undefined);
  }, []);
  // Deep link: open the wizard (or the hub when already installed).
  useEffect(() => {
    if (!appId) return;
    const inst = useWorkspace.getState().lifeapps.find((i) => i.appId === appId && !i.detached);
    if (inst) navigate({ t: "app", instanceId: inst.id }, { replace: true });
    else openWizard(appId);
  }, [appId]);
  useEffect(() => {
    if (apps) firstLoad.current = false;
  }, [apps]);

  const installedId = (id: string) => instances.find((i) => i.appId === id && !i.detached)?.id;
  const cats = useMemo(() => ["all", ...new Set((apps ?? []).map((a) => a.category))], [apps]);
  const shown = (apps ?? []).filter((a) => cat === "all" || a.category === cat);
  const pending = picked.filter((p) => !installedId(p) && apps?.some((a) => a.id === p));
  const installedCount = (apps ?? []).filter((a) => installedId(a.id)).length;

  return (
    <div className="la-gallery">
      <header className="la-gallery-hero">
        <Reveal variant="rise">
          <div className="la-eyebrow">
            <span className="la-led" aria-hidden />
            {apps ? `${installedCount} of ${apps.length} set up` : "Life apps"}
          </div>
          <h1>Life apps</h1>
          <p className="mt-2 max-w-[540px] text-body text-secondary">Guided setups that build the pages, databases and dashboards for you — in a few minutes, entirely on this device.</p>
          {apps && cats.length > 2 ? (
            <div className="mt-6 pb-1">
              <Segmented size="sm" value={cat} onValueChange={setCat} options={cats.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))} aria-label="Category" />
            </div>
          ) : null}
        </Reveal>
        {apps && apps.length ? <LifeStack apps={apps.map((a) => a.id)} installed={(id) => !!installedId(id)} hot={hot} enter={firstLoad.current} /> : null}
      </header>

      {pending.length ? (
        <Reveal variant="rise" delay={0.08}>
          <div className="la-picked panel" style={appVars(pending[0])}>
            <AppTile appId={pending[0]} size="sm" />
            <span className="flex-1 text-body-sm text-primary">
              You picked {pending.map((p) => identity(p).name).join(", ")} during setup. Ready when you are.
            </span>
            <Button size="sm" variant="primary" icon={Sparkles} iconMotion="sparkle" onClick={() => openWizard(pending[0])}>
              Set up {identity(pending[0]).name}
            </Button>
          </div>
        </Reveal>
      ) : null}

      {!apps ? (
        <div className="la-gallery-grid">
          {Array.from({ length: 6 }, (_, k) => (
            <div key={k} className="la-card panel">
              <Skeleton className="m-2" height={124} radius={12} />
              <div className="px-5 pt-3">
                <Skeleton width="50%" height={16} />
                <Skeleton className="mt-2" width="85%" height={12} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Stagger key={cat} kind="cards" className="la-gallery-grid">
          {shown.map((a) => {
            const inst = installedId(a.id);
            return (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                className="la-card panel"
                data-raise=""
                data-light=""
                data-specular=""
                data-tilt="3"
                style={appVars(a.id)}
                onPointerEnter={() => setHot(a.id)}
                onPointerLeave={() => setHot((h) => (h === a.id ? null : h))}
                onFocus={(e) => e.target === e.currentTarget && setHot(a.id)}
                onBlur={() => setHot((h) => (h === a.id ? null : h))}
                onClick={(e) => openApp(a.id, inst, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    openApp(a.id, inst, e.currentTarget);
                  }
                }}
                aria-label={`${a.title}${inst ? " — installed" : ""}`}
              >
                <EdgeLight specular />
                <div className="la-card-stage">
                  <AppTile appId={a.id} size="lg" />
                  <AppArt appId={a.id} />
                </div>
                <div className="la-card-body">
                  <div className="flex items-center gap-2">
                    <span className="la-card-title">{a.title}</span>
                    {inst ? <span className="la-installed">Installed</span> : null}
                  </div>
                  <p className="la-card-tag">{a.tagline}</p>
                </div>
                <div className="la-card-foot">
                  <span className="la-meta">
                    <Clock size={12} aria-hidden />~{a.estMinutes} min · {CATEGORY_LABEL[a.category] ?? a.category}
                  </span>
                  <span className="flex-1" />
                  {inst ? (
                    <>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label="Tune up"
                        icon={Settings2}
                        onClick={(e) => {
                          e.stopPropagation();
                          openWizard(a.id, { tuneup: inst });
                        }}
                      />
                      <Button size="sm" variant="secondary" iconRight={ArrowRight} iconMotion="arrow" onClick={(e) => (e.stopPropagation(), openApp(a.id, inst, e.currentTarget))}>
                        Open
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" icon={Sparkles} iconMotion="sparkle" onClick={(e) => (e.stopPropagation(), openWizard(a.id))}>
                      Set up
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </Stagger>
      )}

      <p className="mt-12 flex items-center justify-center gap-2 text-caption text-tertiary">
        <ShieldCheck size={14} aria-hidden />
        Life apps only create content in this workspace. Nothing is sent anywhere unless you connect a service.
      </p>
      <WizardSheet />
    </div>
  );
}
