import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

/**
 * One error shape for the whole API: `{ error: { code, message } }`.
 * The frontend switches on `code`, humans read `message`.
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'invalid_code'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'registration_closed'
  | 'session_full'
  | 'internal';

export function apiError(
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
): HTTPException {
  return new HTTPException(status, {
    res: Response.json({ error: { code, message } }, { status }),
  });
}

export const badRequest = (message: string, code: ApiErrorCode = 'bad_request') =>
  apiError(400, code, message);
export const unauthorized = (message = 'Sign in first') => apiError(401, 'unauthorized', message);
export const forbidden = (message = 'Organizers only') => apiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => apiError(404, 'not_found', message);
export const conflict = (message: string, code: ApiErrorCode = 'conflict') =>
  apiError(409, code, message);

/**
 * Parse a JSON body against a zod schema, turning validation failures into a
 * 400 that names the offending field.
 */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest('Expected a JSON body');
  }
  return validate(schema, raw);
}

/**
 * Same, but an absent body is not an error — the schema's defaults stand in.
 *
 * For endpoints where every field is optional. `POST /register` took no body
 * at all before guests existed, and adding one optional field must not turn
 * every old caller into a 400.
 */
export async function parseOptionalBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    throw badRequest('Expected a JSON body');
  }
  return validate(schema, raw);
}

function validate<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.');
    throw badRequest(path ? `${path}: ${first?.message}` : (first?.message ?? 'Invalid body'));
  }
  return result.data;
}

/** Cheap unique id. `crypto.randomUUID` is available in Workers and browsers. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
