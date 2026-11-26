/**
 * The app mark's slab beats stay inside the motion register (DESIGN v3 §7): no overshooting curve anywhere, the
 * vault-unlock beat (`open`) within the C3 budget, every other beat within C1/C2, and the mark static by default.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AppMark, MARK_TIMING, stageTarget, tileTarget, type AppMarkProps } from '@/features/vault/AppMark';
import { CLASSES, REGISTER } from '@/ui/motion/register';

type Stage = NonNullable<AppMarkProps['stage']>;
type Tr = { duration?: number; delay?: number; ease?: unknown; type?: string; [k: string]: unknown };

/** Every per-property transition of a target, flattened (motion allows a default plus per-key overrides). */
function transitions(target: { transition?: unknown } | null): Tr[] {
  if (!target?.transition) return [];
  const t = target.transition as Tr;
  const nested = Object.values(t).filter((v): v is Tr => !!v && typeof v === 'object' && !Array.isArray(v));
  return [t, ...nested];
}

/** Longest beat in seconds (delay + duration) over a target's transitions. */
const longest = (target: { transition?: unknown } | null) => Math.max(0, ...transitions(target).map((t) => (t.delay ?? 0) + (t.duration ?? 0)));

/** A cubic-bezier overshoots when a control point's y leaves [0, 1]. Springs are not allowed at all. */
function overshoots(t: Tr): boolean {
  if (t.type === 'spring') return true;
  const curves = Array.isArray(t.ease) && typeof t.ease[0] !== 'number' ? (t.ease as unknown[]) : [t.ease];
  return curves.some((c) => Array.isArray(c) && c.length === 4 && [c[1], c[3]].some((y: number) => y < 0 || y > 1));
}

const STAGES: Stage[] = ['drop', 'rest', 'press', 'jolt', 'open', 'exploded'];

describe('AppMark motion register', () => {
  test('no beat overshoots or uses a spring', () => {
    const bad: string[] = [];
    for (const s of STAGES) {
      for (let k = 0; k < 3; k++) for (const t of transitions(stageTarget(s, k, 10, 0.5))) if (overshoots(t)) bad.push(`${s}[${k}]`);
      for (const t of transitions(tileTarget(s))) if (overshoots(t)) bad.push(`${s} tile`);
    }
    expect(bad).toEqual([]);
  });

  test('the vault-unlock beat fits the C3 budget; feedback beats fit C1; assembly fits C2', () => {
    const per = (s: Stage) => Math.max(longest(tileTarget(s)), ...[0, 1, 2].map((k) => longest(stageTarget(s, k, 10, 0.5))));
    expect(per('open') * 1000).toBeLessThanOrEqual(REGISTER.vaultUnlock.in);
    expect(per('press') * 1000).toBeLessThanOrEqual(CLASSES.C1.maxIn);
    expect(per('jolt') * 1000).toBeLessThanOrEqual(CLASSES.C1.maxIn);
    expect(per('exploded') * 1000).toBeLessThanOrEqual(CLASSES.C2.maxIn);
    expect(per('drop') * 1000).toBeLessThanOrEqual(CLASSES.C1.maxIn);
    expect((MARK_TIMING.drawIn + 2 * MARK_TIMING.drawStagger) * 1000).toBeLessThanOrEqual(REGISTER.vaultUnlock.in);
  });

  test('static by default: no hidden first frame', () => {
    const html = renderToStaticMarkup(createElement(AppMark, { size: 40 }));
    expect(html).not.toMatch(/opacity:\s*0/);
    const lock = renderToStaticMarkup(createElement(AppMark, { size: 76, stage: 'drop' }));
    expect(lock).not.toMatch(/opacity:\s*0/);
  });
});
