/**
 * Confirmation for `open-external:confirm` (§9.13, §11.4): shows the exact host (and a warning for punycode /
 * look-alike hosts) before a link leaves EMP. Replies with `open_external_confirm`.
 */
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useUi } from "@/stores/ui";
import { Button } from "@/ui/Button";
import { Checkbox } from "@/ui/Checkbox";
import { Dialog } from "@/ui/Dialog";

export function OpenExternalPrompt() {
  const prompt = useUi((s) => s.openExternal[0]);
  const [remember, setRemember] = useState(false);
  useEffect(() => setRemember(false), [prompt?.requestId]);
  if (!prompt) return null;
  const answer = (allow: boolean) => void useUi.getState().answerOpenExternal(prompt.requestId, allow, allow && remember && !prompt.punycode);
  let path = prompt.url;
  try {
    const u = new URL(prompt.url);
    path = `${u.protocol}//${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
  } catch {
    /* show raw */
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && answer(false)}
      size="sm"
      alert
      title="Open this link in your browser?"
      description="Links leave EMP and open in your default browser."
      icon={<ExternalLink size={18} aria-hidden />}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Open link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-subtle bg-surface-2 px-3 py-2 font-mono text-[12.5px] leading-5 break-all text-primary">
          <span className="font-semibold">{prompt.host}</span>
          <span className="block text-tertiary">{path}</span>
        </div>
        {prompt.punycode ? (
          <p className="flex gap-2 text-body-sm" style={{ color: "var(--warning-text)" }}>
            <AlertTriangle size={15} className="mt-0.5 flex-none" aria-hidden />
            This address uses characters that can imitate another site. Check it carefully before opening.
          </p>
        ) : (
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} label={`Always open links to ${prompt.host}`} />
        )}
      </div>
    </Dialog>
  );
}

export default OpenExternalPrompt;
