import { platform } from '../platform/index.js';

/**
 * The data layer.
 *
 * Every network call in the app goes through this file: plain `fetch`, plain
 * JSON, no framework. The rest of the frontend imports typed functions from
 * `api/*` and never constructs a URL. Moving to the Zalo Mini App means
 * pointing `platform.apiBaseUrl` somewhere else — or, if ZMP's own request API
 * is required, reimplementing `request()` alone.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the caller should send the user back to the invite screen. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

const TOKEN_KEY = 'token';

let token: string | null = platform.storage.get(TOKEN_KEY);
let unauthorizedHandler: (() => void) | null = null;

export function getToken(): string | null {
  return token;
}

export function setToken(value: string): void {
  token = value;
  platform.storage.set(TOKEN_KEY, value);
}

export function clearToken(): void {
  token = null;
  platform.storage.remove(TOKEN_KEY);
}

/** Lets the app shell bounce the user to the gate when a token goes stale. */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

interface RequestOptions {
  body?: unknown;
  /** Raw payload for binary uploads; bypasses JSON encoding. */
  raw?: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.contentType) headers['Content-Type'] = options.contentType;

  let response: Response;
  try {
    response = await fetch(`${platform.apiBaseUrl}${path}`, {
      method,
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      // Sends the mirrored cookie when API and app share an origin. Harmless
      // cross-origin, where the bearer token above does the work.
      credentials: 'include',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'offline', 'No connection — check your network');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const detail = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    const apiError = new ApiError(
      response.status,
      detail?.code ?? 'unknown',
      detail?.message ?? `Request failed (${response.status})`,
    );
    // A 401 means the stored token is dead; drop it so the app cannot loop
    // retrying with a credential that will never work again.
    if (apiError.isAuthError) {
      clearToken();
      unauthorizedHandler?.();
    }
    throw apiError;
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const get = <T>(path: string, signal?: AbortSignal) =>
  request<T>('GET', path, { signal });
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body });
export const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body });
export const del = <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body });

/**
 * Fetch a binary resource with the same credentials as everything else.
 *
 * Payment screenshots live behind an authorized route, and an `<img src>`
 * cannot send a bearer token — so they are pulled down as blobs and handed to
 * `platform.objectUrl` instead.
 */
export async function getBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${platform.apiBaseUrl}${path}`, {
    headers,
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearToken();
      unauthorizedHandler?.();
    }
    throw new ApiError(response.status, 'fetch_failed', 'Could not load that image');
  }
  return response.blob();
}
