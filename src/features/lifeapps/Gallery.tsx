/**
 * Life-app gallery (§6.5 entry point "Add a life app"): a ruled list, one row per app — glyph, name, one-line
 * description and one verb (Open or Set up). No hero art, tiles, pills or time estimates (PROGRAMME-v3 K1/K2).
 * `#/lifeapps/<appId>` opens that app's wizard directly (palette, onboarding hand-off).
 */
import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import type { LifeAppSummary } from "@/backend/types";
import { navigate } from "@/app/router";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Skeleton } from "@/ui/Skeleton";
import { identity } from "./identity";
import { WizardSheet } from "./WizardSheet";
import { openWizard, useWizard } from "./wizardStore";
import "./lifeapps.css";

export interface GalleryProps {
  appId?: string;
}

export default function Gallery({ appId }: GalleryProps) {
  const [apps, setApps] = useState<LifeAppSummary[] | null>(null);
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
  const pending = picked.filter((p) => !installedId(p) && apps?.some((a) => a.id === p));

  return (
    <div className="la-gallery">
      <header className="la-gallery-head">
        <h1>Life apps</h1>
        <p>Each app sets up the pages and databases for one area of your life. Everything stays on this device.</p>
      </header>

      {pending.length ? (
        <p className="la-picked">
          <span>Picked during setup: {pending.map((p) => identity(p).name).join(", ")}.</span>
          <Button size="sm" variant="secondary" onClick={() => openWizard(pending[0])}>
            Set up {identity(pending[0]).name}
          </Button>
        </p>
      ) : null}

      {!apps ? (
        <ul className="la-list" aria-label="Loading life apps">
          {Array.from({ length: 6 }, (_, k) => (
            <li key={k} className="la-list-row">
              <Skeleton width="40%" height={16} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="la-list">
          {apps.map((a) => {
            const inst = installedId(a.id);
            const Icon = identity(a.id).icon;
            return (
              <li key={a.id} className="la-list-row">
                <Icon size={16} strokeWidth={1.75} className="la-list-glyph" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="la-list-name">{a.title}</div>
                  <p className="la-list-desc">{a.tagline}</p>
                </div>
                {inst ? (
                  <>
                    <IconButton size="sm" variant="ghost" label={`Tune up ${a.title}`} icon={Settings2} onClick={() => openWizard(a.id, { tuneup: inst })} />
                    <Button size="sm" variant="secondary" onClick={() => navigate({ t: "app", instanceId: inst })}>
                      Open
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => openWizard(a.id)}>
                    Set up
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="la-gallery-foot">Life apps only create content in this workspace. Nothing is sent anywhere unless you connect a service.</p>
      <WizardSheet />
    </div>
  );
}
