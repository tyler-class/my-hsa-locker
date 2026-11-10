// Model providers. Workers AI (default, no key, stays in the user's Cloudflare account) or a
// bring-your-own key for Anthropic, OpenAI or Gemini, chosen by Worker secrets only. Plain fetch,
// no SDKs. The extraction model gets no tools and its output is only ever parsed as data.
import { EXTRACTION_JSON_SCHEMA } from '@shared/extraction';
import { bytesToBinary, fromBase64, toBase64 } from '../bytes';

export { toBase64 };

/** Workers AI models (verified against the catalog 2026-11-05). gemma-4-26b-a4b-it reads images,
 *  supports response_format json_schema, and is what toMarkdown itself uses for images. */
export const WORKERS_AI_TEXT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const WORKERS_AI_VISION_MODEL = '@cf/google/gemma-4-26b-a4b-it';

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
  ) {
    super(message);
  }
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
    // Only the status goes into errors and logs: bodies can echo document contents.
    throw new ProviderError(`http_${res.status}`, res.status === 429 || res.status >= 500);
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
      const model = call.file ? WORKERS_AI_VISION_MODEL : WORKERS_AI_TEXT_MODEL;
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
        max_tokens: 4096,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extraction', schema: EXTRACTION_JSON_SCHEMA, strict: true },
        },
      };
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
        throw new ProviderError(/json mode/i.test(msg) ? 'json_mode' : 'workers_ai_error', true);
      }
      return { text: workersAiText(out), model };
    },
  };
}

/** Workers AI replies as {response} (string or already-parsed object) or OpenAI-style choices. */
export function workersAiText(out: unknown): string {
  const o = out as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  const r = o?.response ?? o?.choices?.[0]?.message?.content;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') return JSON.stringify(r);
  throw new ProviderError('empty_reply', true);
}

// ---------- Anthropic ----------

function anthropic(env: Cloudflare.Env, key: string): LlmProvider {
  const model = env.LLM_MODEL || DEFAULT_MODELS.anthropic;
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

function openai(env: Cloudflare.Env, key: string): LlmProvider {
  const model = env.LLM_MODEL || DEFAULT_MODELS.openai;
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

function gemini(env: Cloudflare.Env, key: string): LlmProvider {
  const model = env.LLM_MODEL || DEFAULT_MODELS.gemini;
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
      const i = hay.indexOf('FAKE_EXTRACTION:');
      if (i < 0) return { text: '{"document_type":"Unknown","line_items":[]}', model: 'fake' };
      const rest = hay.slice(i + 'FAKE_EXTRACTION:'.length);
      const end = rest.indexOf('\n');
      return { text: (end < 0 ? rest : rest.slice(0, end)).trim(), model: 'fake' };
    },
  };
}

/** The active provider from Worker secrets. Misconfiguration falls back to Workers AI. */
export function getProvider(env: Cloudflare.Env): LlmProvider {
  const p = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  const key = env.LLM_API_KEY?.trim();
  if (p === 'fake') return fake();
  if (key && p === 'anthropic') return anthropic(env, key);
  if (key && p === 'openai') return openai(env, key);
  if (key && (p === 'gemini' || p === 'google')) return gemini(env, key);
  return workersAi(env);
}

/** True when LLM_PROVIDER names a provider but the key is missing (shown in Settings → AI). */
export function providerMisconfigured(env: Cloudflare.Env): boolean {
  const p = (env.LLM_PROVIDER ?? '').trim().toLowerCase();
  return ['anthropic', 'openai', 'gemini', 'google'].includes(p) && !env.LLM_API_KEY?.trim();
}
