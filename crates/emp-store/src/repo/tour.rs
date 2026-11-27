//! The starter tour (SPEC §6.2, Ultranote 1.0 brief §2.6): a "Getting Started" page with a short checklist that
//! ticks itself as the user tries each thing, plus four short guide pages under it. Created once per vault, in the
//! first workspace (not pinned: it lists under Documents like any page).
//!
//! **Only items that can be done, and one list.** Every item works in a new workspace with no apps; "Lock" is
//! listed only when the workspace is encrypted. Home's checklist shows exactly these items (its labels are the bold
//! part of each line here), so there is one Getting Started checklist, not two. App-specific actions
//! (`add_transaction`, `templates`, `import`) are still recorded but listed nowhere.
//!
//! **Ticks.** The store ticks what it can see itself: `create_page` (any page created after the tour),
//! `templates` (`template_apply`), `add_transaction` (a row created in a database with a `txn.amount` role),
//! `lock` (just before the keys are dropped), `try_slash` (the editor's slash menu records its recent items under
//! `ui.editor/slashRecent`) and every key the UI reports through `kv_set('ui.gettingStarted', item, …)`
//! (`open_palette`, `capture`, …). The app can also call [`Store::getting_started_tick`] directly.
//! Every tracked tick is also written to `ui.gettingStarted/<item>`, the list Home's checklist reads. A tick checks
//! the item's to-do block in the page document (a normal doc save, so it shows in history and other views get
//! `page:changed`); ticking twice, or after the user deleted the page or the block, does nothing. A to-do the
//! person ticks by hand on the page counts on Home too: the page and its item → block map are published at
//! `ui.gettingStarted/tour` ([`UI_TOUR_KEY`]) so Home can read the page's to-dos.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::doc::walk::find_block;
use crate::import::markdown::{self, MdOptions, Resolve};
use crate::model::{DocOwnerKind, Icon, PageCreate, PageKind, TipTapDoc};
use crate::{Result, Store, StoreError};

/// Internal kv namespace of the tour state.
const NS: &str = "emp.tour";
/// Key of the Getting Started state.
const KEY: &str = "gettingStarted";
/// The `ui.*` namespace the frontend reports UI-only checklist actions to (`src/stores/checklist.ts`).
pub const UI_NAMESPACE: &str = "ui.gettingStarted";
/// Lowercase spelling of [`UI_NAMESPACE`] (the IPC layer's namespace check only admits lowercase names).
pub const UI_NAMESPACE_LOWER: &str = "ui.getting_started";
/// Key under [`UI_NAMESPACE`] holding `{ pageId, items: { <item>: <to-do block id> } }` for Home's checklist.
pub const UI_TOUR_KEY: &str = "tour";

/// Checklist items in page order. Home's checklist (`src/features/home/firstRun.tsx`) and the browser mock
/// (`src/backend/mock/seed/core.ts`) list the same keys in the same order.
pub const ITEMS: [(&str, &str); 4] = [
    (
        "create_page",
        "**Write a document**: press `⌘N`, or choose New document on Home.",
    ),
    (
        "try_slash",
        "**Add a heading, list or table**: type `/` on an empty line.",
    ),
    (
        "capture",
        "**Add a task or a note**: type it in the field on Home and press Enter.",
    ),
    (
        "open_palette",
        "**Find anything**: press `⌘K` to open a page or run any command.",
    ),
];

/// The extra item an encrypted workspace lists last.
pub const LOCK_ITEM: (&str, &str) = (
    "lock",
    "**Lock Ultranote**: press `⌘⇧L` when you step away.",
);

/// Every item the store records (the page's items, the lock item, and app actions no list shows).
pub const TRACKED: [&str; 9] = [
    "create_page",
    "try_slash",
    "open_palette",
    "hide_numbers",
    "lock",
    "add_transaction",
    "templates",
    "capture",
    "import",
];

/// Stored tour state.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TourState {
    /// The Getting Started page.
    pub page_id: String,
    /// Checklist item key → to-do block id.
    pub items: BTreeMap<String, String>,
    /// Items already ticked.
    #[serde(default)]
    pub done: Vec<String>,
}

/// Result of [`Store::starter_tour_create`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterTour {
    /// The Getting Started page.
    pub page_id: String,
    /// Every page of the tour (Getting Started first).
    pub pages: Vec<String>,
}

const GUIDES: [(&str, &str, &str); 4] = [
    ("Writing in Ultranote", "pen-line", WRITING),
    ("Keyboard shortcuts", "keyboard", SHORTCUTS),
    ("Privacy & encryption", "lock", PRIVACY),
    ("Apps in Ultranote", "compass", MONEY),
];

const INTRO: &str = "Ultranote keeps your notes, spreadsheets, tasks and money in **one private place on this computer**. \
This page is a short tour: the checklist below ticks itself as you try each thing.

> [!note]
> **Your workspace lives on your computer.** Ultranote has no servers and no accounts, and your data never leaves this device. \
Nothing connects to the internet unless you turn on a connection.

## Your first ten minutes
";

const OUTRO: &str = "
## Find your way around

- **Write:** documents with headings, toggles, tables, maths, code and columns. See [[Writing in Ultranote]].
- **Move fast:** press `⌘K` anywhere to jump to pages, run commands, even do quick maths with `=`. See [[Keyboard shortcuts]].
- **Stay private:** an optional password that encrypts everything, plus a recovery key you keep safe. See [[Privacy & encryption]].
- **Add an app:** Tasks, Habits, Money, Investments, Taxes and Spreadsheet Studio build real pages and spreadsheets for you. See [[Apps in Ultranote]].

---

*Everything here is a normal page. Edit it, move it, or send it to Trash when you're done.*
";

const WRITING: &str = "Everything in a page is a **block**. Type `/` to add one, drag the `⋮⋮` handle to move it, or \
press `Esc` to select it.

## Text that says more

**Bold**, *italic*, ~~strikethrough~~, `inline code` and [links](https://example.com). Mention a page with `@`, \
or link one with `[[`, like [[Keyboard shortcuts]].

## Lists

- Bulleted lists nest with Tab
  - Shift+Tab brings them back
1. Numbered lists count themselves
2. Type `1.` and a space to start one

- [x] To-dos tick with `⌘↵`
- [ ] …or with a click

## Callouts, quotes and code

> [!tip]
> Callouts draw the eye. Change the icon and colour from the block menu.

> Simple can be harder than complex.

```ts
// Every page autosaves 400 ms after you stop typing.
export const AUTOSAVE_MS = 400;
```

$$
FV = PV \\times \\left(1 + \\frac{r}{n}\\right)^{n t}
$$

## Tables

| Block | Shortcut | Good for |
| --- | --- | --- |
| Heading | `#` `##` `###` | Structure |
| To-do | `[]` | Checklists |
| Toggle | `>` | Hiding detail |
| Code | three backticks | Snippets |

## Live blocks

Databases, charts, KPIs, spreadsheet ranges and market watchlists can live inside any page: type `/database`, \
`/chart`, `/kpi`, `/sheet` or `/watchlist`.
";

const SHORTCUTS: &str = "Press `?` anywhere outside a text field for the cheat sheet.

## Everywhere

| Keys | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘P` | Quick find pages |
| `⌘⇧P` | Run a command |
| `⌘N` | New page |
| `⌘[` / `⌘]` | Back / forward |
| `⌘⇧U` | Go to parent page |
| `⌘\\` | Toggle sidebar |
| `⌘⌥D` | Today’s daily note |
| `⌘⇧H` | Hide numbers |
| `⌘⇧L` | Lock now |
| `⌘⇧D` | Light / dark theme |
| `⌘⇧O` | Offline mode |
| `⌘,` | Settings |
| `⌘L` | Copy link to page |

## Formatting

| Keys | Action |
| --- | --- |
| `⌘B` `⌘I` `⌘U` | Bold, italic, underline |
| `⌘⇧S` | Strikethrough |
| `⌘E` | Inline code |
| `⌘⇧E` | Inline equation |
| `⌘K` with text selected | Add a link |
| `⌘⌥H` | Apply the last colour |
| `⌘⇧V` | Paste as plain text |

## Blocks

| Keys | Action |
| --- | --- |
| `Esc` | Select the current block |
| `⇧↑` `⇧↓` | Extend the block selection |
| `⌘D` | Duplicate |
| `⌘⇧↑` `⌘⇧↓` | Move the block with its children |
| `Tab` `⇧Tab` | Indent / outdent |
| `⌘↵` | Tick a to-do, open a toggle, follow a link |
| `⌘⌥T` | Expand or collapse all toggles |
| `⌘⌥0–9` | Turn into another block type |

> [!tip]
> Markdown works as you type: `#` headings, `-` bullets, `[]` to-dos, `---` dividers.
";

const PRIVACY: &str = "> [!warning]
> Your password never leaves this device, and nobody can reset it. Your recovery key is the only other way in, so \
keep it safe.

## How it works

1. Your password unlocks a random key that only exists on this device.
2. That key encrypts every page, row and file before it is written to disk.
3. When encryption is on, Ultranote locks itself after the idle time you choose in Settings, when your computer \
sleeps, or when you press `⌘⇧L`.
4. Ultranote notices if encrypted items are changed outside the app.

The technical details (the ciphers and how the password is stretched) are in **Settings → Privacy & security**.

## What encryption protects

| Protected | Still visible on disk |
| --- | --- |
| Titles, text and documents | That a workspace exists, and the day it was made |
| Property names and values, views | How many pages, rows and files there are |
| File names, types and contents | The shape of the page tree |
| Tokens, keys and the search index | Approximate (padded) sizes |

Turn on full-disk encryption (FileVault, BitLocker or LUKS) to cover the rest. Read more in **Settings → Privacy & security**.

## Questions

- **What if I forget my password?** Choose \"Use recovery key\" on the lock screen and enter your 24 words. You'll \
set a new password straight away.
- **Does Ultranote connect to the internet?** Only for connections you turn on: market data, Google, update checks. \
Every request is listed in Settings, and Offline mode (`⌘⇧O`) blocks them all.
- **No password yet?** You can add one any time in **Settings → Privacy & security**.
";

const MONEY: &str = "Apps are guided set-ups that build real pages, databases and dashboards for you, then get \
out of the way. Add one from **Apps** in the sidebar.

## The apps

- **Tasks:** to-dos, lists and a weekly plan.
- **Habits:** streaks and gentle check-ins.
- **Money:** budget, spending, bills and net worth.
- **Investments:** holdings, performance, allocation and rebalancing.
- **Taxes:** documents, deductions and quarterly estimates.
- **Spreadsheet Studio:** calculators and models with real formulas.

## How the advice works

- Every number shows its working: click a figure to see where it came from.
- Suggestions name their source and never sell anything. Nothing is ever bought, filed or paid for you.

> [!note]
> Estimates for planning. Check important decisions with official sources or a qualified professional.
";

/// Resolves `[[Title]]` links between the tour pages.
struct TitleLinks<'a>(&'a BTreeMap<String, String>);

impl Resolve for TitleLinks<'_> {
    fn page(&mut self, target: &str) -> Option<String> {
        self.0.get(target).cloned()
    }
}

/// Shortcut labels for the platform the tour is created on (mirrors the mock's `spellKeys`): macOS keeps the
/// `⌘ ⌥ ⇧` glyphs; Windows and Linux get `Ctrl+Shift+L` spelling (and `↵` after a modifier becomes `Enter`).
pub(crate) fn platform_keys(md: &str, mac: bool) -> String {
    if mac {
        return md.to_owned();
    }
    md.replace('⌘', "Ctrl+")
        .replace('⌥', "Alt+")
        .replace('⇧', "Shift+")
        .replace("+↵", "+Enter")
}

fn render(md: &str, links: &BTreeMap<String, String>) -> Result<TipTapDoc> {
    let md = platform_keys(md, cfg!(target_os = "macos"));
    let r = markdown::convert(
        &md,
        MdOptions {
            front_matter_callout: false,
            drop_first_h1: false,
            tags_line: false,
        },
        &mut TitleLinks(links),
    )?;
    Ok(r.doc)
}

/// A Lucide page icon (the tour carries no emoji).
fn lucide(v: &str) -> Icon {
    Icon::Lucide {
        v: v.to_owned(),
        color: None,
    }
}

/// Sets `checked` on the to-do block `block_id`. Returns whether the document changed.
fn check_todo(doc: &mut TipTapDoc, block_id: &str) -> bool {
    let Some(container) = find_block(doc, block_id).cloned() else {
        return false;
    };
    let mut container = container;
    let Some(content) = container.content.as_mut().and_then(|c| c.first_mut()) else {
        return false;
    };
    if content.kind != "todoItem" || content.attr("checked") == Some(&Value::Bool(true)) {
        return false;
    }
    content
        .attrs
        .get_or_insert_with(Default::default)
        .insert("checked".into(), Value::Bool(true));
    crate::doc::walk::replace_block(doc, block_id, container)
}

impl Store {
    /// Creates the starter tour in `workspace_id` (SPEC §6.2): "Getting Started" with its checklist (the lock item
    /// only in an encrypted workspace) and four guide pages under it. Runs once per vault: a second call returns
    /// the existing tour.
    pub fn starter_tour_create(&self, workspace_id: &str) -> Result<StarterTour> {
        let s = self.session()?;
        if let Some(st) =
            crate::repo::kv::get_internal::<TourState>(self, &s, NS, KEY)?.filter(|st| {
                self.page_get(&st.page_id)
                    .is_ok_and(|p| p.meta.deleted_at.is_none())
            })
        {
            let mut pages = vec![st.page_id.clone()];
            pages.extend(
                self.page_children(workspace_id, Some(&st.page_id))?
                    .into_iter()
                    .map(|p| p.id),
            );
            return Ok(StarterTour {
                page_id: st.page_id,
                pages,
            });
        }
        let gs = self
            .page_create({
                let mut r = PageCreate::new(workspace_id, None, PageKind::Doc, "Getting Started");
                r.icon = Some(lucide("hand"));
                r
            })?
            .meta;
        let mut links = BTreeMap::new();
        let mut guide_ids = Vec::new();
        for (title, icon, _) in GUIDES {
            let mut r = PageCreate::new(workspace_id, Some(&gs.id), PageKind::Doc, title);
            r.icon = Some(lucide(icon));
            let p = self.page_create(r)?.meta;
            links.insert(title.to_owned(), p.id.clone());
            guide_ids.push(p.id);
        }
        for ((_, _, md), id) in GUIDES.iter().zip(&guide_ids) {
            let doc = render(md, &links)?;
            self.page_save_doc(id, DocOwnerKind::Page, doc, 0)?;
        }
        // Only items this workspace can do: "Lock" needs a password.
        let mut items: Vec<(&str, &str)> = ITEMS.to_vec();
        if self.is_encrypted()? {
            items.push(LOCK_ITEM);
        }
        let mut md = String::from(INTRO);
        for (_, label) in &items {
            md.push_str("- [ ] ");
            md.push_str(label);
            md.push('\n');
        }
        md.push_str(OUTRO);
        let doc = render(&md, &links)?;
        // The checklist's to-dos, in order, are the first to-do blocks of the page.
        let mut todo_ids = Vec::new();
        crate::doc::walk::for_each_block(&doc, &mut |b| {
            if b.content.kind == "todoItem" {
                todo_ids.push(b.id.to_owned());
            }
        });
        if todo_ids.len() < items.len() {
            return Err(StoreError::Internal(
                "the Getting Started checklist did not render".into(),
            ));
        }
        self.page_save_doc(&gs.id, DocOwnerKind::Page, doc, 0)?;
        // Not pinned to Favorites (it would list twice in the sidebar); it is the first recent page instead.
        self.workspace_touch_recent(workspace_id, &gs.id)?;
        // State last: pages created above must not tick `create_page`.
        let state = TourState {
            page_id: gs.id.clone(),
            items: items
                .iter()
                .zip(todo_ids)
                .map(|((k, _), id)| ((*k).to_owned(), id))
                .collect(),
            done: Vec::new(),
        };
        crate::repo::kv::put_internal(self, &s, NS, KEY, &state)?;
        // Home reads the page's to-dos through this, so an item ticked by hand on the page counts there too.
        self.kv_set_any(
            UI_NAMESPACE,
            UI_TOUR_KEY,
            json!({ "pageId": gs.id, "items": state.items }),
            None,
        )?;
        let mut pages = vec![gs.id];
        pages.extend(guide_ids);
        Ok(StarterTour {
            page_id: pages[0].clone(),
            pages,
        })
    }

    /// The tour state (`None` when this vault has no tour).
    pub fn getting_started_state(&self) -> Result<Option<TourState>> {
        let s = self.session()?;
        crate::repo::kv::get_internal(self, &s, NS, KEY)
    }

    /// Ticks a Getting Started checklist item (one of [`TRACKED`]). Records it for Home's checklist
    /// (`ui.gettingStarted/<item>`) and checks its to-do on the page when the page lists it. Returns whether the
    /// page changed. Unknown items, items already ticked and a deleted page or block leave the page alone.
    pub fn getting_started_tick(&self, item: &str) -> Result<bool> {
        let s = self.session()?;
        let Some(mut st) = crate::repo::kv::get_internal::<TourState>(self, &s, NS, KEY)? else {
            return Ok(false);
        };
        if !TRACKED.contains(&item) || st.done.iter().any(|d| d == item) {
            return Ok(false);
        }
        st.done.push(item.to_owned());
        crate::repo::kv::put_internal(self, &s, NS, KEY, &st)?;
        // Home's checklist reads the UI namespace (it cannot see the internal tour state).
        self.kv_set_any(UI_NAMESPACE, item, json!(self.now()), None)?;
        let Some(block) = st.items.get(item).cloned() else {
            return Ok(false);
        };
        let Ok(page) = self.page_get(&st.page_id) else {
            return Ok(false);
        };
        if page.meta.deleted_at.is_some() {
            return Ok(false);
        }
        let Some(mut doc) = page.doc else {
            return Ok(false);
        };
        if !check_todo(&mut doc, &block) {
            return Ok(false);
        }
        match self.page_save_doc(&st.page_id, DocOwnerKind::Page, doc, page.doc_rev) {
            Ok(_) => Ok(true),
            // The user is editing the page right now; their save wins and the item stays done in the state.
            Err(StoreError::Conflict { .. }) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Best-effort tick from a store hook: never fails the operation that triggered it.
    pub(crate) fn tour_tick_quiet(&self, item: &str) {
        let _ = self.getting_started_tick(item);
    }
}

/// The checklist item a `kv_set` reports, if any: a key under `ui.gettingStarted`, or the editor's slash menu
/// recording a block it inserted (`ui.editor/slashRecent`), which is "Add any block with /".
pub(crate) fn ui_item<'a>(ns: &str, key: &'a str, value: &Value) -> Option<&'a str> {
    if value.is_null() || value == &json!(false) {
        return None;
    }
    if ns == "ui.editor" && key == "slashRecent" {
        return Some("try_slash");
    }
    (ns == UI_NAMESPACE || ns == UI_NAMESPACE_LOWER).then_some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_labels_follow_the_platform() {
        assert_eq!(platform_keys("Lock with `⌘⇧L`", true), "Lock with `⌘⇧L`");
        assert_eq!(
            platform_keys("Lock with `⌘⇧L`, tick with `⌘↵`, daily note `⌘⌥D`", false),
            "Lock with `Ctrl+Shift+L`, tick with `Ctrl+Enter`, daily note `Ctrl+Alt+D`"
        );
    }

    #[test]
    fn shortcut_tables_set_every_key_as_a_code_chip() {
        // The Getting Started style (and the mock seed's `keys()` helper): each chord is its own code chip.
        let rows = SHORTCUTS
            .lines()
            .filter(|l| l.starts_with("| ") && !l.starts_with("| Keys") && !l.starts_with("| ---"));
        let mut n = 0;
        for row in rows {
            n += 1;
            let keys = row
                .trim_start_matches("| ")
                .split(" | ")
                .next()
                .unwrap_or_default();
            assert!(keys.starts_with('`'), "plain-text keys in {row:?}");
        }
        assert_eq!(
            n, 29,
            "the shortcut tables changed; keep the mock seed (seed/core.ts) in step"
        );
    }

    #[test]
    fn tour_copy_has_no_em_dashes_or_we_voice() {
        let all = [INTRO, OUTRO, WRITING, SHORTCUTS, PRIVACY, MONEY]
            .into_iter()
            .chain(ITEMS.iter().map(|(_, l)| *l))
            .chain([LOCK_ITEM.1])
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!all.contains('—'), "em dash in the tour copy");
        assert!(!all.contains(" we "), "we-voice in the tour copy");
        // 1.0 brief §1: plain words only; cipher names live in Settings' details.
        for banned in [
            "life app",
            "Life OS",
            "Money HQ",
            "Tax Organizer",
            "Portfolio",
            "XChaCha20",
            "Argon2",
            "vault",
            "Security Center",
        ] {
            assert!(!all.contains(banned), "{banned:?} in the tour copy");
        }
    }

    #[test]
    fn every_listed_item_is_tracked_and_the_slash_menu_ticks_try_slash() {
        for (k, _) in ITEMS.iter().chain([&LOCK_ITEM]) {
            assert!(TRACKED.contains(k), "{k}");
        }
        assert_eq!(
            ui_item("ui.editor", "slashRecent", &json!(["heading"])),
            Some("try_slash")
        );
        assert_eq!(ui_item("ui.editor", "other", &json!(1)), None);
        assert_eq!(
            ui_item(UI_NAMESPACE, "open_palette", &json!(1)),
            Some("open_palette")
        );
        assert_eq!(ui_item(UI_NAMESPACE, "open_palette", &json!(false)), None);
    }
}
