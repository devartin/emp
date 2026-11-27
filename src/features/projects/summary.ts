/** What a project holds, grouped the way the project view lists it (brief §2.2). */
export type ContentGroup = "documents" | "sheets" | "databases" | "apps";

export const CONTENT_GROUPS: { id: ContentGroup; title: string; one: string; many: string }[] = [
  { id: "documents", title: "Documents", one: "document", many: "documents" },
  { id: "sheets", title: "Spreadsheets", one: "spreadsheet", many: "spreadsheets" },
  { id: "databases", title: "Databases", one: "database", many: "databases" },
  { id: "apps", title: "Apps", one: "app", many: "apps" },
];

/** "3 documents · 1 spreadsheet · 1 app" (only what is there; empty when nothing is). */
export function contentsSummary(counts: Partial<Record<ContentGroup, number>>): string {
  return CONTENT_GROUPS.filter((g) => (counts[g.id] ?? 0) > 0)
    .map((g) => `${counts[g.id]} ${counts[g.id] === 1 ? g.one : g.many}`)
    .join(" · ");
}
