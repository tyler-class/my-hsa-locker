import { describe, expect, it } from 'vitest';
import {
  getProvider,
  ProviderError,
  replyShape,
  WORKERS_AI_VISION_FALLBACK,
  WORKERS_AI_VISION_MODEL,
  workersAiText,
} from '../../src/worker/extract/providers';
import { CLAIRIC_MODEL, clairicExtraction } from '../../src/worker/extract/clairic';

describe('Workers AI replies', () => {
  it('reads the answer from each shape Workers AI uses', () => {
    expect(workersAiText({ response: '{"a":1}' })).toBe('{"a":1}');
    expect(workersAiText({ response: { a: 1 } })).toBe('{"a":1}');
    expect(workersAiText({ choices: [{ message: { content: '{"b":2}' } }] })).toBe('{"b":2}');
    expect(
      workersAiText({ choices: [{ message: { content: [{ type: 'text', text: '{"c":3}' }] } }] }),
    ).toBe('{"c":3}');
    expect(workersAiText({ result: { response: '{"d":4}' } })).toBe('{"d":4}');
  });

  it('says what came back when the answer is empty, without its contents', () => {
    const reply = {
      choices: [
        {
          finish_reason: 'length',
          message: { content: null, reasoning_content: 'Patient: Jane Doe, $12.34…' },
        },
      ],
      usage: {},
    };
    let err: unknown;
    try {
      workersAiText(reply);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toBe('empty_reply');
    expect((err as ProviderError).detail).toBe('finish=length reasoning keys=choices,usage');
    expect((err as ProviderError).detail).not.toMatch(/Jane|12\.34/);
    expect(replyShape(null)).toBe('type=null');
    expect(() => workersAiText({ response: '   ' })).toThrow(ProviderError);
  });
});

/** A Workers AI binding that answers per model, and remembers which models were asked. */
function fakeAi(answers: Record<string, unknown | Error>) {
  const asked: string[] = [];
  const env = {
    AI: {
      run: async (model: string) => {
        asked.push(model);
        const a = answers[model];
        if (a instanceof Error) throw a;
        return a;
      },
    },
  } as unknown as Cloudflare.Env;
  return { env, asked };
}

const photo = { system: 's', user: 'u', file: { base64: 'AAAA', mime: 'image/jpeg' } };

/** A Clairic reply for a one-charge receipt. */
const receipt = (over: Record<string, unknown> = {}) => ({
  model: 'clairic-27b',
  answers: Object.fromEntries(
    Object.entries({
      is_receipt: true,
      is_eob: false,
      charge_count: 1,
      provider_name: 'Walgreens',
      patient_name: 'Jane Doe',
      description: 'Prescription',
      card_last4: '**** 4242',
      service_date: '2026-11-20',
      payment_date: '2026-11-20',
      amount_paid: 12.5,
      ...over,
    }).map(([k, value]) => [k, { value, confidence: 0.97 }]),
  ),
});

describe('Clairic', () => {
  it('turns a receipt into one line', () => {
    const x = JSON.parse(clairicExtraction(receipt()));
    expect(x.document_type).toBe('Receipt');
    expect(x.line_items).toHaveLength(1);
    expect(x.line_items[0]).toMatchObject({
      provider_name: 'Walgreens',
      amount: '12.50',
      card_last4: '4242',
      appointment_date: '2026-11-20',
      flag_for_review: false,
    });
  });

  it('leaves EOBs, several charges and a missing amount to the general model', () => {
    for (const over of [
      { is_eob: true },
      { charge_count: 3 },
      { amount_paid: null },
      { is_receipt: false },
    ]) {
      expect(() => clairicExtraction(receipt(over))).toThrow(ProviderError);
    }
  });

  it('flags a read it is unsure of', () => {
    const r = receipt();
    (r.answers.amount_paid as { confidence: number }).confidence = 0.5;
    expect(JSON.parse(clairicExtraction(r)).line_items[0].flag_for_review).toBe(true);
  });
});

describe('reading a photo with Workers AI', () => {
  it('reads with Clairic first', async () => {
    const { env, asked } = fakeAi({ [CLAIRIC_MODEL]: receipt() });
    expect((await getProvider(env).complete(photo)).model).toBe(CLAIRIC_MODEL);
    expect(asked).toEqual([CLAIRIC_MODEL]);
  });

  it('tries the second model once when the first answers with nothing', async () => {
    const { env, asked } = fakeAi({
      [CLAIRIC_MODEL]: new Error('5006: bad input'),
      [WORKERS_AI_VISION_MODEL]: { choices: [{ finish_reason: 'length', message: {} }] },
      [WORKERS_AI_VISION_FALLBACK]: { response: '{"ok":true}' },
    });
    const r = await getProvider(env).complete(photo);
    expect(r).toEqual({ text: '{"ok":true}', model: WORKERS_AI_VISION_FALLBACK });
    expect(asked).toEqual([CLAIRIC_MODEL, WORKERS_AI_VISION_MODEL, WORKERS_AI_VISION_FALLBACK]);
  });

  it('uses the first model alone when it answers', async () => {
    const { env, asked } = fakeAi({
      [CLAIRIC_MODEL]: receipt({ is_eob: true }),
      [WORKERS_AI_VISION_MODEL]: { response: '{"ok":1}' },
    });
    expect((await getProvider(env).complete(photo)).model).toBe(WORKERS_AI_VISION_MODEL);
    expect(asked).toEqual([CLAIRIC_MODEL, WORKERS_AI_VISION_MODEL]);
  });

  it('reports both failures when neither model can read it', async () => {
    const { env } = fakeAi({
      [WORKERS_AI_VISION_MODEL]: { choices: [{ finish_reason: 'length', message: {} }] },
      [WORKERS_AI_VISION_FALLBACK]: new Error('3040: Capacity temporarily exceeded'),
    });
    const err = await getProvider(env)
      .complete(photo)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toBe('workers_ai_error');
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).detail).toMatch(
      /^empty_reply clairic: no answers; then empty_reply finish=length .*; then workers_ai_error/,
    );
  });

  it('never tries a second model for text', async () => {
    const { env, asked } = fakeAi({});
    await getProvider(env)
      .complete({ system: 's', user: 'u' })
      .catch(() => {});
    expect(asked).toHaveLength(1);
  });
});

describe('a bring-your-own key', () => {
  it('falls back to Workers AI when the key is refused', async () => {
    const { env, asked } = fakeAi({ [CLAIRIC_MODEL]: receipt() });
    Object.assign(env, { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-bad-test-key' });
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { type: 'authentication_error' } }), {
        status: 401,
      });
    }) as typeof fetch;
    try {
      const p = getProvider(env);
      expect((await p.complete(photo)).model).toBe(CLAIRIC_MODEL);
      // Once refused, the key isn't tried again.
      await getProvider(env).complete(photo);
      expect(calls).toBe(1);
      expect(asked).toEqual([CLAIRIC_MODEL, CLAIRIC_MODEL]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps the provider's other failures as its own", async () => {
    const { env, asked } = fakeAi({});
    Object.assign(env, { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-busy-test-key' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
        status: 529,
      })) as typeof fetch;
    try {
      const err = await getProvider(env)
        .complete(photo)
        .catch((e: unknown) => e);
      expect((err as ProviderError).message).toBe('http_529');
      expect(asked).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the Anthropic request', () => {
  it('sends no temperature, gives the model room to think, and says why a 400 failed', async () => {
    const { env } = fakeAi({});
    Object.assign(env, { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'sk-ant-shape-test' });
    const realFetch = globalThis.fetch;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":1}' }] }),
      );
    }) as typeof fetch;
    try {
      const r = await getProvider(env).complete(photo);
      expect(r.text).toBe('{"ok":1}');
      expect(sent).not.toHaveProperty('temperature');
      expect(sent.model).toBe('claude-opus-5-5');
      expect(sent.max_tokens).toBeGreaterThanOrEqual(16000);

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: { type: 'invalid_request_error', message: 'temperature: not supported' },
          }),
          { status: 400 },
        )) as typeof fetch;
      const err = await getProvider(env)
        .complete(photo)
        .catch((e: unknown) => e);
      expect((err as ProviderError).detail).toBe(
        'invalid_request_error: temperature: not supported',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
