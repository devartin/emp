/**
 * Rolls a pre-formatted figure ("$1,425,000", "44%", "−3.5", "18") through the kit odometer (docs/DESIGN.md §5.5) by
 * splitting it into prefix · number · suffix and re-formatting with the same grouping and decimals. Anything that
 * isn't a single plain figure (dates, "3 / 7", ranges) renders as text.
 */
import { RollingNumber } from '@/ui/motion/RollingNumber';

const RE = /^([^\d\-−]*?)([\-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([^\d]*)$/;

export function RollText({ text, sensitive, countUpKey }: { text: string; sensitive?: boolean; countUpKey?: string }) {
  const m = RE.exec(text.trim());
  if (!m) return <>{text}</>;
  const [, prefix, sign, int, frac = '', suffix] = m;
  const grouped = int.includes(',');
  const decimals = frac ? frac.length - 1 : 0;
  const minus = sign === '−' ? '−' : '-';
  const n = (sign ? -1 : 1) * Number(int.replace(/,/g, '') + frac);
  if (!Number.isFinite(n)) return <>{text}</>;
  // same prefix / sign / grouping / decimals as the source text (figures like "−$5" don't match RE and stay text)
  const fmt = (v: number) => {
    const abs = Math.abs(v).toLocaleString('en-US', { useGrouping: grouped, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return `${prefix}${v < 0 ? minus : ''}${abs}${suffix}`;
  };
  return <RollingNumber value={n} format={fmt} sensitive={sensitive} countUpKey={countUpKey} countUp={!!countUpKey} />;
}
