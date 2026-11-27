/**
 * Project view (brief §2.2): a `page` route whose meta has `flags.project`. The page's own header (icon and title,
 * editable as on any document) comes first, then a short line of what is inside, then **Contents** grouped as
 * Documents, Spreadsheets, Databases and Apps (icon, title, last edited; a click opens), with an **Add** menu, and
 * below them the project's notes in the normal editor. An empty project shows one sentence and the four add buttons.
 *
 * The notes are the ordinary `PageView`; the contents render through a portal into a slot placed between the page
 * header and the editor column, so the title, icon, cover, history and autosave stay exactly the document's.
 */
import { AppWindow, Database, Ellipsis, FileText, FolderInput, Plus, Sheet } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { navigate, type AppRoute } from "@/app/router";
import { preloadRoute } from "@/app/routes";
import type { Id, PageMeta } from "@/backend/types";
import PageView from "@/features/editor/PageView";
import { PageIcon } from "@/features/shell/PageIcon";
import { PageMenuItems, pageActions, routeForPage, type PageAction } from "@/features/shell/PageMenu";
import { hubActions } from "@/features/shell/Sidebar/hubActions";
import { lifeAppIdentity } from "@/features/shell/Sidebar/lifeAppIdentity";
import { formatRelative } from "@/lib/dates";
import { appIndexOf, isProject, isTreeVisible, useTree, type AppHub } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/Menu";
import { createInProject } from "./actions";
import { loadAppCatalog } from "./catalog";
import { openAddApp, openMoveHere } from "./dialogs";
import { CONTENT_GROUPS, contentsSummary, type ContentGroup } from "./summary";
import "./projects.css";

export interface ProjectPageProps {
  pageId: Id;
  blockId?: string;
}

export default function ProjectPage({ pageId, blockId }: ProjectPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const slot = useContentsSlot(hostRef, pageId);
  // "Add an app…" opens with its list: fetch the catalogue while the project is on screen.
  useEffect(() => {
    void loadAppCatalog().catch(() => undefined);
  }, []);
  return (
    <div ref={hostRef} className="emp-project" data-project-id={pageId}>
      <PageView pageId={pageId} blockId={blockId} />
      {slot ? createPortal(<ProjectContents projectId={pageId} />, slot) : null}
    </div>
  );
}

/**
 * A slot element between the document's header and its editor column (`.emp-page-body`), kept in place while the
 * page view re-renders or reloads. Removed on unmount.
 */
function useContentsSlot(hostRef: RefObject<HTMLDivElement | null>, pageId: Id): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = document.createElement("div");
    el.className = "emp-page-column emp-project-slot";
    const place = () => {
      const body = host.querySelector<HTMLElement>(".emp-page-body");
      if (!body?.parentElement) {
        if (el.isConnected) el.remove();
        setSlot(null);
        return;
      }
      if (el.nextElementSibling !== body) body.parentElement.insertBefore(el, body);
      setSlot(el);
    };
    // Watch only the page view's root and its direct children (not the editor's subtree, which changes on every
    // keystroke): the column appears when the page has loaded and goes when it reloads.
    let root: Element | null = null;
    const mo = new MutationObserver(() => {
      const next = host.firstElementChild;
      if (next !== root) {
        root = next;
        if (root) mo.observe(root, { childList: true });
      }
      place();
    });
    mo.observe(host, { childList: true });
    root = host.firstElementChild;
    if (root) mo.observe(root, { childList: true });
    place();
    return () => {
      mo.disconnect();
      el.remove();
    };
  }, [hostRef, pageId]);
  return slot;
}

type Group = ContentGroup;
const GROUPS = CONTENT_GROUPS;

interface Item {
  meta: PageMeta;
  hub?: AppHub;
}

function groupOf(item: Item): Group {
  if (item.hub) return "apps";
  if (item.meta.kind === "sheet") return "sheets";
  if (item.meta.kind === "database") return "databases";
  return "documents";
}

function ProjectContents({ projectId }: { projectId: Id }) {
  const lifeapps = useWorkspace((s) => s.lifeapps);
  const apps = useMemo(() => appIndexOf(lifeapps), [lifeapps]);
  const project = useTree((s) => s.byId.get(projectId));
  const kids = useTree(
    useShallow((s) =>
      (s.children.get(projectId) ?? [])
        .map((id) => s.byId.get(id))
        .filter((m): m is PageMeta => !!m && isTreeVisible(m)),
    ),
  );
  const groups = useMemo(() => {
    const out: Record<Group, Item[]> = { documents: [], sheets: [], databases: [], apps: [] };
    for (const meta of kids) {
      const item: Item = { meta, hub: apps.hubs.get(meta.id) };
      out[groupOf(item)].push(item);
    }
    return out;
  }, [kids, apps]);
  if (!project || !isProject(project)) return null;
  const counts = { documents: groups.documents.length, sheets: groups.sheets.length, databases: groups.databases.length, apps: groups.apps.length };
  const summary = contentsSummary(counts);
  const empty = !summary;

  return (
    <section className="emp-project-contents" aria-label="Contents" data-empty={empty ? "" : undefined}>
      {empty ? (
        <div className="emp-project-empty">
          <p>Nothing in this project yet. Add a document, a spreadsheet, a database or an app to keep the work together.</p>
          <div className="emp-project-empty-actions">
            <Button size="sm" variant="secondary" icon={FileText} onClick={() => void createInProject(projectId, "doc")}>
              New document
            </Button>
            <Button size="sm" variant="secondary" icon={Sheet} onClick={() => void createInProject(projectId, "sheet")}>
              New spreadsheet
            </Button>
            <Button size="sm" variant="secondary" icon={Database} onClick={() => void createInProject(projectId, "database")}>
              New database
            </Button>
            <Button size="sm" variant="secondary" icon={AppWindow} onClick={() => openAddApp(projectId)}>
              Add an app…
            </Button>
          </div>
          <Button className="emp-project-empty-move" size="sm" variant="link" icon={FolderInput} onClick={() => openMoveHere(projectId)}>
            Move an existing page here…
          </Button>
        </div>
      ) : (
        <>
          <div className="emp-project-head">
            <h2>Contents</h2>
            <span className="emp-project-summary" data-testid="project-summary">
              {summary}
            </span>
            <AddMenu projectId={projectId} />
          </div>
          {GROUPS.map((g) =>
            groups[g.id].length ? (
              <div key={g.id} className="emp-project-group" data-group={g.id}>
                <h3>
                  {g.title}
                  <span className="count">{groups[g.id].length}</span>
                </h3>
                <ul>
                  {groups[g.id].map((item) => (
                    <ContentRow key={item.meta.id} item={item} />
                  ))}
                </ul>
              </div>
            ) : null,
          )}
          <h2 className="emp-project-notes-head">Notes</h2>
        </>
      )}
    </section>
  );
}

function AddMenu({ projectId }: { projectId: Id }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="ghost" icon={Plus} className="emp-project-add">
          Add
        </Button>
      </MenuTrigger>
      <MenuContent align="end" width={240}>
        <MenuItem icon={FileText} onSelect={() => void createInProject(projectId, "doc")}>
          New document
        </MenuItem>
        <MenuItem icon={Sheet} onSelect={() => void createInProject(projectId, "sheet")}>
          New spreadsheet
        </MenuItem>
        <MenuItem icon={Database} onSelect={() => void createInProject(projectId, "database")}>
          New database
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={AppWindow} onSelect={() => openAddApp(projectId)}>
          Add an app…
        </MenuItem>
        <MenuItem icon={FolderInput} onSelect={() => openMoveHere(projectId)}>
          Move an existing page here…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function ContentRow({ item }: { item: Item }) {
  const { meta, hub } = item;
  const [menuOpen, setMenuOpen] = useState(false);
  const app = hub ? lifeAppIdentity(hub.appId) : null;
  const title = app ? app.name : meta.title || "Untitled";
  const route: AppRoute = hub ? { t: "app", instanceId: hub.instanceId } : routeForPage(meta);
  const Glyph: ComponentType<{ "aria-hidden"?: boolean }> | null = app ? app.icon : null;
  const actions = (): PageAction[] => (hub ? hubActions(meta, hub) : pageActions(meta));
  return (
    <li className="emp-project-row" data-id={meta.id} data-menu-open={menuOpen ? "" : undefined}>
      <button type="button" className="emp-project-open" onClick={() => navigate(route)} onPointerEnter={() => preloadRoute(route)}>
        <span className="glyph">{Glyph ? <Glyph aria-hidden /> : <PageIcon icon={meta.icon} kind={meta.kind} project={isProject(meta)} size={16} />}</span>
        <span className="title">{title}</span>
        {hub ? null : <span className="edited">Edited {formatRelative(Math.min(meta.updatedAt, Date.now()))}</span>}
      </button>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger asChild>
          <button type="button" className="emp-project-more" aria-label={`Actions for ${title}`}>
            <Ellipsis aria-hidden />
          </button>
        </MenuTrigger>
        {menuOpen ? (
          <MenuContent align="end" width={264}>
            <PageMenuItems actions={actions()} />
          </MenuContent>
        ) : null}
      </Menu>
    </li>
  );
}
