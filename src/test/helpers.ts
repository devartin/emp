import { buildFacade } from '@/backend/facade';
import { createMockBackend, mockTransportFor, type MockBackend } from '@/backend/mock';
import type { MockOptions } from '@/backend/mock/options';

/** A fresh mock backend plus a typed facade over it (same code path the browser preview uses). */
export async function mockApi(options: Partial<MockOptions> = {}) {
  const backend: MockBackend = await createMockBackend({ seed: 'demo', freeze: Date.parse('2026-11-26T10:00:00Z'), ...options });
  const api = buildFacade(() => Promise.resolve(mockTransportFor(backend)));
  return { backend, api };
}

export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`expected ${code}, but the call succeeded`);
  const got = (err as { code?: string }).code;
  if (got !== code) throw new Error(`expected ${code}, got ${got}: ${(err as Error).message}`);
}
