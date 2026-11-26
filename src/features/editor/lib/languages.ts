/**
 * Code block languages (§7.11): lowlight with grammars loaded lazily on first use. Bundled grammars only: js, ts, tsx,
 * json, rust, python, go, bash, sql, html, css, markdown, yaml, toml, java, c, cpp, csharp, ruby, php, swift, kotlin.
 */
import type { LanguageFn } from 'highlight.js';
import { createLowlight } from 'lowlight';

export interface LanguageDef {
  id: string;
  label: string;
  aliases: string[];
  grammar: string | null;
}

export const LANGUAGES: LanguageDef[] = [
  { id: 'plain', label: 'Plain text', aliases: ['text', 'txt', 'plaintext'], grammar: null },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell', 'zsh', 'console'], grammar: 'bash' },
  { id: 'c', label: 'C', aliases: ['h'], grammar: 'c' },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'hpp'], grammar: 'cpp' },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'], grammar: 'csharp' },
  { id: 'css', label: 'CSS', aliases: [], grammar: 'css' },
  { id: 'go', label: 'Go', aliases: ['golang'], grammar: 'go' },
  { id: 'html', label: 'HTML', aliases: ['xml', 'svg'], grammar: 'xml' },
  { id: 'java', label: 'Java', aliases: [], grammar: 'java' },
  { id: 'js', label: 'JavaScript', aliases: ['javascript', 'jsx', 'mjs'], grammar: 'javascript' },
  { id: 'json', label: 'JSON', aliases: ['jsonc'], grammar: 'json' },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'], grammar: 'kotlin' },
  { id: 'markdown', label: 'Markdown', aliases: ['md'], grammar: 'markdown' },
  { id: 'php', label: 'PHP', aliases: [], grammar: 'php' },
  { id: 'python', label: 'Python', aliases: ['py'], grammar: 'python' },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'], grammar: 'ruby' },
  { id: 'rust', label: 'Rust', aliases: ['rs'], grammar: 'rust' },
  { id: 'sql', label: 'SQL', aliases: ['postgres', 'sqlite'], grammar: 'sql' },
  { id: 'swift', label: 'Swift', aliases: [], grammar: 'swift' },
  { id: 'toml', label: 'TOML', aliases: ['ini'], grammar: 'ini' },
  { id: 'ts', label: 'TypeScript', aliases: ['typescript'], grammar: 'typescript' },
  { id: 'tsx', label: 'TSX', aliases: [], grammar: 'typescript' },
  { id: 'yaml', label: 'YAML', aliases: ['yml'], grammar: 'yaml' },
];

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  go: () => import('highlight.js/lib/languages/go'),
  xml: () => import('highlight.js/lib/languages/xml'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  php: () => import('highlight.js/lib/languages/php'),
  python: () => import('highlight.js/lib/languages/python'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  ini: () => import('highlight.js/lib/languages/ini'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

export const lowlight = createLowlight();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export function resolveLanguage(id: string | null | undefined): LanguageDef {
  const key = (id ?? 'plain').toLowerCase();
  return LANGUAGES.find((l) => l.id === key || l.aliases.includes(key)) ?? LANGUAGES[0];
}

export function languageLabel(id: string): string {
  return resolveLanguage(id).label;
}

/** The registered grammar name, or null while it loads (a load is started) / for plain text. */
export function grammarFor(id: string | null | undefined): string | null {
  const def = resolveLanguage(id);
  if (!def.grammar) return null;
  if (lowlight.registered(def.grammar)) return def.grammar;
  if (!loading.has(def.grammar)) {
    const g = def.grammar;
    const loader = LOADERS[g];
    if (!loader) return null;
    loading.set(
      g,
      loader()
        .then((m) => {
          lowlight.register(g, m.default);
          listeners.forEach((l) => l());
        })
        .catch(() => undefined),
    );
  }
  return null;
}

export function onGrammarLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
