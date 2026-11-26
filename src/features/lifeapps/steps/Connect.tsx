/** connect (§16): Google Calendar or market-data providers, with honest copy about what leaves the device. */
import { CalendarCheck, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/backend";
import type { GoogleAccount } from "@/backend/types";
import { Button } from "@/ui/Button";
import { ChoiceCard } from "@/ui/ChoiceCard";
import { Dialog } from "@/ui/Dialog";
import { GoogleSetupSheet } from "@/features/integrations/GoogleSetupSheet";
import { ProvidersPanel } from "@/features/integrations/ProvidersPanel";
import { iconByName } from "../identity";
import { choiceOf, withChoice, type StepProps } from "./types";

export function Connect({ step, value, onChange }: StepProps) {
  const current = choiceOf(step, value) ?? choiceOf(step, step.default);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [account, setAccount] = useState<GoogleAccount | null>(null);
  useEffect(() => {
    if (current !== "google") return;
    api.google.status().then((s) => setAccount(s.accounts.find((a) => a.status === "ok") ?? null)).catch(() => undefined);
  }, [current, googleOpen]);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2" role="radiogroup" aria-label={step.title}>
        {(step.options ?? []).map((o) => (
          <ChoiceCard key={o.value} className="la-choice la-choice-row" selected={current === o.value} onSelect={() => onChange(withChoice(step, value, o.value))} title={o.label} description={o.description} icon={iconByName(o.icon)} />
        ))}
      </div>
      {current === "google" ? (
        <div className="la-connect">
          {account ? (
            <>
              <CalendarCheck size={16} className="text-gain-text" aria-hidden />
              <span className="flex-1 text-body-sm">Connected as <strong>{account.email}</strong></span>
            </>
          ) : (
            <>
              <span className="flex-1 text-body-sm text-secondary">You’ll create your own Google client — about five minutes, once.</span>
              <Button size="sm" variant="secondary" onClick={() => setGoogleOpen(true)}>Connect Google</Button>
            </>
          )}
        </div>
      ) : null}
      {current === "keys" ? (
        <div className="la-connect">
          <KeyRound size={16} className="text-tertiary" aria-hidden />
          <span className="flex-1 text-body-sm text-secondary">Keys are stored encrypted and only sent to their provider.</span>
          <Button size="sm" variant="secondary" onClick={() => setKeysOpen(true)}>Add keys</Button>
        </div>
      ) : null}
      <p className="flex items-start gap-2 text-caption text-tertiary">
        <ShieldCheck size={14} className="mt-px flex-none" aria-hidden />
        {step.help ?? "Nothing is sent anywhere until you connect."}
      </p>
      <GoogleSetupSheet open={googleOpen} onOpenChange={setGoogleOpen} feature="calendar" />
      <Dialog open={keysOpen} onOpenChange={setKeysOpen} title="Market data providers" description="Keyless providers work out of the box. Keys unlock fresher quotes." size="lg">
        <ProvidersPanel compact />
      </Dialog>
    </div>
  );
}
