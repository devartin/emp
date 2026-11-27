/**
 * The project pickers (brief §2.2), mounted once by the shell:
 *
 *   Move to project…            pick a project for a page or an app (or create one by typing its name)
 *   Move an existing page here… pick pages to move into this project
 *   Add an app…                 an installed app moves into the project; an app not yet installed opens its set-up,
 *                               which installs it with its hub inside the project (`lifeapp_install.parentId`)
 *
 * One instance per app stays the rule, so an installed app is moved, never installed twice.
 */
import { Check, FolderKanban, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { navigate } from "@/app/router";
import type { Id, LifeAppSummary, PageMeta } from "@/backend/types";
import { openWizard } from "@/features/lifeapps/wizardStore";
import { PageIcon } from "@/features/shell/PageIcon";
import { lifeAppIdentity } from "@/features/shell/Sidebar/lifeAppIdentity";
import { notify } from "@/stores/toasts";
import { appIndexOf, isAppOwned, isProject, isTreeVisible, selectAncestors, selectProjects, useTree, type AppIndex } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { SearchField } from "@/ui/SearchField";
import { Skeleton } from "@/ui/Skeleton";
import { moveIntoProject } from "./actions";
import { cachedAppCatalog, loadAppCatalog } from "./catalog";
import { useProjectDialogs } from "./dialogs";
import "./projects.css";

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const nameOf = (m: Pick<PageMeta, "title"> | undefined) => m?.title.trim() || "Untitled";

function useApps(): AppIndex {
  const lifeapps = useWorkspace((s) => s.lifeapps);
  return useMemo(() => appIndexOf(lifeapps), [lifeapps]);
}

export function ProjectDialogs() {
  const dialog = useProjectDialogs((s) => s.dialog);
  const close = useProjectDialogs((s) => s.close);
  return (
    <>
      <MoveToProjectDialog pageId={dialog?.kind === "moveTo" ? dialog.pageId : null} onClose={close} />
      <MoveHereDialog projectId={dialog?.kind === "moveHere" ? dialog.projectId : null} onClose={close} />
      <AddAppDialog projectId={dialog?.kind === "addApp" ? dialog.projectId : null} onClose={close} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────── Move to project…

function MoveToProjectDialog({ pageId, onClose }: { pageId: Id | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const page = useTree((s) => (pageId ? s.byId.get(pageId) : undefined));
  const projects = useTree(useShallow((s) => selectProjects(s)));
  const apps = useApps();
  useEffect(() => {
    if (pageId) setQuery("");
  }, [pageId]);
  const blocked = useMemo(() => {
    // A page can't move into itself or anything inside it.
    const out = new Set<Id>();
    if (!pageId) return out;
    const tree = useTree.getState();
    for (const p of projects) {
      if (p.id === pageId || selectAncestors(tree, p.id).some((a) => a.id === pageId)) out.add(p.id);
    }
    return out;
  }, [projects, pageId]);
  const q = fold(query.trim());
  const shown = projects.filter((p) => !blocked.has(p.id) && (!q || fold(p.title).includes(q)));
  const exact = projects.some((p) => fold(p.title.trim()) === q);
  const hub = pageId ? apps.hubs.get(pageId) : undefined;
  const label = hub ? lifeAppIdentity(hub.appId).name : nameOf(page);

  const choose = async (projectId: Id) => {
    if (!pageId) return;
    onClose();
    await moveIntoProject(pageId, projectId, label);
  };
  const createAndChoose = async () => {
    if (!pageId) return;
    const title = query.trim().slice(0, 200);
    onClose();
    try {
      const made = await useTree.getState().createPage({ parentId: null, title, flags: { project: true } });
      await moveIntoProject(pageId, made.id, label);
    } catch (e) {
      notify.fromError(e, "Couldn't create the project");
    }
  };

  return (
    <Dialog open={!!pageId && !!page} onOpenChange={(o) => !o && onClose()} size="sm" title={`Move “${label}” to a project`} bodyClassName="emp-pick-body">
      <SearchField
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Enter takes the first match, or creates the project when nothing matches.
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          const first = shown.find((p) => p.id !== page?.parentId);
          if (first) void choose(first.id);
          else if (q && !exact) void createAndChoose();
        }}
        placeholder="Find or name a project"
        shortcut={null}
        autoFocus
        data-autofocus
        aria-label="Find or name a project"
      />
      <ul className="emp-pick-list" aria-label="Projects">
        {shown.map((p) => {
          const here = page?.parentId === p.id;
          return (
            <li key={p.id}>
              <button type="button" className="emp-pick-row" disabled={here} onClick={() => void choose(p.id)}>
                <span className="glyph">
                  <PageIcon icon={p.icon} kind={p.kind} project size={16} />
                </span>
                <span className="title">{nameOf(p)}</span>
                {here ? <span className="meta">Already here</span> : null}
              </button>
            </li>
          );
        })}
        {q && !exact ? (
          <li>
            <button type="button" className="emp-pick-row" onClick={() => void createAndChoose()}>
              <span className="glyph">
                <Plus aria-hidden />
              </span>
              <span className="title">New project “{query.trim()}”</span>
            </button>
          </li>
        ) : null}
      </ul>
      {!shown.length && !q ? <p className="emp-pick-empty">No projects yet. Type a name to create one.</p> : null}
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── Move an existing page here…

function MoveHereDialog({ projectId, onClose }: { projectId: Id | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [moved, setMoved] = useState<Set<Id>>(new Set());
  const project = useTree((s) => (projectId ? s.byId.get(projectId) : undefined));
  const apps = useApps();
  const candidates = useTree(
    useShallow((s) => {
      if (!projectId) return [] as PageMeta[];
      const above = new Set(selectAncestors(s, projectId).map((a) => a.id));
      const out: PageMeta[] = [];
      // Top-level pages and apps first, then everything nested, in tree order. Pages inside an app stay with it.
      const walk = (parent: Id | null, depth: number, acc: PageMeta[][]) => {
        for (const id of s.children.get(parent) ?? []) {
          const m = s.byId.get(id);
          if (!m || !isTreeVisible(m) || id === projectId) continue;
          if (isAppOwned(m, apps)) continue;
          if (!above.has(id) && m.parentId !== projectId) (acc[Math.min(depth, 1)] ??= []).push(m);
          if (!apps.hubs.has(id)) walk(id, depth + 1, acc);
        }
      };
      const acc: PageMeta[][] = [[], []];
      walk(null, 0, acc);
      out.push(...acc[0], ...acc[1]);
      return out;
    }),
  );
  useEffect(() => {
    if (projectId) {
      setQuery("");
      setMoved(new Set());
    }
  }, [projectId]);
  const q = fold(query.trim());
  const label = (m: PageMeta) => {
    const hub = apps.hubs.get(m.id);
    return hub ? lifeAppIdentity(hub.appId).name : nameOf(m);
  };
  const shown = candidates.filter((m) => !q || fold(label(m)).includes(q)).slice(0, 200);
  const done = [...moved].map((id) => useTree.getState().byId.get(id)).filter((m): m is PageMeta => !!m && m.parentId === projectId);

  const move = async (m: PageMeta) => {
    if (!projectId) return;
    if (await moveIntoProject(m.id, projectId, label(m))) setMoved((s) => new Set(s).add(m.id));
  };

  return (
    <Dialog
      open={!!projectId && !!project}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Move pages into “${nameOf(project)}”`}
      description="Pick a page or an app. It moves with everything inside it."
      bodyClassName="emp-pick-body"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <SearchField
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !q || !shown[0]) return;
          e.preventDefault();
          void move(shown[0]);
        }}
        placeholder="Find a page"
        shortcut={null}
        autoFocus
        data-autofocus
        aria-label="Find a page"
      />
      <ul className="emp-pick-list" aria-label="Pages">
        {done.map((m) => (
          <li key={`done-${m.id}`}>
            <div className="emp-pick-row" data-done="">
              <span className="glyph">
                <Check aria-hidden />
              </span>
              <span className="title">{label(m)}</span>
              <span className="meta">Moved</span>
            </div>
          </li>
        ))}
        {shown.map((m) => {
          const hub = apps.hubs.get(m.id);
          const Glyph = hub ? lifeAppIdentity(hub.appId).icon : null;
          const where = m.parentId ? nameOf(useTree.getState().byId.get(m.parentId)) : null;
          return (
            <li key={m.id}>
              <button type="button" className="emp-pick-row" onClick={() => void move(m)}>
                <span className="glyph">{Glyph ? <Glyph aria-hidden /> : <PageIcon icon={m.icon} kind={m.kind} project={isProject(m)} size={16} />}</span>
                <span className="title">{label(m)}</span>
                {where ? <span className="meta">In {where}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {!shown.length ? <p className="emp-pick-empty">{q ? "No page matches." : "Every page is already here."}</p> : null}
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────── Add an app…

function AddAppDialog({ projectId, onClose }: { projectId: Id | null; onClose: () => void }) {
  const project = useTree((s) => (projectId ? s.byId.get(projectId) : undefined));
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const hubParents = useTree(useShallow((s) => lifeapps.map((i) => s.byId.get(i.rootPageId)?.parentId ?? null)));
  const [catalog, setCatalog] = useState<LifeAppSummary[] | null>(cachedAppCatalog);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!projectId || catalog) return;
    let live = true;
    setFailed(false);
    loadAppCatalog()
      .then((list) => live && setCatalog(list))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [projectId, catalog]);

  const moveHere = async (rootPageId: Id, appName: string) => {
    if (!projectId) return;
    onClose();
    await moveIntoProject(rootPageId, projectId, appName);
  };
  const setUp = (appId: string) => {
    if (!projectId) return;
    onClose();
    // The app's set-up runs in the gallery and installs with its hub inside this project (lifeapp_install.parentId).
    openWizard(appId, { parentId: projectId });
    navigate({ t: "lifeapps" });
  };

  return (
    <Dialog
      open={!!projectId && !!project}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Add an app to “${nameOf(project)}”`}
      description="Each app has one copy in your workspace. An app you already use moves into this project."
      bodyClassName="emp-pick-body"
    >
      <ul className="emp-pick-list" aria-label="Apps" aria-busy={(!catalog && !failed) || undefined}>
        {!catalog && !failed
          ? Array.from({ length: 6 }, (_, i) => (
              <li key={`loading-${i}`} aria-hidden>
                <div className="emp-pick-row" data-loading="">
                  <span className="glyph">
                    <Skeleton width={16} height={16} radius={4} />
                  </span>
                  <span className="title">
                    <Skeleton width={i % 2 ? 96 : 120} height={10} />
                    <Skeleton width={i % 3 ? 180 : 150} height={8} className="mt-1.5" />
                  </span>
                  <Skeleton width={72} height={28} radius={6} />
                </div>
              </li>
            ))
          : null}
        {(catalog ?? []).map((a) => {
          const id = lifeAppIdentity(a.id);
          const Glyph = id.icon;
          const at = lifeapps.findIndex((i) => i.appId === a.id && !i.detached);
          const inst = at >= 0 ? lifeapps[at] : undefined;
          const here = !!inst && hubParents[at] === projectId;
          return (
            <li key={a.id}>
              <div className="emp-pick-row" data-app={a.id}>
                <span className="glyph">
                  <Glyph aria-hidden />
                </span>
                <span className="title">
                  {id.name}
                  {a.tagline ? <span className="sub">{a.tagline}</span> : null}
                </span>
                {here ? (
                  <span className="meta">In this project</span>
                ) : inst ? (
                  <Button size="sm" variant="secondary" icon={FolderKanban} onClick={() => void moveHere(inst.rootPageId, id.name)}>
                    Move here
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setUp(a.id)}>
                    Set up
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!catalog && !failed ? <p className="emp-pick-empty" role="status">Loading the apps…</p> : null}
      {failed ? <p className="emp-pick-empty">The apps couldn't be listed. Close this and try again.</p> : null}
    </Dialog>
  );
}
