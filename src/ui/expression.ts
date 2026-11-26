/**
 * Scalar expression evaluation for NumberField/MoneyField `=` inputs (§5.2).
 * App-core should route this to the Rust engine: `setExpressionEvaluator(f => api.sheet.eval({ formula: f }))`.
 * Until then (and in the component gallery) a small safe arithmetic evaluator is used — never `eval`.
 */
export type ExpressionEvaluator = (formula: string) => Promise<{ value: unknown; display?: string; error?: string }>;

let evaluator: ExpressionEvaluator | null = null;

export function setExpressionEvaluator(fn: ExpressionEvaluator | null): void {
  evaluator = fn;
}

export async function evaluateExpression(formula: string): Promise<number | null> {
  const f = formula.trim().startsWith("=") ? formula.trim() : "=" + formula.trim();
  if (evaluator) {
    try {
      const r = await evaluator(f);
      if (r.error) return null;
      const n = typeof r.value === "number" ? r.value : Number(r.value);
      return Number.isFinite(n) ? n : null;
    } catch {
      /* fall through to local */
    }
  }
  return evalArithmetic(f.slice(1));
}

/** + − * / ^ %, parentheses, unary minus, thousands separators. Returns null on any error. */
export function evalArithmetic(src: string): number | null {
  const s = src.replace(/[−]/g, "-").replace(/,/g, "").replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error("num");
    i += m[0].length;
    let v = parseFloat(m[0]);
    if (peek() === "%") {
      i++;
      v /= 100;
    }
    return v;
  };
  const atom = (): number => {
    const c = peek();
    if (c === "(") {
      i++;
      const v = add();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    if (c === "-") {
      i++;
      return -atom();
    }
    if (c === "+") {
      i++;
      return atom();
    }
    return num();
  };
  const pow = (): number => {
    const b = atom();
    if (peek() === "^") {
      i++;
      return Math.pow(b, pow());
    }
    return b;
  };
  const mul = (): number => {
    let v = pow();
    while (peek() === "*" || peek() === "/" || peek() === "×" || peek() === "÷") {
      const op = s[i++];
      const r = pow();
      v = op === "*" || op === "×" ? v * r : v / r;
    }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = mul();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  try {
    const v = add();
    if (i !== s.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}
