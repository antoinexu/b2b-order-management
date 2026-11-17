import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';

/** API origin. Empty in development: Vite proxies /api to the backend on :3000. */
const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const TOKEN_KEY = 'b2b.token';

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Error carrying the API's `{ error: { code, message, details } }` payload. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (handler: () => void) => { onUnauthorized = handler; };

const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = tokenStorage.get();
    if (token) request.headers.set('Authorization', `Bearer ${token}`);
    return request;
  },
  onResponse({ response, request }) {
    // An expired or revoked token anywhere except the login call itself ends the session.
    if (response.status === 401 && !request.url.endsWith('/auth/login')) onUnauthorized();
    return response;
  },
};

export const api = createClient<paths>({ baseUrl: `${API_ORIGIN}/api/v1` });
api.use(authMiddleware);

interface ErrorBody { error?: { code?: string; message?: string; details?: unknown } }

/** Unwraps an openapi-fetch result: returns data or throws an ApiError. */
export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await promise;
  if (error !== undefined || !response.ok) {
    const body = (error ?? {}) as ErrorBody;
    throw new ApiError(
      response.status,
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.details,
    );
  }
  return data as T;
}

/** Human-readable message for any thrown value, including validation details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details) && err.details.length > 0) {
      return err.details.map((d: { path?: string; message?: string }) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
