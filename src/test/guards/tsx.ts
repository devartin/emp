/**
 * One TypeScript AST pass per source file that collects every fact the style, copy and emoji guards need: string
 * literals (with the context that makes them UI copy or class names), style-ish object properties, imports and a few
 * call shapes. Uses `typescript`'s parser only (no type checking), ~1 s for the whole of src/.
 */
import ts from 'typescript';

export type StringKind =
  /** JSX text between tags. */
  | 'jsxText'
  /** A string expression rendered as a JSX child (`{cond ? "A" : "B"}`). */
  | 'jsxChild'
  /** A JSX attribute value (`label="…"`). */
  | 'attr'
  /** An object-literal property value (`{ label: "…" }`). */
  | 'prop'
  /** First argument of toast()/toast.x()/notify(). */
  | 'toast'
  | 'other';

export interface TsString {
  text: string;
  kind: StringKind;
  /** Attribute or property name for 'attr' / 'prop'. */
  key?: string;
  /** Tag name of the closest enclosing JSX element ('Button', 'Menu.Item', 'button'). */
  tag?: string;
  /**
   * The closest enclosing element that is not an inline text wrapper (span, strong, em…): for
   * `<Button><span>Save</span></Button>` this is 'Button' while `tag` is 'span'.
   */
  labelTag?: string;
  /** Inside className=… or a cn()/clsx()/cva() call: Tailwind classes, not copy. */
  inClass: boolean;
  line: number;
}

export interface TsStyleProp {
  name: string;
  /** Literal value as text ('650', 'uppercase'), or null when it is an expression. */
  literal: string | null;
  isNumber: boolean;
  line: number;
}

export interface TsFacts {
  strings: TsString[];
  styleProps: TsStyleProp[];
  imports: { from: string; names: string[]; line: number }[];
  inlineStyleAttrs: number[];
  repeatInfinity: number[];
  toFixedCalls: number[];
  /** Numeric literal values of JSX `radius={n}` attributes. */
  radiusAttrs: { value: number; line: number }[];
}

const CLASS_CALLS = new Set(['cn', 'clsx', 'cva', 'twMerge', 'classNames', 'cx']);
/** Variables / properties whose names say they hold class strings (`const cls = "…"`, `{ className: "…" }`). */
const CLASS_IDENT = /^(?:cls|class|classes|className|classNames)$|(?:Cls|ClassNames?|Classes|_cls|_class)$/;
/** Inline text wrappers: a label inside one still belongs to the enclosing button / item. */
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'small', 'kbd', 'mark', 'bdi', 'Fragment', 'React.Fragment']);
const TOAST_CALLS = new Set(['toast', 'notify', 'showToast', 'pushToast']);
const STYLE_PROP_NAMES = new Set([
  'fontWeight',
  'font',
  'borderRadius',
  'boxShadow',
  'backdropFilter',
  'WebkitBackdropFilter',
  'textTransform',
  'transition',
  'transitionProperty',
  'background',
  'backgroundImage',
]);

function tagName(n: ts.JsxTagNameExpression): string {
  return n.getText();
}

function propName(n: ts.PropertyName | ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isJsxNamespacedName(n)) return `${n.namespace.text}:${n.name.text}`;
  return undefined;
}

function templateText(n: ts.TemplateExpression): string {
  return n.head.text + n.templateSpans.map((s) => '{}' + s.literal.text).join('');
}

export function collectTs(file: string, source: string): TsFacts {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: TsFacts = { strings: [], styleProps: [], imports: [], inlineStyleAttrs: [], repeatInfinity: [], toFixedCalls: [], radiusAttrs: [] };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  interface Ctx {
    kind: StringKind;
    key?: string;
    tag?: string;
    labelTag?: string;
    inClass: boolean;
  }

  const pushString = (text: string, n: ts.Node, ctx: Ctx) => {
    facts.strings.push({ text, kind: ctx.kind, key: ctx.key, tag: ctx.tag, labelTag: ctx.labelTag ?? ctx.tag, inClass: ctx.inClass, line: lineOf(n) });
  };
  /** Class context for `const cls = …` / `{ className: … }` unless the value is a function or a (non-class) call. */
  const holdsClasses = (name: string | undefined, init: ts.Expression) => {
    if (!name || !CLASS_IDENT.test(name)) return false;
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    return !(ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isCallExpression(e) || ts.isIdentifier(e) || ts.isPropertyAccessExpression(e));
  };
  const childLabelTag = (tag: string, ctx: Ctx) => (INLINE_TAGS.has(tag) && ctx.labelTag ? ctx.labelTag : tag);

  /** Contexts that pass "this expression's string value is shown" through to their branches. */
  const passesValue = (n: ts.Node) =>
    ts.isConditionalExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    (ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.PlusToken));

  const visit = (n: ts.Node, ctx: Ctx) => {
    // ── strings
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // Import specifiers and property *names* are not copy.
      const p = n.parent;
      const isName = (ts.isPropertyAssignment(p) && p.name === n) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p);
      if (!isName || ctx.inClass) pushString(n.text, n, isName ? { ...ctx, kind: 'other' } : ctx);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      pushString(templateText(n), n, ctx);
      for (const s of n.templateSpans) visit(s.expression, { ...ctx, kind: 'other' });
      return;
    }
    if (ts.isJsxText(n)) {
      const text = n.text.replace(/\s+/g, ' ').trim();
      if (text) pushString(text, n, { kind: 'jsxText', tag: ctx.tag, labelTag: ctx.labelTag, inClass: false });
      return;
    }

    // ── JSX structure
    if (ts.isJsxElement(n)) {
      const tag = tagName(n.openingElement.tagName);
      visit(n.openingElement, { ...ctx, kind: 'other', tag });
      const labelTag = childLabelTag(tag, ctx);
      for (const c of n.children) visit(c, { kind: 'jsxChild', tag, labelTag, inClass: false });
      return;
    }
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const tag = tagName(n.tagName);
      for (const a of n.attributes.properties) visit(a, { kind: 'other', tag, inClass: false });
      return;
    }
    if (ts.isJsxFragment(n)) {
      for (const c of n.children) visit(c, { kind: 'jsxChild', tag: ctx.tag, labelTag: ctx.labelTag, inClass: false });
      return;
    }
    if (ts.isJsxExpression(n)) {
      if (n.expression) visit(n.expression, ctx.kind === 'jsxChild' || ctx.kind === 'attr' ? ctx : { ...ctx, kind: 'other' });
      return;
    }
    if (ts.isJsxAttribute(n)) {
      const name = propName(n.name) ?? '';
      if (name === 'style' && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isObjectLiteralExpression(n.initializer.expression)) {
        facts.inlineStyleAttrs.push(lineOf(n));
      }
      if (name === 'radius' && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isNumericLiteral(n.initializer.expression)) {
        facts.radiusAttrs.push({ value: Number(n.initializer.expression.text), line: lineOf(n) });
      }
      if (n.initializer) {
        const inClass = name === 'className' || name === 'class';
        visit(n.initializer, { kind: inClass ? 'other' : 'attr', key: name, tag: ctx.tag, inClass });
      }
      return;
    }

    // ── object literal properties
    if (ts.isPropertyAssignment(n)) {
      const name = propName(n.name);
      if (name && STYLE_PROP_NAMES.has(name)) {
        const init = n.initializer;
        const lit = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : ts.isNumericLiteral(init) ? init.text : null;
        facts.styleProps.push({ name, literal: lit, isNumber: ts.isNumericLiteral(init), line: lineOf(n) });
      }
      if (name === 'repeat' && ts.isIdentifier(n.initializer) && n.initializer.text === 'Infinity') facts.repeatInfinity.push(lineOf(n));
      if (ts.isComputedPropertyName(n.name)) visit(n.name, { ...ctx, kind: 'other' });
      else if (ctx.inClass && ts.isStringLiteral(n.name)) pushString(n.name.text, n.name, ctx);
      if (!ctx.inClass && holdsClasses(name, n.initializer)) visit(n.initializer, { kind: 'other', tag: ctx.tag, inClass: true });
      else visit(n.initializer, ctx.inClass ? ctx : { kind: 'prop', key: name, tag: ctx.tag, inClass: false });
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && holdsClasses(n.name.text, n.initializer)) {
      visit(n.initializer, { kind: 'other', tag: ctx.tag, inClass: true });
      return;
    }

    // ── calls
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      const rootName = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : calleeName;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toFixed') facts.toFixedCalls.push(lineOf(n));
      visit(callee, { ...ctx, kind: 'other' });
      const isClass = CLASS_CALLS.has(calleeName);
      const isToast = TOAST_CALLS.has(rootName);
      n.arguments.forEach((a, i) => {
        if (isClass) visit(a, { kind: 'other', inClass: true, tag: ctx.tag });
        else if (isToast && i === 0) visit(a, { kind: 'toast', tag: ctx.tag, inClass: false });
        else if (isToast && ts.isObjectLiteralExpression(a)) visit(a, { kind: 'other', tag: ctx.tag, inClass: false });
        else visit(a, { ...ctx, kind: 'other' });
      });
      return;
    }

    // ── imports
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const names: string[] = [];
      const clause = n.importClause;
      if (clause?.name) names.push(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const s of nb.elements) names.push((s.propertyName ?? s.name).text);
      facts.imports.push({ from: n.moduleSpecifier.text, names, line: lineOf(n) });
      return;
    }

    if (passesValue(n)) {
      if (ts.isConditionalExpression(n)) {
        visit(n.condition, { ...ctx, kind: 'other' });
        visit(n.whenTrue, ctx);
        visit(n.whenFalse, ctx);
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(n.left, { ...ctx, kind: 'other' });
        visit(n.right, ctx);
      } else {
        ts.forEachChild(n, (c) => visit(c, ctx));
      }
      return;
    }
    // Arrays of strings keep their context (options lists, class arrays); everything else resets to 'other'.
    if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) visit(e, ctx);
      return;
    }
    if (ts.isObjectLiteralExpression(n)) {
      ts.forEachChild(n, (c) => visit(c, ctx.inClass ? ctx : { kind: 'other', tag: ctx.tag, inClass: false }));
      return;
    }
    ts.forEachChild(n, (c) => visit(c, { kind: 'other', tag: ctx.tag, inClass: ctx.inClass && ts.isExpression(n) }));
  };

  visit(sf, { kind: 'other', inClass: false });
  return facts;
}
