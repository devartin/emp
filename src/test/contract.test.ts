/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ALL_COMMANDS, COMMAND_FLAGS, splitCommand } from '@/backend/contract';
import { buildFacade } from '@/backend/facade';
import { createMockBackend } from '@/backend/mock';

/** Command names exactly as SPEC §11.3 lists them. */
function specCommands(): string[] {
  const spec = readFileSync(new URL('../../docs/SPEC.md', import.meta.url), 'utf8');
  const start = spec.indexOf('### 11.3 Commands');
  const end = spec.indexOf('### 11.4', start);
  const section = spec.slice(start, end);
  const names = new Set<string>();
  for (const m of section.matchAll(/^\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/gm)) names.add(m[1]);
  return [...names].sort();
}

/** Namespaces the core mock implements in full. */
const CORE_NAMESPACES = [
  'app', 'vault', 'security', 'secret', 'settings', 'kv', 'workspace', 'page', 'version', 'asset', 'search', 'job',
  'network', 'trash', 'daily', 'template', 'open', 'file', 'password',
];

describe('contract', () => {
  test('ALL_COMMANDS matches SPEC §11.3 exactly', () => {
    const spec = specCommands();
    expect(spec.length).toBeGreaterThan(200);
    expect([...ALL_COMMANDS].sort()).toEqual(spec);
  });

  test('(job) markers follow the spec', () => {
    const spec = readFileSync(new URL('../../docs/SPEC.md', import.meta.url), 'utf8');
    const section = spec.slice(spec.indexOf('### 11.3 Commands'), spec.indexOf('### 11.4'));
    const jobLines = new Set<string>();
    const reauthLines = new Set<string>();
    for (const m of section.matchAll(/^\s*([a-z][a-z0-9_]+)\(([\s\S]*?)$/gm)) {
      if (/\(job\)/.test(m[2])) jobLines.add(m[1]);
      if (/\(reauth\)/.test(m[2]) && !/\(reauth\) (if|when)/.test(m[2])) reauthLines.add(m[1]);
    }
    for (const name of ALL_COMMANDS) {
      expect(!!COMMAND_FLAGS[name].job, `${name} job flag`).toBe(jobLines.has(name));
    }
    for (const name of reauthLines) {
      if (name === 'export_pages') continue; // reauth only when the vault is encrypted (checked in the handler)
      expect(!!(COMMAND_FLAGS as Record<string, { reauth?: boolean }>)[name].reauth, `${name} reauth flag`).toBe(true);
    }
  });

  test('facade exposes every command as api.<namespace>.<camelCase>', () => {
    const api = buildFacade(() => new Promise(() => undefined)) as unknown as Record<string, Record<string, unknown>>;
    for (const name of ALL_COMMANDS) {
      const [ns, method] = splitCommand(name);
      expect(typeof api[ns]?.[method], name).toBe('function');
    }
    expect(splitCommand('page_get_meta')).toEqual(['page', 'getMeta']);
    expect(splitCommand('daily_note_open')).toEqual(['daily', 'noteOpen']);
    expect(splitCommand('open_external_confirm')).toEqual(['open', 'externalConfirm']);
  });

  test('every core namespace command has a mock handler; no handler is unknown', async () => {
    const backend = await createMockBackend({ seed: 'empty' });
    const implemented = new Set(backend.implemented());
    for (const name of ALL_COMMANDS) {
      const [ns] = splitCommand(name);
      if (CORE_NAMESPACES.includes(ns)) expect(implemented.has(name), `${name} handler`).toBe(true);
    }
    for (const name of implemented) expect(ALL_COMMANDS).toContain(name);
  });
});
