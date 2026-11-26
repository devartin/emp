/** General (§11.3 VaultSettings / DeviceSettings): name, start page, region & formats, Trash, celebrations, updates. */
import { PartyPopper, RefreshCw, Settings2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, errorMessage, hasCode } from "@/backend";
import type { VaultSettings } from "@/backend/types";
import { useSettings } from "@/stores/settings";
import { notify } from "@/stores/toasts";
import { useTree } from "@/stores/tree";
import { useWorkspace } from "@/stores/workspace";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { Segmented } from "@/ui/Segmented";
import { Select, type SelectOption } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { celebrate, setCelebrationsEnabled } from "@/ui/motion/Celebrate";
import { Group, Row, SectionHeader } from "../parts";

const LOCALES = ["en-US", "en-GB", "en-CA", "en-AU", "en-IN", "en-IE", "de-DE", "de-CH", "fr-FR", "fr-CA", "es-ES", "es-MX", "it-IT", "nl-NL", "pt-BR", "pt-PT", "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "ja-JP", "ko-KR", "zh-CN"];
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "HKD", "SGD", "INR", "SEK", "NOK", "DKK", "PLN", "CZK", "MXN", "BRL", "ZAR", "KRW", "ILS", "AED", "TRY"];
const TRASH_DAYS = [7, 14, 30, 60, 90, 180, 365];

function displayName(type: "language" | "currency", code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type }).of(code) ?? code;
  } catch {
    return code;
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
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function GeneralSection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const device = useSettings((s) => s.device);
  const setVault = useSettings((s) => s.setVault);
  const setDevice = useSettings((s) => s.setDevice);
  const favorites = useWorkspace((s) => s.workspace?.favorites ?? []);
  const byId = useTree((s) => s.byId);
  const [name, setName] = useState(vault.profileName);
  const [checking, setChecking] = useState(false);
  const partyRef = useRef<HTMLButtonElement>(null);

  const now = new Date();
  const localeOptions = useMemo<SelectOption[]>(
    () =>
      LOCALES.map((l) => ({
        value: l,
        label: displayName("language", l),
        description: `${(1234567.89).toLocaleString(l)} · ${now.toLocaleDateString(l, { day: "numeric", month: "short", year: "numeric" })}`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const currencyOptions = useMemo<SelectOption[]>(() => {
    const list = CURRENCIES.includes(vault.baseCurrency) ? CURRENCIES : [vault.baseCurrency, ...CURRENCIES];
    return list.map((c) => ({ value: c, label: `${c} — ${displayName("currency", c)}` }));
  }, [vault.baseCurrency]);
  const tzOptions = useMemo<SelectOption[]>(() => timeZones(vault.timezone).map((tz) => ({ value: tz, label: `${tz.replace(/_/g, " ")}`, description: tzOffset(tz) })), [vault.timezone]);
  const startOptions = useMemo<SelectOption[]>(() => {
    const opts: SelectOption[] = [
      { value: "home", label: "Home" },
      { value: "last", label: "Where I left off" },
    ];
    for (const id of favorites) {
      const p = byId.get(id);
      if (p && !p.deletedAt) opts.push({ value: id, label: p.title || "Untitled", group: "Favorites" });
    }
    return opts;
  }, [favorites, byId]);

  const y = now.getFullYear();
  const mth = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const dateOptions: SelectOption<VaultSettings["dateFormat"]>[] = [
    { value: "full", label: now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), description: "Written out" },
    { value: "mdy", label: `${mth}/${d}/${y}`, description: "Month / day / year" },
    { value: "dmy", label: `${d}/${mth}/${y}`, description: "Day / month / year" },
    { value: "ymd", label: `${y}-${mth}-${d}`, description: "ISO 8601" },
  ];
  const h = now.getHours();
  const mm = pad(now.getMinutes());

  const commitName = () => {
    const v = name.trim().slice(0, 80);
    if (v !== vault.profileName) void setVault({ profileName: v });
  };

  return (
    <div>
      <SectionHeader icon={Settings2} title="General" description="The basics: how EMP greets you, where it opens and how it formats things." />

      <Group title="You">
        <Row id="profile-name" label="Your name" description="Used in greetings on Home. Stays on this device." htmlFor="st-name">
          <Input id="st-name" size="sm" value={name} onChange={(e) => setName(e.currentTarget.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} placeholder="Your name" maxLength={80} wrapperClassName="w-[220px]" />
        </Row>
        <Row id="start-page" label="Start page" description="What EMP shows after you unlock.">
          <Select size="sm" value={vault.startPage} onValueChange={(v) => void setVault({ startPage: v })} options={startOptions} className="w-[220px]" aria-label="Start page" />
        </Row>
      </Group>

      <Group title="Region & formats" description="Changes apply everywhere instantly, including charts and exports.">
        <Row id="locale" label="Number format" description={`${(1234567.89).toLocaleString(vault.locale)} · ${(-0.042).toLocaleString(vault.locale, { style: "percent", minimumFractionDigits: 1 })}`}>
          <Select size="sm" value={vault.locale} onValueChange={(v) => void setVault({ locale: v })} options={localeOptions.some((o) => o.value === vault.locale) ? localeOptions : [{ value: vault.locale, label: displayName("language", vault.locale) }, ...localeOptions]} searchable className="w-[220px]" aria-label="Number format" />
        </Row>
        <Row id="timezone" label="Time zone" description={`It’s ${now.toLocaleTimeString(undefined, { timeZone: vault.timezone, hour: "numeric", minute: "2-digit" })} there · ${tzOffset(vault.timezone)}`}>
          <Select size="sm" value={vault.timezone} onValueChange={(v) => void setVault({ timezone: v })} options={tzOptions} searchable className="w-[220px]" listWidth={300} aria-label="Time zone" />
        </Row>
        <Row id="currency" label="Base currency" description="Net worth, budgets and the calculator convert into this.">
          <Select size="sm" value={vault.baseCurrency} onValueChange={(v) => void setVault({ baseCurrency: v })} options={currencyOptions} searchable className="w-[220px]" listWidth={280} aria-label="Base currency" />
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
        <Row id="date-format" label="Date format">
          <Select size="sm" value={vault.dateFormat} onValueChange={(v) => void setVault({ dateFormat: v })} options={dateOptions} className="w-[220px]" aria-label="Date format" />
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

      <Group title="Behaviour">
        <Row id="trash-retention" label="Keep items in Trash" description="Pages in Trash are deleted forever after this long.">
          <Select size="sm" value={String(vault.trashRetentionDays)} onValueChange={(v) => void setVault({ trashRetentionDays: Number(v) })} options={(TRASH_DAYS.includes(vault.trashRetentionDays) ? TRASH_DAYS : [...TRASH_DAYS, vault.trashRetentionDays].sort((a, b) => a - b)).map((n) => ({ value: String(n), label: n === 365 ? "1 year" : `${n} days` }))} className="w-[160px]" aria-label="Keep items in Trash" />
        </Row>
        <Row id="celebrations" label="Celebrations" description="A small burst when you finish a checklist or reach a goal. Never shown with reduced motion.">
          <Button
            ref={partyRef}
            size="sm"
            variant="ghost"
            icon={PartyPopper}
            disabled={!vault.celebrations}
            onClick={() => partyRef.current && celebrate(partyRef.current)}
          >
            Preview
          </Button>
          <Switch
            checked={vault.celebrations}
            onCheckedChange={(v) => {
              setCelebrationsEnabled(v);
              void setVault({ celebrations: v });
            }}
            aria-label="Celebrations"
          />
        </Row>
      </Group>

      <Group title="Updates">
        <Row id="updates" label="Check for updates automatically" description="Contacts github.com once a day. Nothing else is sent.">
          {device?.updates === "check" ? (
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              loading={checking}
              onClick={async () => {
                setChecking(true);
                try {
                  const r = await api.app.checkUpdate();
                  if (r.available) notify.info(`EMP ${r.version} is available`, { description: r.notes });
                  else notify.success("You’re up to date");
                } catch (e) {
                  if (hasCode(e, "OFFLINE")) notify.warning("Couldn’t check for updates", { description: errorMessage(e) });
                  else notify.fromError(e, "Couldn’t check for updates");
                } finally {
                  setChecking(false);
                }
              }}
            >
              Check now
            </Button>
          ) : null}
          <Switch checked={device?.updates === "check"} onCheckedChange={(v) => void setDevice({ updates: v ? "check" : "off" })} aria-label="Check for updates automatically" />
        </Row>
      </Group>
    </div>
  );
}
