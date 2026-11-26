/** Privacy & network (§9.18, §9.23, §6.6 Privacy and Network cards). */
import { ClipboardX, EyeOff, Focus, MapPinOff, Radio, ShieldCheck } from "lucide-react";
import type { VaultSettings } from "@/backend/types";
import { NetworkLog, OfflineSwitch } from "@/features/integrations/NetworkLog";
import { shortcutLabel } from "@/lib/platform";
import { usePrivacy } from "@/stores/privacy";
import { useSettings } from "@/stores/settings";
import { Button } from "@/ui/Button";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";
import { Group, Row, SectionHeader } from "../parts";

const CLIP = [10, 20, 30, 60, 120];

export function PrivacySection() {
  const vault = useSettings((s) => s.vault) as VaultSettings;
  const setVault = useSettings((s) => s.setVault);
  const hidden = usePrivacy((s) => s.hidden);
  return (
    <div>
      <SectionHeader icon={EyeOff} title="Privacy & network" description="Keep numbers off-screen, keep secrets off the clipboard, and see every request EMP makes." />

      <Group title="On screen">
        <Row id="hide-numbers" icon={<EyeOff size={16} />} label="Hide numbers on launch" description={`Start every session with balances and amounts masked. Toggle any time with ${shortcutLabel("mod+shift+h")}.`}>
          <Button size="sm" variant="ghost" onClick={() => usePrivacy.getState().toggleHidden()}>
            {hidden ? "Show now" : "Hide now"}
          </Button>
          <Switch checked={vault.hideNumbersOnLaunch} onCheckedChange={(v) => void setVault({ hideNumbersOnLaunch: v })} aria-label="Hide numbers on launch" />
        </Row>
        <Row id="blur-inactive" icon={<Focus size={16} />} label="Blur when inactive" description="Blur EMP when you switch to another app. Money, Portfolio and Taxes always blur.">
          <Switch checked={vault.blurWhenInactive} onCheckedChange={(v) => void setVault({ blurWhenInactive: v })} aria-label="Blur when inactive" />
        </Row>
      </Group>

      <Group title="Clipboard & files">
        <Row id="clipboard" icon={<ClipboardX size={16} />} label="Clear copied secrets after" description="Applies to recovery words, passphrases and revealed secrets — only if the clipboard still holds them.">
          <Select
            size="sm"
            value={String(vault.clipboardClearSeconds)}
            onValueChange={(v) => void setVault({ clipboardClearSeconds: Number(v) })}
            options={(CLIP.includes(vault.clipboardClearSeconds) ? CLIP : [...CLIP, vault.clipboardClearSeconds].sort((a, b) => a - b)).map((n) => ({ value: String(n), label: n >= 60 ? `${n / 60} min` : `${n} seconds` }))}
            className="w-[150px]"
            aria-label="Clear copied secrets after"
          />
        </Row>
        <Row id="image-location" icon={<MapPinOff size={16} />} label="Remove location data from images" description="Strips GPS coordinates from photos when you add them.">
          <Switch checked={vault.stripImageLocation} onCheckedChange={(v) => void setVault({ stripImageLocation: v })} aria-label="Remove location data from images" />
        </Row>
      </Group>

      <Group id="offline" title="Network" description="Nothing connects to the internet unless you turn on an integration.">
        <div className="st-block">
          <OfflineSwitch />
        </div>
        <Row icon={<ShieldCheck size={16} />} label="No telemetry" description="EMP sends no telemetry, ever. No analytics, no crash reports, no usage pings." />
      </Group>

      <Group id="network-log" title="Request log" description="The last 1,000 requests EMP made, newest first. Query strings are never recorded." flush>
        <div className="st-block">
          <NetworkLog limit={1000} height={360} />
        </div>
      </Group>
      <p className="st-hint flex items-center gap-1.5">
        <Radio size={12} aria-hidden /> Every connector may only talk to its own hosts, over HTTPS, with your keys attached only there.
      </p>
    </div>
  );
}
