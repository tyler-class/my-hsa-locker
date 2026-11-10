// Secrets aren't in wrangler.jsonc, so `wrangler types` can't see them.
declare namespace Cloudflare {
  interface Env {
    /** The household password. Set with `wrangler secret put APP_PASSWORD`. */
    APP_PASSWORD?: string;
    /** Optional: anthropic | openai | gemini. Unset uses Workers AI. ("fake" in tests.) */
    LLM_PROVIDER?: string;
    /** API key for LLM_PROVIDER. A secret only; never stored in the database. */
    LLM_API_KEY?: string;
    /** Optional model override for LLM_PROVIDER. */
    LLM_MODEL?: string;
    /** Optional AI Gateway id: Workers AI calls go through it (logging, caching). */
    AI_GATEWAY_ID?: string;
    /** Optional AI Gateway base URL for BYO providers: https://gateway.ai.cloudflare.com/v1/<account>/<gateway> */
    AI_GATEWAY_URL?: string;
    /** Injected by OAuthProvider into the default handler. */
    OAUTH_PROVIDER?: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  }
}
