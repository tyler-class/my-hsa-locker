import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_PROMPTS, MCP_PROMPTS } from '../../src/shared/examples';
import { ORIGIN, PASSWORD, session } from './helpers';

const REDIRECT = 'https://client.example/callback';

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(
    /[+/=]/g,
    '',
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Registers a client, approves it with the household password, returns an access token. */
async function connect(): Promise<string> {
  const reg = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Assistant',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'hsa',
    resource: `${ORIGIN}/mcp`,
  });
  const page = await SELF.fetch(`${ORIGIN}/authorize?${q}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Let Test Assistant use HSA Locker?');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const ok = await SELF.fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookies(page),
      'CF-Connecting-IP': '198.18.0.9',
    },
    body: new URLSearchParams({
      handle,
      decision: 'approve',
      password: PASSWORD,
      client_name: 'Test Assistant',
      redirect_host: 'client.example',
    }),
  });
  expect(ok.status).toBe(302);
  const loc = new URL(ok.headers.get('Location')!);
  const tok = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.text();
  const json = body.startsWith('{') ? body : (/^data: (.*)$/m.exec(body)?.[1] ?? body);
  return JSON.parse(json) as {
    result?: {
      content?: { text: string }[];
      tools?: { name: string; annotations?: Record<string, boolean> }[];
      prompts?: { name: string; arguments?: { name: string; description?: string }[] }[];
      messages?: { content: { text: string } }[];
      isError?: boolean;
      instructions?: string;
    };
    error?: unknown;
  };
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  return {
    text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error),
    isError: !!r.result?.isError,
  };
}

describe('mcp', () => {
  it('requires an OAuth token and advertises its metadata', async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const meta = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { resource: string }).resource).toBe(`${ORIGIN}/mcp`);
  });

  it('offers get_started, examples and ready-made prompts', async () => {
    const api = await session();
    await api.post('/sample-data');
    const token = await connect();

    const init = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.result?.instructions).toContain('call get_started');
    expect(init.result?.instructions).toContain(EXAMPLE_PROMPTS[0]!.prompt);

    const tools = (await rpc(token, 'tools/list')).result!.tools!;
    const start = tools.find((t) => t.name === 'get_started');
    expect(start?.annotations?.readOnlyHint).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_summary', 'list_entries', 'mark_reimbursed', 'get_started']),
    );

    const prompts = (await rpc(token, 'prompts/list')).result!.prompts!;
    expect(prompts.map((p) => p.name).sort()).toEqual(MCP_PROMPTS.map((p) => p.name).sort());
    for (const p of prompts) for (const a of p.arguments ?? []) expect(a.description).toBeTruthy();

    const got = await rpc(token, 'prompts/get', {
      name: 'record_reimbursement',
      arguments: { amount: '412.50', date: '2026-10-01' },
    });
    const recipe = got.result!.messages![0]!.content.text;
    expect(recipe).toContain('$412.50');
    expect(recipe).toContain('2026-10-01');
    expect(recipe).toContain('mark_reimbursed');
    const card = await rpc(token, 'prompts/get', {
      name: 'hsa_card_check',
      arguments: { card_last4: '4242' },
    });
    expect(card.result!.messages![0]!.content.text).toContain('ending 4242');

    const s = await tool(token, 'get_started', {});
    expect(s.isError).toBe(false);
    expect(s.text).toContain('Reimbursable: $');
    expect(s.text).toContain('Waiting for review');
    for (const e of EXAMPLE_PROMPTS) expect(s.text).toContain(e.prompt);
    for (const p of MCP_PROMPTS) expect(s.text).toContain(p.name);

    // The examples' read tools actually work on this data.
    const sum = await tool(token, 'get_summary', {});
    expect(sum.text).toContain('"reimbursable"');
    const out = await tool(token, 'list_entries', { status: 'outstanding', type: 'receipt' });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text).count).toBeGreaterThan(0);
  });
});
