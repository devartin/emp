/**
 * Capture grammar (PROGRAMME-v3 K4 "⌘K hub", Flow r2 §2.7). Prefix-only: plain text without a prefix is never parsed.
 * A prefix can still begin a page title ("Task list", "note to self"); as Flow r2 §2.7 specifies, ⌘K then shows the
 * capture row first and the page second, so the page is one ↓ away and typing without the prefix finds it directly.
 *
 *   t …  / task …        a task (parseNatural: dates, !high/med/low, #tag)  → Life OS Inbox, else a to-do in today's note
 *   n …  / note …        a paragraph appended to today's note
 *   −12.50 coffee        an expense (+250 refund is income); optional trailing date word and #category → Money HQ
 *   spent 12.50 coffee   the same expense, written as a verb (only with a number after "spent")
 *
 * `parseCapture` is pure (table-driven tests in capture.test.ts); `commitCapture` writes through existing commands.
 */
import { parseDate } from "chrono-node";
import { api } from "@/backend";
import type { CellValue, DbSchema, Id, TipTapDoc, TipTapNode } from "@/backend/types";
import { parseMoneyInput } from "@/lib/money";
import { parseNatural, type Priority } from "@/lib/nlp";
import { selectBaseCurrency, useSettings } from "@/stores/settings";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";

export type Capture =
  | { kind: "task"; title: string; due?: Date; hasTime: boolean; priority?: Priority; tags: string[] }
  | { kind: "note"; text: string }
  | { kind: "money"; amount: string; payee: string; date: Date; category?: string }
  | { kind: "error"; target: "task" | "note" | "money"; message: string; text: string };

const TASK = /^(?:t|task)\s+(.*)$/is;
const NOTE = /^(?:n|note)\s+(.*)$/is;
const MONEY = /^([−‒–+-])\s*(.*)$/s;
const SPENT = /^spent\s+(\d[\d.,]*(?:\s.*)?)$/is;

function localNoon(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
}

/** Splits "12.50 coffee yesterday #dining" into an amount, a payee, a date word and a category. */
function parseMoneyRest(sign: 1 | -1, rest: string, ref: Date): Capture {
  const text = rest.trim();
  if (!text) return { kind: "error", target: "money", message: "Type an amount, then who it was paid to", text };
  const m = /^([\d.,]+)(?:\s+(.*))?$/s.exec(text);
  const amount = m ? parseMoneyInput(m[1]) : null;
  if (!m || amount === null || Number(amount) === 0) return { kind: "error", target: "money", message: "Couldn’t read an amount", text };
  let payee = (m[2] ?? "").trim();
  let category: string | undefined;
  payee = payee.replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_all, _s: string, c: string) => {
    category = c;
    return " ";
  });
  let date = localNoon(ref);
  // Only a date word at the end counts ("coffee yesterday"), so a payee like "May's bakery" stays intact.
  const words = payee.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const tail = words.slice(-n).join(" ");
    const d = parseDate(tail, ref, { forwardDate: false });
    if (d) {
      date = localNoon(d);
      words.splice(-n, n);
      break;
    }
  }
  payee = words.join(" ").trim();
  if (!payee) return { kind: "error", target: "money", message: "Add who it was paid to", text };
  const signed = sign < 0 ? `-${amount.replace(/^-/, "")}` : amount.replace(/^-/, "");
  return { kind: "money", amount: signed, payee, date, category };
}

/** The capture a query asks for, or null when it has no capture prefix. */
export function parseCapture(input: string, ref: Date = new Date()): Capture | null {
  const s = input.replace(/^\s+/, "");
  let m = TASK.exec(s);
  if (m) {
    const body = m[1].trim();
    if (!body) return { kind: "error", target: "task", message: "Type the task after t", text: body };
    const r = parseNatural(body, ref);
    const title = r.title.trim();
    if (!title) return { kind: "error", target: "task", message: "Type the task after t", text: body };
    return { kind: "task", title, due: r.start, hasTime: r.hasTime, priority: r.priority, tags: r.tags };
  }
  m = NOTE.exec(s);
  if (m) {
    const text = m[1].trim();
    return text ? { kind: "note", text } : { kind: "error", target: "note", message: "Type the note after n", text };
  }
  m = SPENT.exec(s);
  if (m) return parseMoneyRest(-1, m[1], ref);
  m = MONEY.exec(s);
  if (m) {
    // "-" alone, or "- coffee": a money capture that can't be read (never a page search).
    const sign = m[1] === "+" ? 1 : -1;
    return parseMoneyRest(sign, m[2], ref);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────── commit

export interface Committed {
  /** "Added to Life OS", "Added to today's note", "Added to Money HQ". */
  title: string;
  /** Where the item lives, for the toast ("Fri, Nov 27 · Inbox"). */
  detail?: string;
  /** Opens the created item. */
  view: () => void;
  undo: () => Promise<void>;
}

function dayIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const shortDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function instance(appId: string) {
  return useWorkspace.getState().lifeapps.find((i) => i.appId === appId && !i.detached);
}

/** The schema of the instance database that carries `role`. */
async function dbWithRole(instanceId: Id, role: string): Promise<DbSchema | null> {
  const ids: Id[] = [];
  for (const p of useTree.getState().byId.values()) if (p.kind === "database" && p.appInstanceId === instanceId && !p.deletedAt) ids.push(p.id);
  for (const id of ids) {
    const s = await api.db.getSchema({ id }).catch(() => null);
    if (s && (role in (s.database.roles ?? {}) || s.properties.some((p) => p.role === role))) return s;
  }
  return null;
}

function prop(s: DbSchema, role: string) {
  const id = s.database.roles?.[role];
  return s.properties.find((p) => p.id === id) ?? s.properties.find((p) => p.role === role);
}

function option(s: DbSchema, role: string, name: string): Id | null {
  const opts = (prop(s, role)?.config.options as { id: Id; name: string }[] | undefined) ?? [];
  return opts.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

const text = (v: string): CellValue => ({ t: "text", v: v ? [{ text: v }] : [] });

// ── today's note

function blockId(): string {
  const a = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += a[b & 63];
  return id;
}

function block(content: TipTapNode): TipTapNode {
  return { type: "blockContainer", attrs: { id: blockId(), color: null, bg: null, dir: "auto" }, content: [content] };
}

/** Appends one block to today's note (created if needed). Returns the page id and the new block id. */
export async function appendToTodayNote(node: TipTapNode): Promise<{ pageId: Id; blockId: string }> {
  const meta = await api.daily.noteOpen({ date: dayIso(new Date()) });
  useTree.getState().upsert([meta]);
  const page = await api.page.get({ id: meta.id });
  const doc: TipTapDoc = page.doc ? structuredClone(page.doc) : { type: "doc", attrs: { schemaVersion: 1 }, content: [{ type: "blockGroup", content: [] }] };
  let group = doc.content.find((n) => n.type === "blockGroup");
  if (!group) {
    group = { type: "blockGroup", content: [] };
    doc.content.push(group);
  }
  const b = block(node);
  // An empty trailing paragraph (the template's cursor line) is replaced instead of pushed below.
  const list = (group.content ??= []);
  const last = list[list.length - 1];
  const lastContent = last?.content?.[0];
  if (lastContent && lastContent.type === "paragraph" && !lastContent.content?.length && last.content?.length === 1) list[list.length - 1] = b;
  else list.push(b);
  await api.page.saveDoc({ ownerId: meta.id, ownerKind: "page", doc, baseRev: page.docRev });
  return { pageId: meta.id, blockId: b.attrs!.id as string };
}

async function removeBlock(pageId: Id, id: string): Promise<void> {
  const page = await api.page.get({ id: pageId });
  if (!page.doc) return;
  const doc = structuredClone(page.doc);
  const prune = (n: TipTapNode): void => {
    if (!n.content) return;
    n.content = n.content.filter((c) => !(c.type === "blockContainer" && c.attrs?.id === id));
    n.content.forEach(prune);
  };
  doc.content.forEach(prune);
  await api.page.saveDoc({ ownerId: pageId, ownerKind: "page", doc, baseRev: page.docRev });
}

// ── writers

async function commitTask(c: Extract<Capture, { kind: "task" }>, view: (r: { t: "row"; id: Id } | { t: "page"; id: Id; blockId?: string }) => void): Promise<Committed> {
  const lifeos = instance("life-os");
  const s = lifeos ? await dbWithRole(lifeos.id, "task.status") : null;
  if (!s) {
    // Without Life OS a task is an unchecked to-do in today's note, with its date written out.
    const label = c.due ? `${c.title} (${shortDay(c.due)})` : c.title;
    const at = await appendToTodayNote({ type: "todoItem", attrs: { checked: false }, content: [{ type: "text", text: label }] });
    return { title: "Added to today’s note", detail: c.due ? shortDay(c.due) : undefined, view: () => view({ t: "page", id: at.pageId, blockId: at.blockId }), undo: () => removeBlock(at.pageId, at.blockId) };
  }
  const values: Record<Id, CellValue> = {};
  const title = prop(s, "task.title") ?? s.properties.find((p) => p.id === s.database.primaryPropId);
  if (title) values[title.id] = text(c.title);
  const status = prop(s, "task.status");
  const st = option(s, "task.status", c.due ? "Next" : "Inbox");
  if (status && st) values[status.id] = { t: "status", v: st };
  const due = prop(s, "task.due");
  if (due && c.due) values[due.id] = { t: "date", v: c.hasTime ? { start: c.due.toISOString(), time: true } : { start: dayIso(c.due), time: false } };
  const prio = prop(s, "task.priority");
  const pName = c.priority === "high" ? "P1" : c.priority === "med" ? "P2" : c.priority === "low" ? "P4" : null;
  const pid = pName ? option(s, "task.priority", pName) : null;
  if (prio && pid) values[prio.id] = { t: "select", v: pid };
  const src = prop(s, "task.source");
  const sid = option(s, "task.source", "Quick add");
  if (src && sid) values[src.id] = { t: "select", v: sid };
  const row = await api.db.rowCreate({ databaseId: s.database.id, values });
  return {
    title: c.due ? "Added to Life OS" : "Added to Life OS inbox",
    detail: c.due ? shortDay(c.due) : undefined,
    view: () => view({ t: "row", id: row.id }),
    undo: async () => {
      await api.db.rowsDelete({ ids: [row.id] });
    },
  };
}

async function commitNote(c: Extract<Capture, { kind: "note" }>, view: (r: { t: "page"; id: Id; blockId?: string }) => void): Promise<Committed> {
  const at = await appendToTodayNote({ type: "paragraph", content: [{ type: "text", text: c.text }] });
  return { title: "Added to today’s note", view: () => view({ t: "page", id: at.pageId, blockId: at.blockId }), undo: () => removeBlock(at.pageId, at.blockId) };
}

export interface MoneyTarget {
  instanceId: Id;
  txns: DbSchema;
  accounts: { id: Id; name: string }[];
  categories: { id: Id; name: string }[];
}

/** Money HQ's transactions database plus open accounts and categories, for the capture preview and commit. */
export async function loadMoneyTarget(): Promise<MoneyTarget | null> {
  const money = instance("money-hq");
  if (!money) return null;
  const [txns, accts, cats] = await Promise.all([dbWithRole(money.id, "txn.amount"), dbWithRole(money.id, "acct.type"), dbWithRole(money.id, "cat.group")]);
  if (!txns || !accts) return null;
  const rowsOf = async (s: DbSchema) => {
    const res = await api.db.query({ databaseId: s.database.id, window: { offset: 0, limit: 500 }, reqId: 0 });
    return "notModified" in res ? [] : res.rows;
  };
  const closed = prop(accts, "acct.closed");
  const accounts = (await rowsOf(accts))
    .filter((r) => !(closed && r.values[closed.id]?.t === "check" && r.values[closed.id]?.v === true))
    .map((r) => {
      const v = r.values[accts.database.primaryPropId];
      return { id: r.id, name: v && v.t === "text" ? v.v.map((x) => x.text).join("") || "Account" : "Account" };
    });
  const categories = cats
    ? (await rowsOf(cats)).map((r) => {
        const v = r.values[cats.database.primaryPropId];
        return { id: r.id, name: v && v.t === "text" ? v.v.map((x) => x.text).join("") : "" };
      })
    : [];
  return { instanceId: money.id, txns, accounts, categories };
}

const LAST_ACCOUNT = { ns: "ui.capture", key: "lastAccount" } as const;

/** The account a money capture lands in: the last one used, else the first open account. Never a made-up one. */
export async function captureAccount(t: MoneyTarget): Promise<{ id: Id; name: string } | null> {
  const last = (await api.kv.get(LAST_ACCOUNT).catch(() => null)) as string | null;
  return t.accounts.find((a) => a.id === last) ?? t.accounts[0] ?? null;
}

async function commitMoney(c: Extract<Capture, { kind: "money" }>, accountId: Id | null, view: (r: { t: "row"; id: Id }) => void): Promise<Committed> {
  const t = await loadMoneyTarget();
  if (!t) throw new Error("Set up Money HQ to add expenses");
  const acct = (accountId ? t.accounts.find((a) => a.id === accountId) : null) ?? (await captureAccount(t));
  if (!acct) throw new Error("Add an account in Money HQ first");
  const s = t.txns;
  const r = s.database.roles;
  const cat = c.category ? t.categories.find((x) => x.name.toLowerCase() === c.category!.toLowerCase()) : undefined;
  const values: Record<Id, CellValue> = {
    [s.database.primaryPropId]: text(c.payee),
    [r["txn.date"]]: { t: "date", v: { start: dayIso(c.date), time: false } },
    [r["txn.amount"]]: { t: "money", v: Number(c.amount).toFixed(2), cur: selectBaseCurrency(useSettings.getState()) },
    [r["txn.account"]]: { t: "relation", v: [acct.id] },
  };
  if (cat && r["txn.category"]) values[r["txn.category"]] = { t: "relation", v: [cat.id] };
  if (r["txn.cleared"]) values[r["txn.cleared"]] = { t: "status", v: "uncleared" };
  if (r["txn.source"]) values[r["txn.source"]] = { t: "select", v: "manual" };
  if (r["txn.reviewed"]) values[r["txn.reviewed"]] = { t: "check", v: false };
  const row = await api.db.rowCreate({ databaseId: s.database.id, values });
  void api.kv.set({ ...LAST_ACCOUNT, value: acct.id }).catch(() => undefined);
  return {
    title: "Added to Money HQ",
    detail: acct.name,
    view: () => view({ t: "row", id: row.id }),
    undo: async () => {
      await api.db.rowsDelete({ ids: [row.id] });
    },
  };
}

/** Writes a parsed capture. Throws with a readable message when it can't. */
export async function commitCapture(
  c: Exclude<Capture, { kind: "error" }>,
  opts: { view: (r: { t: "row"; id: Id } | { t: "page"; id: Id; blockId?: string }) => void; accountId?: Id | null },
): Promise<Committed> {
  void api.kv.set({ ns: "ui.gettingStarted", key: "capture", value: Date.now() }).catch(() => undefined);
  if (c.kind === "task") return commitTask(c, opts.view);
  if (c.kind === "note") return commitNote(c, opts.view);
  return commitMoney(c, opts.accountId ?? null, opts.view);
}

/** One-line description of what Enter will do, for the capture row and the Home field. */
export function describeCapture(c: Capture, ctx: { lifeOs: boolean; money: boolean; account?: string | null }): { title: string; meta: string[] } {
  if (c.kind === "error") return { title: c.message, meta: [] };
  if (c.kind === "task") {
    const meta: string[] = [];
    if (c.due) meta.push(c.hasTime ? `${shortDay(c.due)} ${c.due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : shortDay(c.due));
    if (c.priority) meta.push(`!${c.priority}`);
    for (const t of c.tags) meta.push(`#${t}`);
    meta.push(ctx.lifeOs ? "Life OS" : "Today’s note");
    return { title: `Task: ${c.title}`, meta };
  }
  if (c.kind === "note") return { title: `Note: ${c.text}`, meta: ["Today’s note"] };
  const n = Number(c.amount);
  const amt = new Intl.NumberFormat(undefined, { style: "currency", currency: selectBaseCurrency(useSettings.getState()), currencyDisplay: "narrowSymbol" }).format(Math.abs(n));
  const meta = [shortDay(c.date)];
  if (c.category) meta.push(`#${c.category}`);
  meta.push(ctx.money ? (ctx.account ?? "No account") : "Money HQ not set up");
  return { title: `${n < 0 ? "−" : "+"}${amt} ${c.payee}`, meta };
}
