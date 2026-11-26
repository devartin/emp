/**
 * Function signature help (§14.3 "the same registry backs autocomplete and the help panel"): the signature with the
 * argument under the caret highlighted, a one-line description and an example.
 */
import type { SheetFunctionInfo } from '@/backend/types';
import { cn } from '@/lib/cn';
import { formulaSpans } from './formula';

export function activeArgIndex(info: SheetFunctionInfo, argIndex: number): number {
  const n = info.args.length;
  if (!n) return -1;
  if (argIndex < n) return argIndex;
  // Repeating groups (e.g. SUMIFS criteria pairs) cycle over their tail.
  const firstRepeat = info.args.findIndex((a) => a.repeat);
  if (firstRepeat < 0) return n - 1;
  const groupStart = Math.max(0, info.args.findIndex((a, i) => i >= firstRepeat - 1 && /\d$/.test(a.name)));
  const group = n - groupStart;
  return groupStart + ((argIndex - groupStart) % Math.max(1, group));
}

export function Signature({ info, argIndex }: { info: SheetFunctionInfo; argIndex: number }) {
  const active = activeArgIndex(info, argIndex);
  const repeat = info.args.some((a) => a.repeat);
  return (
    <span className="emp-fh-sig">
      <span className="emp-fh-name">{info.name}</span>
      <span className="emp-fh-punct">(</span>
      {info.args.map((a, i) => (
        <span key={i}>
          {i > 0 ? <span className="emp-fh-punct">, </span> : null}
          <span className={cn('emp-fh-arg', i === active && 'is-active')}>{a.optional ? `[${a.name}]` : a.name}</span>
        </span>
      ))}
      {repeat ? <span className="emp-fh-punct">, …</span> : null}
      <span className="emp-fh-punct">)</span>
    </span>
  );
}

export interface FunctionHelpProps {
  info: SheetFunctionInfo;
  argIndex: number;
  compact?: boolean;
}

/** The floating help card shown while typing inside a function call. */
export function FunctionHelp({ info, argIndex, compact }: FunctionHelpProps) {
  const active = activeArgIndex(info, argIndex);
  const arg = info.args[active];
  return (
    <div className="emp-fh" role="tooltip" aria-live="polite">
      <div className="emp-fh-head">
        <Signature info={info} argIndex={argIndex} />
        <span className="emp-fh-cat">{info.category}</span>
      </div>
      {!compact ? (
        <>
          <p className="emp-fh-desc">{info.description}</p>
          {arg ? (
            <p className="emp-fh-argline">
              <span className="emp-fh-argname">{arg.name}</span>
              {arg.optional ? <span className="emp-fh-opt">optional</span> : null}
              {arg.repeat ? <span className="emp-fh-opt">repeats</span> : null}
            </p>
          ) : null}
          <code className="emp-fh-example">
            {formulaSpans(info.example).map((s, i) => (
              <span key={i} className={s.cls} data-ref={s.ref}>
                {s.text}
              </span>
            ))}
          </code>
        </>
      ) : null}
    </div>
  );
}

export default FunctionHelp;
