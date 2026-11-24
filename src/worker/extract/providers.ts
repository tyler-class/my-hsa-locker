// Model providers. Workers AI (default, no key, stays in the user's Cloudflare account) or a
// bring-your-own key for Anthropic, OpenAI or Gemini, chosen by Worker secrets only. Plain fetch,
// no SDKs. The extraction model gets no tools and its output is only ever parsed as data.
import { EXTRACTION_JSON_SCHEMA } from '@shared/extraction';
import { bytesToBinary, fromBase64, toBase64 } from '../bytes';
import { clairicRead } from './clairic';

export { toBase64 };

/** Workers AI models (verified against the catalog 2026-11-05). gemma-4-26b-a4b-it reads images,
 *  supports response_format json_schema, and is what toMarkdown itself uses for images. */
export const WORKERS_AI_TEXT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const WORKERS_AI_VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
/**
 * A second Workers AI model that reads images (Llama 4 Scout: vision and JSON mode, per the
 * catalog). A photo whose first read comes back empty or unusable is tried once with it before
 * the attempt counts as failed: on real phone photos gemma has replied with nothing at all.
 */
export const WORKERS_AI_VISION_FALLBACK = '@cf/meta/llama-4-scout-17b-16e-instruct';
/** Output room for a read: a reasoning model can spend much of it before it answers. */
const WORKERS_AI_MAX_TOKENS = { text: 4096, vision: 8192 } as const;

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash', // HSA Wizard's model
} as const;

export interface FileInput {
  base64: string;
  mime: string;
}

export interface ModelCall {
  system: string;
  user: string;
  file?: FileInput;
  /** Previous attempt and a repair request, for the one retry after invalid JSON. */
  repair?: { previous: string; ask: string };
}

export interface LlmProvider {
  id: string;
  textModel: string;
  visionModel: string;
  thirdParty: boolean;
  /** Mime types the provider can read as a file (images; PDFs where supported). */
  accepts(mime: string): boolean;
  /** Returns the model's raw text reply. */
  complete(call: ModelCall): Promise<{ text: string; model: string }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    /** A short, content-free reason from the provider (its error type or code), for diagnosis. */
    public detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The provider's error type or code from an error reply ("overloaded_error",
 * "RESOURCE_EXHAUSTED"), never its message, which can echo the document.
 */
export function errorKind(body: unknown): string | undefined {
  const e = (body as { error?: unknown })?.error;
  if (!e || typeof e !== 'object') return undefined;
  const o = e as { type?: unknown; code?: unknown; status?: unknown };
  const kind = [o.type, o.code, o.status].find(
    (v) => (typeof v === 'string' && v) || typeof v === 'number',
  );
  return kind === undefined
    ? undefined
    : String(kind)
        .replace(/[^\w.-]/g, '')
        .slice(0, 60);
}

/**
 * An error in a few words (a Workers AI failure, say): its first line, quoted text taken out (in case it quotes
 * the input), trimmed. "AiError: 3040: Capacity temporarily exceeded".
 */
export function shortReason(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const line = `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`.split('\n')[0]!;
  const clean = line
    .replace(/(["'`]).*?\1/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, 120) : undefined;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderError('network', true);
  }
  if (!res.ok) {
    // Only the status and the error's type or code go into errors and logs: bodies can echo
    // document contents.
    const kind = errorKind(await res.json().catch(() => null));
    throw new ProviderError(`http_${res.status}`, res.status === 429 || res.status >= 500, kind);
  }
  return (await res.json()) as Record<string, unknown>;
}

function gatewayUrl(env: Cloudflare.Env, provider: string, fallback: string): string {
  // AI Gateway's universal URL needs the account id, which a Worker doesn't know; the per-provider
  // path works with AI_GATEWAY_URL set to https://gateway.ai.cloudflare.com/v1/<account>/<gateway>.
  const base = env.AI_GATEWAY_URL;
  return base ? `${base.replace(/\/$/, '')}/${provider}` : fallback;
}

// ---------- Workers AI ----------

function workersAi(env: Cloudflare.Env): LlmProvider {
  return {
    id: 'workers-ai',
    textModel: WORKERS_AI_TEXT_MODEL,
    visionModel: WORKERS_AI_VISION_MODEL,
    thirdParty: false,
    accepts: (mime) => ['image/png', 'image/jpeg', 'image/webp'].includes(mime),
    async complete(call) {
      const userContent = call.file
        ? [
            { type: 'text', text: call.user },
            {
              type: 'image_url',
              image_url: { url: `data:${call.file.mime};base64,${call.file.base64}` },
            },
          ]
        : call.user;
      const messages: unknown[] = [
        { role: 'system', content: call.system },
        { role: 'user', content: userContent },
      ];
      if (call.repair) {
        messages.push({ role: 'assistant', content: call.repair.previous });
        messages.push({ role: 'user', content: call.repair.ask });
      }
      const input = {
        messages,
        max_tokens: call.file ? WORKERS_AI_MAX_TOKENS.vision : WORKERS_AI_MAX_TOKENS.text,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extraction', schema: EXTRACTION_JSON_SCHEMA, strict: true },
        },
      };
      const runOnce = async (model: string) => {
        let out: unknown;
        try {
          const run = env.AI.run as unknown as (
            m: string,
            i: unknown,
            o?: unknown,
          ) => Promise<unknown>;
          out = await run.call(
            env.AI,
            model,
            input,
            env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          // "JSON Mode couldn't be met" and capacity errors are worth another try later.
          throw new ProviderError(
            /json mode/i.test(msg) ? 'json_mode' : 'workers_ai_error',
            true,
            shortReason(e),
          );
        }
        return { text: workersAiText(out), model };
      };
      if (!call.file) return runOnce(WORKERS_AI_TEXT_MODEL);
      // A photo: Clairic first (typed fields, no JSON to repair), then the general vision
      // model, then the second one. A repair retry goes straight to the general model.
      const tries: (() => Promise<{ text: string; model: string }>)[] = [
        ...(call.repair ? [] : [() => clairicRead(env, call.file!)]),
        () => runOnce(WORKERS_AI_VISION_MODEL),
        () => runOnce(WORKERS_AI_VISION_FALLBACK),
      ];
      const failed: ProviderError[] = [];
      for (const attempt of tries) {
        try {
          return await attempt();
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          failed.push(e);
          // Only a reply that was empty, refused or errored moves on to the next model.
          if (!FALLBACK_ON.has(e.message)) break;
        }
      }
      const last = failed[failed.length - 1]!;
      const all = failed
        .map((e) => [e.message, e.detail].filter(Boolean).join(' '))
        .join('; then ');
      throw new ProviderError(last.message, last.retryable, all.slice(0, 200));
    },
  };
}

/** First-model failures on a photo that the second model gets a try at. */
const FALLBACK_ON = new Set(['empty_reply', 'json_mode', 'workers_ai_error', 'clairic_skip']);

/**
 * Workers AI replies as {response} (string or already-parsed object), OpenAI-style choices (the
 * content a string or a list of text parts), or {result: …} around either. An empty reply says
 * what came back instead, in a few content-free words: "finish=length reasoning keys=choices,usage".
 */
export function workersAiText(out: unknown): string {
  const top = out as { result?: unknown } | null;
  const o = (top && typeof top === 'object' && 'result' in top ? top.result : out) as {
    response?: unknown;
    output_text?: unknown;
    choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  } | null;
  const c = o?.choices?.[0]?.message?.content;
  const fromParts = Array.isArray(c)
    ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text ?? '') : '')).join('')
    : undefined;
  const r = o?.response ?? o?.output_text ?? fromParts ?? c;
  if (typeof r === 'string' && r.trim()) return r;
  if (r && typeof r === 'object') return JSON.stringify(r);
  throw new ProviderError('empty_reply', true, replyShape(o));
}

/** What a reply held, without its contents: finish reason, whether it reasoned, its keys. */
export function replyShape(o: unknown): string {
  if (!o || typeof o !== 'object') return `type=${o === null ? 'null' : typeof o}`;
  const rec = o as Record<string, unknown>;
  const choice = (rec.choices as Record<string, unknown>[] | undefined)?.[0];
  const msg = choice?.message as Record<string, unknown> | undefined;
  const bits = [
    typeof choice?.finish_reason === 'string' ? `finish=${choice.finish_reason}` : '',
    msg && (msg.reasoning_content || msg.reasoning) ? 'reasoning' : '',
    `keys=${Object.keys(rec).slice(0, 6).join(',')}`,
  ];
  return bits.filter(Boolean).join(' ').slice(0, 120);
}

// ---------- Anthropic ----------

function anthropic(env: Cloudflare.Env, key: string, chosen?: string): LlmProvider {
  const model = chosen || DEFAULT_MODELS.anthropic;
  return {
    id: 'anthropic',
    textModel: model,
    visionModel: model,
    thirdParty: true,
    accepts: (mime) => ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mime),
    async complete(call) {
      const content: unknown[] = [];
      if (call.file) {
        content.push(
          call.file.mime === 'application/pdf'
            ? {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: call.file.base64 },
              }
            : {
                type: 'image',
                source: { type: 'base64', media_type: call.file.mime, data: call.file.base64 },
              },
        );
      }
      content.push({ type: 'text', text: call.user });
      const messages: unknown[] = [{ role: 'user', content }];
      if (call.repair) {
        messages.push({ role: 'assistant', content: call.repair.previous });
        messages.push({ role: 'user', content: call.repair.ask });
      }
      const res = await postJson(
        gatewayUrl(env, 'anthropic', 'https://api.anthropic.com') + '/v1/messages',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 4096, temperature: 0.1, system: call.system, messages },
      );
      const blocks = (res.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (!text) throw new ProviderError('empty_reply', true);
      return { text, model };
    },
  };
}

// ---------- OpenAI ----------

function openai(env: Cloudflare.Env, key: string, chosen?: string): LlmProvider {
  const model = chosen || DEFAULT_MODELS.openai;
  return {
    id: 'openai',
    textModel: model,
    visionModel: model,
    thirdParty: true,
    accepts: (mime) => ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mime),
    async complete(call) {
      const parts: unknown[] = [{ type: 'text', text: call.user }];
      if (call.file) {
        const url = `data:${call.file.mime};base64,${call.file.base64}`;
        parts.push(
          call.file.mime === 'application/pdf'
            ? { type: 'file', file: { filename: 'document.pdf', file_data: url } }
            : { type: 'image_url', image_url: { url } },
        );
      }
      const messages: unknown[] = [
        { role: 'system', content: call.system },
        { role: 'user', content: parts },
      ];
      if (call.repair) {
        messages.push({ role: 'assistant', content: call.repair.previous });
        messages.push({ role: 'user', content: call.repair.ask });
      }
      const res = await postJson(
        gatewayUrl(env, 'openai', 'https://api.openai.com/v1') + '/chat/completions',
        { Authorization: `Bearer ${key}` },
        {
          model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'extraction', schema: EXTRACTION_JSON_SCHEMA, strict: true },
          },
        },
      );
      const text = (res.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message
        ?.content;
      if (!text) throw new ProviderError('empty_reply', true);
      return { text, model };
    },
  };
}

// ---------- Gemini ----------

function gemini(env: Cloudflare.Env, key: string, chosen?: string): LlmProvider {
  const model = chosen || DEFAULT_MODELS.gemini;
  return {
    id: 'gemini',
    textModel: model,
    visionModel: model,
    thirdParty: true,
    accepts: (mime) =>
      [
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf',
      ].includes(mime),
    async complete(call) {
      const parts: unknown[] = [];
      if (call.file)
        parts.push({ inline_data: { mime_type: call.file.mime, data: call.file.base64 } });
      parts.push({ text: call.user });
      const contents: unknown[] = [{ role: 'user', parts }];
      if (call.repair) {
        contents.push({ role: 'model', parts: [{ text: call.repair.previous }] });
        contents.push({ role: 'user', parts: [{ text: call.repair.ask }] });
      }
      const base = gatewayUrl(env, 'google-ai-studio', 'https://generativelanguage.googleapis.com');
      const res = await postJson(
        `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key },
        {
          system_instruction: { parts: [{ text: call.system }] },
          contents,
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        },
      );
      const cand = (
        res.candidates as
          { content?: { parts?: { text?: string; thought?: boolean }[] } }[] | undefined
      )?.[0];
      const text = cand?.content?.parts?.find((p) => p.text && !p.thought)?.text;
      if (!text) throw new ProviderError('empty_reply', true);
      return { text, model };
    },
  };
}

// ---------- fake (tests) ----------

/**
 * Test provider: the expected JSON is embedded in the document itself after a
 * "FAKE_EXTRACTION:" marker, so tests control the reply without shared state.
 */
function fake(): LlmProvider {
  return {
    id: 'fake',
    textModel: 'fake-text',
    visionModel: 'fake-vision',
    thirdParty: false,
    accepts: (mime) => ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mime),
    async complete(call) {
      const hay = call.file ? bytesToBinary(fromBase64(call.file.base64)) : call.user;
      if (hay.includes('FAKE_FAIL')) throw new ProviderError('http_503', true);
      // A model that never answers (for the pipeline's time limits).
      if (hay.includes('FAKE_HANG')) return new Promise<never>(() => {});
      const i = hay.indexOf('FAKE_EXTRACTION:');
      if (i < 0) return { text: '{"document_type":"Unknown","line_items":[]}', model: 'fake' };
      const rest = hay.slice(i + 'FAKE_EXTRACTION:'.length);
      const end = rest.indexOf('\n');
      return { text: (end < 0 ? rest : rest.slice(0, end)).trim(), model: 'fake' };
    },
  };
}

/** A key the provider refused (401/403): skipped for the rest of this isolate's life. */
const refusedKeys = new Set<string>();

/** True for a provider's "this key isn't valid" reply. */
export function isAuthFailure(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return false;
  if (e.message === 'http_401' || e.message === 'http_403') return true;
  return /auth|api_key|permission/i.test(e.detail ?? '') && e.message === 'http_400';
}

/**
 * A bring-your-own-key provider, first, with Workers AI behind it: if the key is refused, this
 * read (and later ones) go to Workers AI instead. Other failures are the provider's own and
 * count as a failed attempt as usual.
 */
function withFallback(primary: LlmProvider, backup: LlmProvider, key: string): LlmProvider {
  return {
    ...primary,
    async complete(call) {
      const useBackup = () => {
        if (call.file && !backup.accepts(call.file.mime))
          throw new ProviderError('key_refused', false, `${primary.id} refused the API key`);
        return backup.complete(call);
      };
      if (refusedKeys.has(key)) return useBackup();
      try {
        return await primary.complete(call);
      } catch (e) {
        if (!isAuthFailure(e)) throw e;
        console.warn(`${primary.id} refused the API key; reading with Workers AI`);
        refusedKeys.add(key);
        return useBackup();
      }
    },
  };
}

/** A key saved in the app (Settings → Reading documents), from D1. Never sent to the browser. */
export interface KeyConfig {
  provider: string;
  key: string;
  model?: string | null;
}

export const KEY_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** The key saved in the app, if any. */
export async function loadKeyConfig(db: D1Database): Promise<KeyConfig | null> {
  const rows = await db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('llm_provider', 'llm_api_key', 'llm_model')",
    )
    .all<{ key: string; value: string }>();
  const m = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
  const provider = m.get('llm_provider')?.trim().toLowerCase();
  const key = m.get('llm_api_key')?.trim();
  return provider && key ? { provider, key, model: m.get('llm_model') || null } : null;
}

/** Where the key in use comes from: saved in the app, a Worker secret, or none (Workers AI). */
export function keyConfig(
  env: Cloudflare.Env,
  saved: KeyConfig | null,
): (KeyConfig & { source: 'app' | 'secret' }) | null {
  if (saved) return { ...saved, source: 'app' };
  const provider = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const key = env.LLM_API_KEY?.trim();
  return provider && key ? { provider, key, model: env.LLM_MODEL || null, source: 'secret' } : null;
}

function external(env: Cloudflare.Env, c: KeyConfig): LlmProvider | null {
  const model = c.model || undefined;
  if (c.provider === 'anthropic') return anthropic(env, c.key, model);
  if (c.provider === 'openai') return openai(env, c.key, model);
  if (c.provider === 'gemini' || c.provider === 'google') return gemini(env, c.key, model);
  return null;
}

/**
 * The active provider: a key saved in the app first, else one set as a Worker secret, falling
 * back to Workers AI if the provider refuses it; with no key, Workers AI.
 */
export function getProvider(env: Cloudflare.Env, saved: KeyConfig | null = null): LlmProvider {
  if ((env.LLM_PROVIDER ?? '').trim().toLowerCase() === 'fake') return fake();
  const c = keyConfig(env, saved);
  const ext = c && external(env, c);
  return ext && c ? withFallback(ext, workersAi(env), c.key) : workersAi(env);
}

/**
 * Asks the provider whether it takes this key, by listing its models (no document is sent, and
 * nothing is billed). "unreachable" when the provider couldn't be asked.
 */
export async function checkKey(
  provider: KeyProvider,
  key: string,
): Promise<'ok' | 'refused' | 'unreachable'> {
  const req =
    provider === 'anthropic'
      ? new Request('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        })
      : provider === 'openai'
        ? new Request('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
          })
        : new Request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
            headers: { 'x-goog-api-key': key },
          });
  let res: Response;
  try {
    res = await fetch(req);
  } catch {
    return 'unreachable';
  }
  await res.body?.cancel().catch(() => {});
  if (res.ok) return 'ok';
  // Gemini answers a bad key with 400 API_KEY_INVALID.
  if (res.status === 400 || res.status === 401 || res.status === 403) return 'refused';
  return 'unreachable';
}

/** True when LLM_PROVIDER names a provider but the key is missing (shown in Settings → AI). */
export function providerMisconfigured(env: Cloudflare.Env): boolean {
  const p = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  return ['anthropic', 'openai', 'gemini', 'google'].includes(p) && !env.LLM_API_KEY?.trim();
}
