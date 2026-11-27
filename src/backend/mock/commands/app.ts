/** app_* — app info, readiness marks, updates (browser preview never updates). */
import { BackendError } from '../../errors';
import type { AppFeature, Platform } from '../../types';
import type { MockHandlers } from '../ctx';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'macos';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  if (p.includes('mac')) return 'macos';
  if (p.includes('win')) return 'windows';
  return 'linux';
}

function browserName(): string {
  if (typeof navigator === 'undefined') return 'node';
  const ua = navigator.userAgent;
  const m = /(Edg|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
  if (!m) return 'browser';
  const name = m[1] === 'Version' ? 'Safari' : m[1] === 'Edg' ? 'Edge' : m[1];
  return `${name} ${m[2].split('.')[0]}`;
}

export const handlers: MockHandlers = {
  app_info: () => {
    const platform = detectPlatform();
    const features: AppFeature[] = [];
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches) {
      features.push('reduced-transparency');
    }
    if (typeof window !== 'undefined' && 'EyeDropper' in window) features.push('eyedropper');
    return {
      version: '1.0.0',
      commit: 'browser-preview',
      platform,
      arch: 'x86_64',
      webview: browserName(),
      features,
    };
  },
  app_ready: (req, ctx) => {
    ctx.db.setMeta('app.readyMarks', req.marks);
  },
  app_reveal_data_dir: () => {
    throw new BackendError('UNSUPPORTED', 'The data folder lives on your device in the desktop app.');
  },
  app_reveal_logs: () => {
    throw new BackendError('UNSUPPORTED', 'Logs are kept on your device in the desktop app.');
  },
  app_quit: () => {
    if (typeof window !== 'undefined') window.close();
  },
  // Rust asks GitHub through NetGuard; the browser preview has no network path of its own, so it says so.
  app_check_update: (_req, ctx) => {
    if (ctx.isOffline()) throw new BackendError('OFFLINE', 'Offline mode is on');
    throw new BackendError('UNSUPPORTED', 'Update checks run in the desktop app');
  },
  app_install_update: () => {
    throw new BackendError('UNSUPPORTED', 'Updates install in the desktop app');
  },
};
