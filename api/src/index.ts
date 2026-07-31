import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runScheduledMaintenance } from './cron.js';
import type { AppContext, Env } from './env.js';
import { corsMiddleware, pubsubMiddleware, requireMember } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { claimRoutes } from './routes/claims.js';
import { memberRoutes } from './routes/members.js';
import { paymentRoutes } from './routes/payments.js';
import { pushRoutes } from './routes/push.js';
import { realtimeRoutes } from './routes/realtime.js';
import { sessionRoutes } from './routes/sessions.js';
import { uploadRoutes } from './routes/uploads.js';
import { venueRoutes } from './routes/venues.js';

/**
 * Everything behind this router requires a signed-in member. Grouping it into
 * its own app makes the boundary explicit — a route is protected because of
 * where it is mounted, not because someone remembered to add a middleware.
 */
const protectedRoutes = new Hono<AppContext>()
  .use('*', requireMember())
  .route('/members', memberRoutes)
  .route('/venues', venueRoutes)
  .route('/sessions', sessionRoutes)
  // Payment routes declare their own full paths (`/sessions/:id/settle`,
  // `/payments/:id/review`) because they straddle both resources.
  .route('/', paymentRoutes)
  .route('/uploads', uploadRoutes)
  .route('/push', pushRoutes)
  // Declares full paths (`/members/:id/claim-link`, `/auth/my-device-link`).
  .route('/', claimRoutes);

const app = new Hono<AppContext>()
  .use('*', corsMiddleware())
  .use('*', pubsubMiddleware())

  .get('/health', (c) =>
    c.json({ ok: true, realtime: c.get('pubsub').enabled, time: new Date().toISOString() }),
  )

  // Unauthenticated: the invite gate and the name picker.
  .route('/auth', authRoutes)
  // Ticket-authenticated: `EventSource` cannot send an Authorization header.
  .route('/realtime', realtimeRoutes)
  .route('/', protectedRoutes)

  .notFound((c) =>
    c.json({ error: { code: 'not_found', message: `No route for ${c.req.path}` } }, 404),
  )

  .onError((error, c) => {
    if (error instanceof HTTPException) {
      const response = error.getResponse();
      // `apiError` attaches a JSON body; anything else is Hono's plain text.
      if (response.headers.get('Content-Type')?.includes('application/json')) return response;
      return c.json(
        { error: { code: 'bad_request', message: error.message } },
        error.status,
      );
    }

    console.error('Unhandled error', error);
    return c.json(
      { error: { code: 'internal', message: 'Something went wrong on our side' } },
      500,
    );
  });

export type AppType = typeof app;

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // `waitUntil` keeps the Worker alive for the realtime emits that follow the
    // database writes, which would otherwise be cancelled when the handler
    // returns.
    ctx.waitUntil(
      runScheduledMaintenance(env).catch((error: unknown) => {
        console.error('Scheduled maintenance failed', error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
