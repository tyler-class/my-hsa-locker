// Worker entry. OAuthProvider sits in front so AI assistants can connect over MCP:
//   /mcp            → MCP server (needs an OAuth token)
//   /authorize      → consent page (approve with the household password)
//   /oauth/*, /.well-known/* → handled by the provider
//   /api/*          → the app's REST API (cookie session)
// Plus email() for the inbox and scheduled() for the work queue.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { app } from './app';
import { handleAuthorize } from './consent';
import { dueInboxMessages, handleEmail, processInboxMessage, type IncomingMessage } from './email';
import { sweep } from './extract/pipeline';
import { mcpApiHandler } from './mcp';
import { runNotifications } from './notifications';
import { sendReminder } from './notify';
import { checkIn, checkInOnRequest, type CheckInOptions } from './kit/telemetry';
import { buildFlags } from '../shared/kit/build';
import pkg from '../../package.json';

/** Tables whose row counts go in the anonymous daily check-in (counts only, never contents). */
export const USAGE_TABLES = [
  'people',
  'providers',
  'categories',
  'documents',
  'entries',
  'reimbursements',
  'inbox_log',
];

/** Headers on every API response. The app's pages get theirs (CSP included) from public/_headers. */
const API_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const defaultHandler = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    const res = await app.fetch(request, env, ctx);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(API_HEADERS))
      if (!out.headers.has(k)) out.headers.set(k, v);
    if (!url.pathname.startsWith('/api/files/')) out.headers.set('X-Frame-Options', 'DENY');
    return out;
  },
};

// The public URL isn't known until deploy, so build one provider per origin the Worker is reached on.
const providers = new Map<string, OAuthProvider<Cloudflare.Env>>();
function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Cloudflare.Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['hsa'],
      requiredScopes: ['hsa'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, p);
  }
  return p;
}

/** OAuth needs HTTPS (or localhost). Plain http elsewhere only happens in local dev on a LAN. */
function oauthCapable(url: URL): boolean {
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** The anonymous daily check-in's settings (counts only; see src/worker/kit/telemetry.ts). */
const usage = (env: Cloudflare.Env): CheckInOptions => ({
  app: 'hsa-locker',
  version: pkg.version,
  tables: USAGE_TABLES,
  buckets: [env.FILES],
  build: buildFlags(),
});

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    // Check in the first time the app is opened each day (no cost after that).
    checkInOnRequest(ctx, request, env.DB, usage(env));
    const url = new URL(request.url);
    if (!oauthCapable(url)) {
      if (
        url.pathname.startsWith('/mcp') ||
        url.pathname.startsWith('/oauth/') ||
        url.pathname.startsWith('/.well-known/')
      ) {
        return Response.json(
          { error: 'https_required', message: 'Connecting assistants needs HTTPS.' },
          { status: 503 },
        );
      }
      return defaultHandler.fetch(request, env, ctx);
    }
    return providerFor(url.origin).fetch(request, env, ctx);
  },

  /** Inbound mail from Email Routing. Kept minimal; parsing happens afterwards. */
  async email(message: ForwardableEmailMessage, env: Cloudflare.Env, ctx: ExecutionContext) {
    await handleEmail(message as unknown as IncomingMessage, env, ctx);
  },

  /** The work queue: unparsed mail first, then documents due for (re)processing; then push. */
  async scheduled(_event: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    // The anonymous check-in goes out at most once a day, and not at all if it's turned off.
    ctx.waitUntil(checkIn(env.DB, usage(env)));
    try {
      for (const id of await dueInboxMessages(env.DB, 5)) await processInboxMessage(env, id);
      const n = await sweep(env, 5);
      if (n) console.log(`sweeper: ${n} document(s) processed`);
      const r = await sendReminder(env);
      if (r.sent) console.log('reminder: sent');
    } catch (e) {
      console.warn(`sweeper failed: ${e instanceof Error ? e.name : 'error'}`);
    }
    // Push: anything still unsent (documents held overnight go out on the first run after 8 a.m.).
    ctx.waitUntil(runNotifications(env.DB));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
