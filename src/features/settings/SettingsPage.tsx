/**
 * Settings (§6.6, §11.3 Settings): a sticky section rail with search, and the section content. Sections:
 * General · Appearance · Editor · Keyboard shortcuts · Security Center · Privacy & network · Integrations ·
 * Backups & snapshots · Import & export · Advanced · About.
 *
 * Deep links: `{ t:'settings', section:'appearance:accent' }` opens the section and flashes that row.
 */
import { Search, X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { navigate } from "@/app/router";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { useVault } from "@/stores/vault";
import { Skeleton } from "@/ui/Skeleton";
import { spring } from "@/ui/motion/tokens";
import { useReducedMotionPref } from "@/ui/motion/useReducedEffects";
import { fuzzyAny } from "@/features/search/fuzzy";
import { resolveSection, SECTIONS, SETTING_ENTRIES, type SectionId } from "./meta";
import { ReauthHost } from "./reauth";
import { useSecurityScore } from "./security/score";
import { AboutSection } from "./sections/About";
import { AdvancedSection } from "./sections/Advanced";
import { AppearanceSection } from "./sections/Appearance";
import { BackupsSection } from "./sections/Backups";
import { DataSection } from "./sections/Data";
import { EditorSection } from "./sections/Editor";
import { GeneralSection } from "./sections/General";
import { IntegrationsSection } from "./sections/Integrations";
import { PrivacySection } from "./sections/Privacy";
import { ShortcutsSection } from "./sections/Shortcuts";
import { SecurityCenter } from "./security/SecurityCenter";
import "./settings.css";

export interface SettingsPageProps {
  section: string;
}

const VIEWS: Record<SectionId, ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  shortcuts: ShortcutsSection,
  security: SecurityCenter,
  privacy: PrivacySection,
  integrations: IntegrationsSection,
  backups: BackupsSection,
  data: DataSection,
  advanced: AdvancedSection,
  about: AboutSection,
};

const GROUPS = ["Workspace", "Privacy & security", "Data", "EMP"] as const;

function flash(anchor: string) {
  const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(anchor)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: document.documentElement.getAttribute("data-motion") === "reduced" ? "auto" : "smooth" });
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
  window.setTimeout(() => el.classList.remove("is-flash"), 1600);
  return true;
}

export default function SettingsPage({ section }: SettingsPageProps) {
  const [rawSection, anchor] = (section || "general").split(":");
  const active = resolveSection(rawSection);
  const loaded = useSettings((s) => s.loaded && !!s.vault);
  const reduced = useReducedMotionPref();
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const score = useSecurityScore();
  const encrypted = useVault((s) => !!s.status?.encrypted);

  useEffect(() => {
    if (!useSettings.getState().vault) void useSettings.getState().load().catch(() => undefined);
  }, []);

  // Deep-link anchor: wait for the section to render, then scroll + flash.
  useEffect(() => {
    if (!anchor || !loaded) return;
    let tries = 0;
    const tick = () => {
      if (flash(anchor) || ++tries > 20) {
        // Drop the anchor from the URL once shown (keeps breadcrumbs and back/forward clean).
        navigate({ t: "settings", section: active }, { replace: true });
        return;
      }
      window.setTimeout(tick, 60);
    };
    const t = window.setTimeout(tick, 120);
    return () => window.clearTimeout(t);
  }, [anchor, active, loaded]);

  // Scroll to the top when switching sections.
  useEffect(() => {
    if (anchor) return;
    const scroller = document.querySelector<HTMLElement>(".emp-content");
    if (scroller) scroller.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const results = useMemo(() => {
    const query = q.trim();
    if (!query) return null;
    const hits = [
      ...SECTIONS.map((s) => ({ key: s.id, title: s.title, section: s.id, sub: s.description, r: fuzzyAny(query, s.title, s.keywords) })),
      ...SETTING_ENTRIES.map((e) => ({ key: `${e.section}:${e.id}`, title: e.title, section: e.section, sub: SECTIONS.find((s) => s.id === e.section)?.title ?? "", r: fuzzyAny(query, e.title, e.keywords) })),
    ]
      .filter((h) => h.r && h.r.match > 0.3)
      .sort((a, b) => (b.r?.match ?? 0) - (a.r?.match ?? 0))
      .slice(0, 12);
    return hits;
  }, [q]);

  const go = (target: string) => navigate({ t: "settings", section: target }, { replace: true });
  const View = VIEWS[active];
  const meta = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="st-page">
      <aside className="st-rail" aria-label="Settings sections">
        <div className="st-rail-inner">
          <div className="st-rail-title">Settings</div>
          <div className="st-search">
            <Search size={14} aria-hidden />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQ("");
                if (e.key === "Enter" && results?.[0]) {
                  go(results[0].key);
                  setQ("");
                }
              }}
            />
            {q ? (
              <button type="button" aria-label="Clear search" onClick={() => (setQ(""), searchRef.current?.focus())}>
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </div>
          {results ? (
            <div className="st-results" role="list">
              {results.length ? (
                results.map((h) => (
                  <button key={h.key} type="button" role="listitem" className="st-result" onClick={() => (go(h.key), setQ(""))}>
                    <span className="st-result-title">{h.title}</span>
                    <span className="st-result-sub">{h.sub}</span>
                  </button>
                ))
              ) : (
                <p className="st-noresults">No settings match “{q.trim()}”.</p>
              )}
            </div>
          ) : (
            <nav className="st-nav">
              {GROUPS.map((g) => (
                <div key={g} className="st-nav-group">
                  <div className="st-nav-label">{g}</div>
                  {SECTIONS.filter((s) => s.group === g).map((s) => {
                    const Icon = s.icon;
                    const on = s.id === active;
                    return (
                      <button key={s.id} type="button" className={cn("st-nav-item", on && "is-active")} aria-current={on ? "page" : undefined} onClick={() => go(s.id)}>
                        {on ? <m.span layoutId="st-nav-active" className="st-nav-pill" transition={reduced ? { duration: 0 } : spring.ui} /> : null}
                        <Icon size={16} strokeWidth={1.75} aria-hidden />
                        <span className="flex-1 truncate">{s.title}</span>
                        {s.id === "security" && score ? (
                          <span className="st-nav-score" data-tone={score.tone} title={`Security score ${score.score} of 100`}>
                            {encrypted ? score.score : "!"}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
          )}
        </div>
      </aside>
      <main className="st-main" aria-label={meta.title}>
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={active}
            className="st-body"
            initial={{ opacity: 0, y: reduced ? 0 : 6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.2, 0, 0, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.08, ease: [0.4, 0, 1, 1] } }}
          >
            {loaded ? <View /> : <SectionSkeleton />}
          </m.div>
        </AnimatePresence>
      </main>
      <ReauthHost />
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading settings">
      <Skeleton width={220} height={26} radius={8} />
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} height={132} radius={14} />
      ))}
    </div>
  );
}
