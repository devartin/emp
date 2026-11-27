/**
 * Settings (1.0 brief §2.4): a large dialog over the app (about 960×680) with its own short list on the left, so
 * there is never a second navigation rail beside the sidebar. Five sections (General, Appearance, Privacy & security,
 * Backups & data, Connections), each ending in one "More options" disclosure, and About at the foot of the list.
 *
 * `#/settings/<section>[:<anchor>]` opens it (routes.tsx keeps the page you came from behind it). Old section ids
 * resolve through `meta.SECTION_ALIASES`; an anchor inside More options opens the disclosure, then scrolls to the row
 * and flashes it. Closing goes back to where you were.
 */
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { navigate, useRoute } from "@/app/router";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Dialog } from "@/ui/Dialog";
import { Skeleton } from "@/ui/Skeleton";
import { fuzzyAny } from "@/features/search/fuzzy";
import { closeSettings } from "./close";
import { resolveTarget, SECTIONS, SETTING_ENTRIES, type SectionId } from "./meta";
import { useSettingsUi } from "./parts";
import { ReauthHost } from "./reauth";
import { AboutSection } from "./sections/About";
import { AppearanceSection } from "./sections/Appearance";
import { BackupsSection } from "./sections/Backups";
import { ConnectionsSection } from "./sections/Connections";
import { GeneralSection } from "./sections/General";
import { SecuritySection } from "./security/SecuritySection";
import "./settings.css";

export interface SettingsPageProps {
  section: string;
}

const VIEWS: Record<SectionId, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  security: SecuritySection,
  data: BackupsSection,
  connections: ConnectionsSection,
  about: AboutSection,
};

const MAIN = SECTIONS.filter((s) => !s.foot);
const FOOT = SECTIONS.filter((s) => s.foot);

function flash(anchor: string): boolean {
  const el = document.querySelector<HTMLElement>(`.st-pane [data-setting="${CSS.escape(anchor)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: document.documentElement.getAttribute("data-motion") === "reduced" ? "auto" : "smooth" });
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
  window.setTimeout(() => el.classList.remove("is-flash"), 1600);
  return true;
}

export default function SettingsPage({ section }: SettingsPageProps) {
  const route = useRoute();
  const target = useMemo(() => resolveTarget(section), [section]);
  const active = target.section;
  const loaded = useSettings((s) => s.loaded && !!s.vault);
  const [q, setQ] = useState("");
  const pane = useRef<HTMLDivElement>(null);
  // Only the main outlet's instance answers the route (a side peek of a settings link renders nothing).
  const mine = route.t === "settings";

  useEffect(() => {
    if (!useSettings.getState().vault) void useSettings.getState().load().catch(() => undefined);
  }, []);

  // `#/settings/shortcuts` and friends: shortcuts live in the Ctrl+/ overlay.
  useEffect(() => {
    if (!mine || !target.shortcuts) return;
    closeSettings();
    useUi.getState().setShortcutsOpen(true);
  }, [mine, target.shortcuts]);

  // Deep-link anchor: open More options when the row lives there, wait for it to render, then scroll and flash it.
  useEffect(() => {
    if (!mine || !target.anchor || !loaded) return;
    if (target.more) useSettingsUi.getState().setMore(active, true);
    let tries = 0;
    let timer = 0;
    const tick = () => {
      if (flash(target.anchor as string) || ++tries > 25) {
        // Drop the anchor from the URL once shown (keeps back/forward clean).
        navigate({ t: "settings", section: active }, { replace: true });
        return;
      }
      timer = window.setTimeout(tick, 60);
    };
    timer = window.setTimeout(tick, 80);
    return () => window.clearTimeout(timer);
  }, [mine, target.anchor, target.more, active, loaded]);

  // A new section starts at the top.
  useEffect(() => {
    if (!target.anchor && pane.current) pane.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const results = useMemo(() => {
    const query = q.trim();
    if (!query) return null;
    const title = (id: SectionId) => SECTIONS.find((s) => s.id === id)?.title ?? "";
    return [
      ...SECTIONS.map((s) => ({ key: s.id as string, title: s.title, sub: s.description, r: fuzzyAny(query, s.title, s.keywords) })),
      ...SETTING_ENTRIES.map((e) => ({ key: `${e.section}:${e.id}`, title: e.title, sub: e.more ? `${title(e.section)} · More options` : title(e.section), r: fuzzyAny(query, e.title, e.keywords ?? []) })),
    ]
      .filter((h) => h.r && h.r.match > 0.3)
      .sort((a, b) => (b.r?.match ?? 0) - (a.r?.match ?? 0))
      .slice(0, 12);
  }, [q]);

  if (!mine) return null;

  const go = (to: string) => navigate({ t: "settings", section: to }, { replace: true });
  const pick = (to: string) => {
    go(to);
    setQ("");
  };
  const View = VIEWS[active];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && closeSettings()}
      dismissible={!q}
      size="xl"
      title="Settings"
      hideTitle
      className="st-dialog"
      bodyClassName="st-dialog-body"
    >
      <div className="st-shell" data-section={active}>
        <nav className="st-side" aria-label="Settings sections">
          <div className="st-side-title" aria-hidden>
            Settings
          </div>
          <SettingsSearch q={q} onChange={setQ} onPick={pick} first={results?.[0]?.key} />
          {results ? (
            <SearchResults results={results} q={q} onPick={pick} />
          ) : (
            <>
              <ul className="st-nav">
                {MAIN.map((s) => (
                  <NavItem key={s.id} id={s.id} title={s.title} icon={s.icon} on={s.id === active} onPick={go} />
                ))}
              </ul>
              <ul className="st-nav st-nav-foot">
                {FOOT.map((s) => (
                  <NavItem key={s.id} id={s.id} title={s.title} icon={s.icon} on={s.id === active} onPick={go} />
                ))}
              </ul>
            </>
          )}
        </nav>
        <div ref={pane} className="st-pane" data-region="settings">
          <div className="st-body">{loaded ? <View key={active} /> : <SectionSkeleton />}</div>
        </div>
      </div>
      <ReauthHost />
    </Dialog>
  );
}

function NavItem({ id, title, icon: Icon, on, onPick }: { id: SectionId; title: string; icon: (typeof SECTIONS)[number]["icon"]; on: boolean; onPick: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={cn("st-nav-item", on && "is-active")} aria-current={on ? "page" : undefined} data-section-link={id} onClick={() => onPick(id)}>
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
    </li>
  );
}

interface SearchHit {
  key: string;
  title: string;
  sub: string;
}

function SettingsSearch({ q, onChange, onPick, first }: { q: string; onChange: (q: string) => void; onPick: (key: string) => void; first?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="st-search">
      <Search size={14} aria-hidden />
      <input
        ref={ref}
        value={q}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        data-autofocus=""
        onKeyDown={(e) => {
          if (e.key === "Escape" && q) {
            e.stopPropagation();
            onChange("");
          }
          if (e.key === "Enter" && first) onPick(first);
        }}
      />
      {q ? (
        <button type="button" aria-label="Clear search" onClick={() => (onChange(""), ref.current?.focus())}>
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function SearchResults({ results, q, onPick }: { results: SearchHit[]; q: string; onPick: (key: string) => void }) {
  return (
    <ul className="st-results" aria-label="Matching settings">
      {results.length ? (
        results.map((h) => (
          <li key={h.key}>
            <button type="button" className="st-result" onClick={() => onPick(h.key)}>
              <span className="st-result-title">{h.title}</span>
              <span className="st-result-sub">{h.sub}</span>
            </button>
          </li>
        ))
      ) : (
        <li className="st-noresults">No settings match “{q.trim()}”.</li>
      )}
    </ul>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading settings">
      <Skeleton width={200} height={24} radius={8} />
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} height={112} radius={12} />
      ))}
    </div>
  );
}
