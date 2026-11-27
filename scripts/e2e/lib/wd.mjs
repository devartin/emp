// Minimal W3C WebDriver client with no dependencies.
//
// Two targets share it:
//   desktop  – the real Ultranote binary, driven through tauri-driver (which wraps WebKitWebDriver on Linux).
//   webkit   – the browser build (mock backend) in WebKitGTK's MiniBrowser, the same engine the Linux app uses.
//
// Each desktop session gets its own data directory (XDG_DATA_HOME) because tauri-driver is spawned per session.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(base, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
  return j.value;
}

async function waitForPort(base, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await fetch(base + '/status');
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`WebDriver at ${base} did not start`);
}

function wrap(base, id, cleanup) {
  const q = (m, p, b) => request(base, m, `/session/${id}${p}`, b);
  const el = (v) => Object.values(v)[0];
  return {
    id,
    exec: (script, args = []) => q('POST', '/execute/sync', { script, args }),
    execAsync: (script, args = []) => q('POST', '/execute/async', { script, args }),
    go: (url) => q('POST', '/url', { url }),
    shot: async (file) => writeFileSync(file, Buffer.from(await q('GET', '/screenshot'), 'base64')),
    find: async (css) => el(await q('POST', '/element', { using: 'css selector', value: css })),
    findAll: async (css) => (await q('POST', '/elements', { using: 'css selector', value: css })).map(el),
    click: (e) => q('POST', `/element/${e}/click`, {}),
    type: (e, text) => q('POST', `/element/${e}/value`, { text }),
    clear: (e) => q('POST', `/element/${e}/clear`, {}),
    /** Type into whatever has focus (W3C key actions). Use '' for Enter, '' for Escape. */
    keys: (text) =>
      q('POST', '/actions', {
        actions: [{ type: 'key', id: 'kb', actions: [...text].flatMap((c) => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }]) }],
      }).then(() => q('DELETE', '/actions')),
    /** Press a chord, e.g. chord([''], 'k') for Ctrl+K. Modifier codes: Ctrl , Shift , Alt , Meta . */
    chord: (mods, key) =>
      q('POST', '/actions', {
        actions: [
          {
            type: 'key',
            id: 'kb',
            actions: [
              ...mods.map((m) => ({ type: 'keyDown', value: m })),
              { type: 'keyDown', value: key },
              { type: 'keyUp', value: key },
              ...[...mods].reverse().map((m) => ({ type: 'keyUp', value: m })),
            ],
          },
        ],
      }).then(() => q('DELETE', '/actions')),
    source: () => q('GET', '/source'),
    end: async () => {
      await request(base, 'DELETE', `/session/${id}`).catch(() => undefined);
      await cleanup?.();
    },
  };
}

export const KEY = { enter: '', escape: '', tab: '', backspace: '', ctrl: '', shift: '', alt: '', meta: '', down: '', up: '', left: '', right: '' };

/**
 * Launch the real desktop binary with a fresh (or given) data directory.
 * Requires DISPLAY (Xvfb + a window manager), tauri-driver and WebKitWebDriver on PATH.
 */
export async function desktopSession({ app = process.env.ULTRANOTE_BIN || '/usr/bin/emp-app', dataHome, port = 4444, nativePort = 4445 } = {}) {
  const home = dataHome || mkdtempSync(join(tmpdir(), 'ultranote-e2e-'));
  const driver = spawn('tauri-driver', ['--port', String(port), '--native-port', String(nativePort)], {
    env: { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, 'config'), WEBKIT_DISABLE_COMPOSITING_MODE: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForPort(base);
  let v;
  try {
    v = await request(base, 'POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } });
  } catch (e) {
    driver.kill('SIGTERM');
    throw e;
  }
  const s = wrap(base, v.sessionId, async () => {
    driver.kill('SIGTERM');
    await sleep(300);
  });
  s.dataHome = home;
  return s;
}

/** Open the browser build (mock backend) in WebKitGTK MiniBrowser. Start `WebKitWebDriver --port=4446` first, or let this spawn it. */
export async function webkitSession({ port = 4446, url } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let driver = null;
  try {
    await fetch(base + '/status');
  } catch {
    driver = spawn('WebKitWebDriver', [`--port=${port}`], { stdio: 'ignore' });
    await waitForPort(base);
  }
  const v = await request(base, 'POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'MiniBrowser',
        'webkitgtk:browserOptions': { binary: process.env.MINIBROWSER || '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser', args: ['--automation', '--geometry=1440x900'] },
      },
    },
  });
  const s = wrap(base, v.sessionId, async () => driver?.kill('SIGTERM'));
  if (url) await s.go(url);
  return s;
}
