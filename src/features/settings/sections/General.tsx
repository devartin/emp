/**
 * General (1.0 brief §2.4): your name, region (one choice that sets number, date and time formats), time zone and
 * first day of the week (detected from the OS, shown as editable), currency and start page. More options: the date
 * format and clock, for people who want them different from their region.
 */
import { useMemo, useState } from "react";
import { api } from "@/backend";
import type { VaultSettings } from "@/backend/types";
import { fixMinus, numberFormat } from "@/lib/format";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Input } from "@/ui/Input";
import { Segmented } from "@/ui/Segmented";
import { Select, type SelectOption } from "@/ui/Select";
import { Group, MoreOptions, Row, SectionHeader } from "../parts";

/** Regions offered in the picker (locale tags); the current value is always added. */
const REGIONS = [
  "en-US", "en-GB", "en-CA", "fr-CA", "en-AU", "en-NZ", "en-IE", "en-IN", "en-SG", "en-ZA", "de-DE", "de-AT", "de-CH",
  "fr-FR", "fr-BE", "fr-CH", "nl-NL", "nl-BE", "es-ES", "es-MX", "it-IT", "pt-PT", "pt-BR", "sv-SE", "da-DK", "nb-NO",
  "fi-FI", "pl-PL", "cs-CZ", "hu-HU", "ro-RO", "el-GR", "tr-TR", "he-IL", "ar-AE", "ja-JP", "ko-KR", "zh-CN", "zh-TW",
  "zh-HK",
];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "HKD", "SGD", "INR", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "MXN", "BRL", "ZAR", "KRW", "TWD", "ILS", "AED", "TRY"];

function displayName(type: "language" | "currency" | "region", code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type }).of(code) ?? code;
  } catch {
    return code;
  }
}

const countryOf = (tag: string) => /-([A-Z]{2})$/.exec(tag)?.[1];

function regionLabel(tag: string, all: string[]): string {
  const country = countryOf(tag);
  if (!country) return displayName("language", tag);
  const name = displayName("region", country);
  // Two languages in one country (Canada, Switzerland, Belgium): name the language too.
  const shared = all.filter((t) => countryOf(t) === country).length > 1;
  return shared ? `${name} (${displayName("language", tag.split("-")[0])})` : name;
}

function sample(tag: string): string {
  const now = new Date();
  try {
    const num = (1234.56).toLocaleString(tag);
    const date = now.toLocaleDateString(tag, { day: "numeric", month: "short", year: "numeric" });
    const time = now.toLocaleTimeString(tag, { hour: "numeric", minute: "2-digit" });
    return `${num} · ${date} · ${time}`;
  } catch {
    return tag;
  }
}

function tzOffset(tz: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value.replace("GMT", "UTC") ?? "";
  } catch {
    return "";
  }
}

function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    list = [];
  }
  if (!list.length) list = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"];
  if (!list.includes("UTC")) list = ["UTC", ...list];
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function GeneralSection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const favorites = useWorkspace((s) => s.workspace?.favorites ?? []);
  const byId = useTree((s) => s.byId);
  const [name, setName] = useState(vault.profileName);

  const regionOptions = useMemo<SelectOption[]>(() => {
    const tags = REGIONS.includes(vault.locale) ? REGIONS : [vault.locale, ...REGIONS];
    return tags
      .map((t) => ({ value: t, label: regionLabel(t, tags), description: sample(t) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [vault.locale]);
  const currencyOptions = useMemo<SelectOption[]>(() => {
    const list = CURRENCIES.includes(vault.baseCurrency) ? CURRENCIES : [vault.baseCurrency, ...CURRENCIES];
    return list.map((c) => ({ value: c, label: `${c} · ${displayName("currency", c)}` }));
  }, [vault.baseCurrency]);
  const tzOptions = useMemo<SelectOption[]>(() => timeZones(vault.timezone).map((tz) => ({ value: tz, label: tz.replace(/_/g, " "), description: tzOffset(tz) })), [vault.timezone]);
  const startOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [
      { value: "home", label: "Home" },
      { value: "last", label: "Where I left off" },
    ];
    for (const id of favorites) {
      const p = byId.get(id);
      if (p && !p.deletedAt) opts.push({ value: id, label: p.title || "Untitled", group: "Favorites" });
    }
    if (!opts.some((o) => o.value === vault.startPage)) opts.push({ value: vault.startPage, label: "A page that is no longer a favorite" });
    return opts;
  }, [favorites, byId, vault.startPage]);

  const now = new Date();
  const dateOptions: SelectOption<VaultSettings["dateFormat"]>[] = [
    { value: "full", label: now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), description: "Written out" },
    { value: "dmy", label: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`, description: "Day / month / year" },
    { value: "mdy", label: `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`, description: "Month / day / year" },
    { value: "ymd", label: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, description: "Year-month-day" },
  ];
  const h = now.getHours();
  const mm = pad(now.getMinutes());

  const commitName = () => {
    const v = name.trim().slice(0, 80);
    if (v !== vault.profileName) void setVault({ profileName: v });
  };

  /** One choice sets number, date and time formats; Rust derives week start, clock and date format for the region. */
  const chooseRegion = async (tag: string) => {
    if (tag === vault.locale) return;
    try {
      const r = await api.settings.detectRegion({ locale: tag });
      await setVault({ locale: r.locale, weekStart: r.weekStart, clock: r.clock, dateFormat: r.dateFormat });
      const cur = useSettings.getState().vault?.baseCurrency;
      if (r.currency && cur && r.currency !== cur) {
        const currency = r.currency;
        notify.info(`Use ${currency} for amounts?`, {
          description: `Your currency is ${cur}. Money, budgets and net worth use it.`,
          action: { label: `Use ${currency}`, onClick: () => void useSettings.getState().setVault({ baseCurrency: currency }) },
        });
      }
    } catch (e) {
      notify.fromError(e, "Couldn’t change the region");
    }
  };

  return (
    <div>
      <SectionHeader title="General" description="How Ultranote greets you, formats things and where it opens." />

      <Group>
        <Row id="profile-name" label="Your name" description="Used in greetings on Home." htmlFor="st-name">
          <Input id="st-name" size="sm" value={name} onChange={(e) => setName(e.currentTarget.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} placeholder="Your name" maxLength={80} wrapperClassName="w-[240px]" />
        </Row>
        <Row id="locale" label="Region" description={`${fixMinus(numberFormat({}, vault.locale).format(1234567.89))} · dates and times as people write them there.`}>
          <Select size="sm" value={vault.locale} onValueChange={(v) => void chooseRegion(v)} options={regionOptions} searchable className="w-[240px]" listWidth={340} aria-label="Region" />
        </Row>
        <Row id="timezone" label="Time zone" description={`It’s ${now.toLocaleTimeString(undefined, { timeZone: vault.timezone, hour: "numeric", minute: "2-digit" })} there · ${tzOffset(vault.timezone)}. “Today” and “this week” in databases and apps use it.`}>
          <Select size="sm" value={vault.timezone} onValueChange={(v) => void setVault({ timezone: v })} options={tzOptions} searchable className="w-[240px]" listWidth={320} aria-label="Time zone" />
        </Row>
        <Row id="week-start" label="First day of the week">
          <Segmented
            size="sm"
            value={String(vault.weekStart) as "0" | "1" | "6"}
            onValueChange={(v) => void setVault({ weekStart: Number(v) as 0 | 1 | 6 })}
            options={[
              { value: "1", label: "Monday" },
              { value: "0", label: "Sunday" },
              { value: "6", label: "Saturday" },
            ]}
            aria-label="First day of the week"
          />
        </Row>
        <Row id="currency" label="Currency" description="Money, budgets and net worth add up in this currency.">
          <Select size="sm" value={vault.baseCurrency} onValueChange={(v) => void setVault({ baseCurrency: v })} options={currencyOptions} searchable className="w-[240px]" listWidth={300} aria-label="Currency" />
        </Row>
        <Row id="start-page" label="Start page" description="What Ultranote shows when it opens.">
          <Select size="sm" value={vault.startPage} onValueChange={(v) => void setVault({ startPage: v })} options={startOptions} className="w-[240px]" aria-label="Start page" />
        </Row>
      </Group>

      <MoreOptions section="general">
        <Group>
          <Row id="date-format" label="Date format" description="Your region sets this. Change it here if you write dates differently.">
            <Select size="sm" value={vault.dateFormat} onValueChange={(v) => void setVault({ dateFormat: v })} options={dateOptions} className="w-[200px]" aria-label="Date format" />
          </Row>
          <Row id="clock" label="Clock">
            <Segmented
              size="sm"
              value={String(vault.clock) as "12" | "24"}
              onValueChange={(v) => void setVault({ clock: Number(v) as 12 | 24 })}
              options={[
                { value: "12", label: `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}` },
                { value: "24", label: `${pad(h)}:${mm}` },
              ]}
              aria-label="Clock"
            />
          </Row>
        </Group>
      </MoreOptions>
    </div>
  );
}
