/**
 * Life-app gallery (§6.5 entry point "Life Apps +"): category filter, cards with app colour + line art, installed
 * state, and the wizard. `#/lifeapps/<appId>` opens that app's wizard directly (palette, onboarding hand-off).
 */
import { ArrowRight, Check, Clock, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/backend";
import type { LifeAppSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { spring } from "@/ui/motion/tokens";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { AppArt } from "./Art";
import { appVars, CATEGORY_LABEL, identity } from "./identity";
import { WizardSheet } from "./WizardSheet";
import { openWizard, useWizard } from "./wizardStore";
import "./lifeapps.css";

export interface GalleryProps {
  appId?: string;
}

export default function Gallery({ appId }: GalleryProps) {
  const [apps, setApps] = useState<LifeAppSummary[] | null>(null);
  const [cat, setCat] = useState("all");
  const [picked, setPicked] = useState<string[]>([]);
  const instances = useWorkspace((s) => s.lifeapps);
  const wizardOpen = useWizard((s) => s.open);

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

  const installedId = (id: string) => instances.find((i) => i.appId === id && !i.detached)?.id;
  const cats = useMemo(() => ["all", ...new Set((apps ?? []).map((a) => a.category))], [apps]);
  const shown = (apps ?? []).filter((a) => cat === "all" || a.category === cat);
  const pending = picked.filter((p) => !installedId(p) && apps?.some((a) => a.id === p));

  return (
    <div className="la-gallery">
      <header className="la-gallery-hero">
        <div>
          <h1 className="text-h1 text-primary">Life apps</h1>
          <p className="mt-1.5 max-w-[560px] text-body text-secondary">Guided setups that build the pages, databases and dashboards for you — in a few minutes, entirely on this device.</p>
        </div>
        {apps && cats.length > 2 ? (
          <Segmented size="sm" value={cat} onValueChange={setCat} options={cats.map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))} aria-label="Category" />
        ) : null}
      </header>

      {pending.length ? (
        <div className="la-picked">
          <Sparkles size={16} className="flex-none text-accent-text" aria-hidden />
          <span className="flex-1 text-body-sm text-primary">
            You picked {pending.map((p) => identity(p).name).join(", ")} during setup. Ready when you are.
          </span>
          <Button size="sm" variant="primary" onClick={() => openWizard(pending[0])}>
            Set up {identity(pending[0]).name}
          </Button>
        </div>
      ) : null}

      {!apps ? (
        <div className="la-gallery-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="la-card p-5">
              <Skeleton height={80} radius={10} />
              <Skeleton className="mt-5" width="50%" height={16} />
              <Skeleton className="mt-2" width="85%" height={12} />
            </div>
          ))}
        </div>
      ) : (
        <m.div className="la-gallery-grid" variants={staggerList(0.05)} initial="hidden" animate="show" key={cat}>
          {shown.map((a) => {
            const id = identity(a.id);
            const Icon = id.icon;
            const inst = installedId(a.id);
            return (
              <m.div key={a.id} variants={staggerItem}>
                <m.div
                  role="button"
                  tabIndex={0}
                  className="la-card cursor-pointer"
                  style={appVars(a.id)}
                  whileTap={{ scale: 0.985 }}
                  transition={spring.snappy}
                  onClick={() => (inst ? navigate({ t: "app", instanceId: inst }) : openWizard(a.id))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (inst) navigate({ t: "app", instanceId: inst });
                      else openWizard(a.id);
                    }
                  }}
                  aria-label={`${a.title}${inst ? " — installed" : ""}`}
                >
                  <div className="la-card-art">
                    <span className="la-tile la-tile-lg" style={{ background: id.color }}>
                      <Icon size={20} strokeWidth={2.1} aria-hidden />
                    </span>
                    <AppArt appId={a.id} />
                  </div>
                  <div className="la-card-body">
                    <div className="flex items-center gap-2">
                      <span className="la-card-title">{a.title}</span>
                      {inst ? (
                        <span className="la-installed">
                          <Check size={12} strokeWidth={3} aria-hidden />
                          Installed
                        </span>
                      ) : null}
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
                          label="Tune up"
                          icon={Settings2}
                          onClick={(e) => {
                            e.stopPropagation();
                            openWizard(a.id, { tuneup: inst });
                          }}
                        />
                        <Button size="sm" variant="secondary" iconRight={ArrowRight} onClick={(e) => (e.stopPropagation(), navigate({ t: "app", instanceId: inst }))}>
                          Open
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="primary" icon={Sparkles} onClick={(e) => (e.stopPropagation(), openWizard(a.id))}>
                        Set up
                      </Button>
                    )}
                  </div>
                </m.div>
              </m.div>
            );
          })}
        </m.div>
      )}

      <p className="mt-10 flex items-center justify-center gap-2 text-caption text-tertiary">
        <ShieldCheck size={14} aria-hidden />
        Life apps only create content in this workspace. Nothing is sent anywhere unless you connect a service.
      </p>
      <WizardSheet />
    </div>
  );
}
