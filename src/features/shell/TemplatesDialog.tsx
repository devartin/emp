/**
 * Template gallery (sidebar → Templates, palette "Browse templates"): built-in templates plus pages marked as
 * templates, grouped by category. Applying creates the page at the top level (or inside the current page) and opens it.
 */
import { LayoutTemplate, Plus } from "lucide-react";
import { m } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { navigate, routePageId, useRoute } from "@/app/router";
import { api } from "@/backend";
import type { TemplateInfo } from "@/backend/types";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Dialog } from "@/ui/Dialog";
import { EmptyState } from "@/ui/EmptyState";
import { Segmented } from "@/ui/Segmented";
import { Skeleton } from "@/ui/Skeleton";
import { staggerItem, staggerList } from "@/ui/motion/presets";
import { PageIcon } from "./PageIcon";

export function TemplatesDialog() {
  const open = useUi((s) => s.templatesOpen);
  const setOpen = useUi((s) => s.setTemplatesOpen);
  const wsId = useWorkspace((s) => s.workspace?.id);
  const route = useRoute();
  const here = routePageId(route);
  const hereMeta = useTree((s) => (here ? s.byId.get(here) : undefined));
  const [list, setList] = useState<TemplateInfo[] | null>(null);
  const [cat, setCat] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [inside, setInside] = useState<"top" | "here">("top");

  useEffect(() => {
    if (!open || !wsId) return;
    let live = true;
    setList(null);
    api.template
      .list({ workspaceId: wsId })
      .then((r) => live && setList(r))
      .catch((e) => {
        if (live) setList([]);
        notify.fromError(e, "Couldn't load templates");
      });
    return () => {
      live = false;
    };
  }, [open, wsId]);

  const cats = useMemo(() => Array.from(new Set((list ?? []).map((t) => t.category))), [list]);
  const shown = (list ?? []).filter((t) => cat === "all" || t.category === cat);
  const canNest = !!hereMeta && hereMeta.kind === "doc";

  const apply = async (t: TemplateInfo) => {
    if (!wsId || busy) return;
    setBusy(t.id);
    try {
      const meta = await api.template.apply({ templateId: t.id, workspaceId: wsId, parentId: inside === "here" && canNest ? (here as string) : null });
      useTree.getState().upsert([meta]);
      useTree.getState().reveal(meta.id);
      setOpen(false);
      navigate({ t: "page", id: meta.id });
    } catch (e) {
      notify.fromError(e, "Couldn't use that template");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} size="xl" title="Templates" description="Start from a ready-made page. Mark any page as a template from its menu to see it here.">
      <div className="flex flex-wrap items-center gap-3">
        {cats.length > 1 ? (
          <Segmented size="sm" aria-label="Category" value={cat} onValueChange={setCat} options={[{ value: "all", label: "All" }, ...cats.map((c) => ({ value: c, label: c }))]} />
        ) : null}
        <span className="flex-1" />
        {canNest ? (
          <Segmented
            size="sm"
            aria-label="Where to add"
            value={inside}
            onValueChange={setInside}
            options={[
              { value: "top", label: "Top level" },
              { value: "here", label: `Inside “${(hereMeta?.title || "Untitled").slice(0, 24)}”` },
            ]}
          />
        ) : null}
      </div>
      <div className="mt-4 max-h-[58vh] overflow-y-auto pb-1 pr-1">
        {list === null ? (
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="emp-tpl-card">
                <Skeleton width={36} height={36} radius={10} />
                <Skeleton width="70%" height={11} />
                <Skeleton width="40%" height={9} />
              </div>
            ))}
          </div>
        ) : shown.length ? (
          <m.div className="grid grid-cols-3 gap-3" variants={staggerList(0.025)} initial="hidden" animate="show">
            {shown.map((t) => (
              <m.button key={t.id} type="button" className="emp-tpl-card" variants={staggerItem} onClick={() => void apply(t)} disabled={!!busy} aria-busy={busy === t.id || undefined}>
                <span className="tile">
                  <PageIcon icon={t.icon} kind={t.kind} size={20} />
                </span>
                <span className="text-body font-medium text-primary">{t.title}</span>
                <span className="flex items-center gap-1 text-caption text-tertiary" style={{ fontWeight: 400 }}>
                  {t.builtin ? t.category : "My template"}
                  <Plus size={12} className="ml-auto opacity-60" aria-hidden />
                </span>
              </m.button>
            ))}
          </m.div>
        ) : (
          <EmptyState icon={LayoutTemplate} title="No templates here" body="Pages you mark as templates appear in this gallery." />
        )}
      </div>
    </Dialog>
  );
}

export default TemplatesDialog;
