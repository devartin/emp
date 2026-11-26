import type { ApiError, ApiErrorDetails, ErrorCode } from './types';

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'LOCKED', 'BAD_PASSWORD', 'RATE_LIMITED', 'REAUTH_REQUIRED', 'NOT_FOUND', 'CONFLICT', 'INVALID', 'CRYPTO', 'INTEGRITY',
  'IO', 'NETWORK', 'OFFLINE', 'AUTH_REQUIRED', 'PROVIDER', 'QUOTA', 'CANCELLED', 'UNSUPPORTED', 'SCHEMA_TOO_NEW',
  'TOO_LARGE', 'INTERNAL',
]);

/** Every facade call rejects with one of these. It satisfies the `ApiError` wire shape. */
export class BackendError extends Error implements ApiError {
  readonly code: ErrorCode;
  readonly details?: ApiErrorDetails;
  /** The command that failed, when known. */
  readonly command?: string;

  constructor(code: ErrorCode, message: string, details?: ApiErrorDetails, command?: string) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    if (details) this.details = details;
    if (command) this.command = command;
  }

  toJSON(): ApiError {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && CODES.has(v);
}

/** True for a BackendError or any plain `{code, message}` object with a known code. */
export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && isErrorCode((e as { code?: unknown }).code);
}

export function hasCode(e: unknown, ...codes: ErrorCode[]): boolean {
  return isApiError(e) && codes.includes(e.code);
}

const FRIENDLY: Partial<Record<ErrorCode, string>> = {
  LOCKED: 'Ultra Note is locked.',
  BAD_PASSWORD: 'Incorrect password',
  RATE_LIMITED: 'Too many attempts. Try again shortly.',
  REAUTH_REQUIRED: 'Confirm your password to continue.',
  NOT_FOUND: 'That item no longer exists.',
  CONFLICT: 'This changed somewhere else.',
  OFFLINE: 'Offline mode is on.',
  NETWORK: 'Network request failed.',
  CANCELLED: 'Cancelled.',
  UNSUPPORTED: 'Not supported here.',
  INTERNAL: 'Something went wrong.',
};

/**
 * Normalises anything thrown by `invoke`, a mock handler or a Channel into a BackendError.
 * Rust serialises `ApiError` as an object; older paths may reject with a JSON string or a plain string.
 */
export function toBackendError(e: unknown, command?: string): BackendError {
  if (e instanceof BackendError) return e;
  if (isApiError(e)) return new BackendError(e.code, e.message || FRIENDLY[e.code] || e.code, e.details, command);
  if (typeof e === 'string') {
    const s = e.trim();
    if (s.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (isApiError(parsed)) return toBackendError(parsed, command);
      } catch {
        /* fall through */
      }
    }
    const m = /^([A-Z_]+):\s*(.*)$/s.exec(s);
    if (m && isErrorCode(m[1])) return new BackendError(m[1], m[2] || FRIENDLY[m[1]] || m[1], undefined, command);
    return new BackendError('INTERNAL', s || 'Unknown error', undefined, command);
  }
  if (e instanceof Error) {
    const name = e.name === 'AbortError' ? 'CANCELLED' : 'INTERNAL';
    return new BackendError(name, e.message || FRIENDLY[name] || name, undefined, command);
  }
  return new BackendError('INTERNAL', 'Unknown error', undefined, command);
}

/** A short user-facing message for any error. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message || FRIENDLY[e.code] || e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}
