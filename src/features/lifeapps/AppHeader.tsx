/**
 * Life-app landing header (§6.5): 120px app-tinted banner, 40px icon tile, h1 + subtitle, KPI row, underline tabs,
 * and the app menu — Tune up, sample data, detach and uninstall (with typed confirmation for removing content).
 */
import { Database, Ellipsis, FlaskConical, Settings2, Trash2, Unlink } from "lucide-react";
import { m } from "motion/react";
import { useState, type ReactNode } from "react";
import { api, errorMessage } from "@/backend";
import type { LifeAppInstance } from "@/backend/types";
import { navigate } from "@/app/router";
import { notify } from "@/stores/toasts";
import { useWorkspace } from "@/stores/workspace";
import { Badge } from "@/ui/Badge";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";
import { IconButton } from "@/ui/IconButton";
import { Input } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { Tabs, type TabItem } from "@/ui/Tabs";
import { spring } from "@/ui/motion/tokens";
import { appVars, identity } from "./identity";
import { openWizard } from "./wizardStore";

export interface AppHeaderProps<V extends string> {
  instance: LifeAppInstance;
  title: string;
  subtitle?: ReactNode;
  kpis?: ReactNode;
  tabs?: TabItem<V>[];
  tab?: V;
  onTab?: (v: V) => void;
  /** Extra buttons before the menu. */
  actions?: ReactNode;
}

export function AppHeader<V extends string>({ instance, title, subtitle, kpis, tabs, tab, onTab, actions }: AppHeaderProps<V>) {
  const id = identity(instance.appId);
  const Icon = id.icon;
  const [confirm, setConfirm] = useState<null | "uninstall" | "detach">(null);
  const [keep, setKeep] = useState(true);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const sample = async (on: boolean) => {
    try {
      const r = await api.lifeapp.sampleData({ instanceId: instance.id, on });
      notify.success(on ? "Sample data added" : "Sample data removed", { description: `${r.rows.toLocaleString()} rows` });
    } catch (e) {
      notify.fromError(e, "Couldn’t change sample data");
    }
  };
  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm === "detach") {
        await api.lifeapp.detach({ instanceId: instance.id });
        notify.success(`${title} detached`, { description: "Its pages are yours now; tune-ups won’t change them." });
      } else {
        await api.lifeapp.uninstall({ instanceId: instance.id, keepContent: keep });
        notify.success(`${id.name} uninstalled`, { description: keep ? "Pages and databases were kept (the hub moved to Trash)." : "Everything it created was removed." });
        navigate({ t: "lifeapps" }, { replace: true });
      }
      await useWorkspace.getState().refreshLifeapps();
      setConfirm(null);
    } catch (e) {
      notify.error("Something went wrong", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="la-hero" style={appVars(instance.appId)}>
      <div className="la-hero-banner" aria-hidden />
      <div className="la-hero-inner">
        <div className="la-hero-row">
          <m.span className="la-tile la-tile-lg" style={{ background: id.color }} initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.gentle }}>
            <Icon size={20} strokeWidth={2.1} aria-hidden />
          </m.span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate">{title}</h1>
              {instance.detached ? <Badge tone="outline">Detached</Badge> : null}
              {instance.upgradeAvailable ? <Badge tone="accent" dot>Update available</Badge> : null}
            </div>
            {subtitle ? <div className="mt-0.5 truncate text-body-sm text-secondary">{subtitle}</div> : null}
          </div>
          <div className="flex items-center gap-1">
            {actions}
            {!instance.detached ? (
              <Button variant="secondary" size="sm" icon={Settings2} onClick={() => openWizard(instance.appId, { tuneup: instance.id })}>
                Tune up
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger asChild>
                <IconButton icon={Ellipsis} label="App menu" size="sm" />
              </MenuTrigger>
              <MenuContent align="end" width={232}>
                <MenuItem icon={FlaskConical} onSelect={() => void sample(true)}>
                  Add sample data
                </MenuItem>
                <MenuItem icon={Database} onSelect={() => void sample(false)}>
                  Remove sample data
                </MenuItem>
                <MenuSeparator />
                {!instance.detached ? (
                  <MenuItem icon={Unlink} onSelect={() => setConfirm("detach")}>
                    Detach from app…
                  </MenuItem>
                ) : null}
                <MenuItem icon={Trash2} destructive onSelect={() => setConfirm("uninstall")}>
                  Uninstall {id.name}…
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        {kpis ? <div className="la-kpis">{kpis}</div> : null}
        {tabs && tab && onTab ? <Tabs className="la-tabs" value={tab} onValueChange={onTab} items={tabs} aria-label={`${title} sections`} /> : null}
      </div>
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        size="sm"
        title={confirm === "detach" ? `Detach ${title}?` : `Uninstall ${id.name}?`}
        description={confirm === "detach" ? "Generated pages and databases stay exactly as they are, but tune-ups and upgrades won’t touch them again." : "Choose what happens to what it created."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant={confirm === "detach" ? "primary" : "destructive"} loading={busy} disabled={confirm === "uninstall" && !keep && typed.trim().toLowerCase() !== id.name.toLowerCase()} onClick={run}>
              {confirm === "detach" ? "Detach" : "Uninstall"}
            </Button>
          </>
        }
      >
        {confirm === "uninstall" ? (
          <div className="flex flex-col gap-3">
            <Checkbox checked={keep} onCheckedChange={setKeep} label="Keep my pages and databases" description="Recommended. Only the app link and its reminders are removed." />
            {!keep ? <Input label={`Type “${id.name}” to delete everything it created`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} autoFocus /> : null}
          </div>
        ) : null}
      </Dialog>
    </header>
  );
}
