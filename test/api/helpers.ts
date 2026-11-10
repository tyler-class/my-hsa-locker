import { SELF } from 'cloudflare:test';

export const ORIGIN = 'https://hsa.test';
export const PASSWORD = 'correct horse battery staple';

export async function login(password = PASSWORD, ip = '203.0.113.1'): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: JSON.stringify({ password }),
  });
}

export function cookieFrom(res: Response): string {
  const set = res.headers.get('Set-Cookie') ?? '';
  return set.split(';')[0]!;
}

export async function session(): Promise<Api> {
  const res = await login(PASSWORD, `198.51.100.${Math.floor(Math.random() * 200)}`);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return new Api(cookieFrom(res));
}

export class Api {
  constructor(public cookie: string) {}
  async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await SELF.fetch(`${ORIGIN}/api${path}`, {
      method,
      headers: {
        Cookie: this.cookie,
        Origin: ORIGIN,
        ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: res.status, data: data as T };
  }
  get<T = unknown>(path: string) {
    return this.req<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.req<T>('POST', path, body ?? {});
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.req<T>('PATCH', path, body);
  }
  del<T = unknown>(path: string) {
    return this.req<T>('DELETE', path);
  }
}

/** Uploads raw bytes the way the app does. */
export async function upload(
  api: Api,
  bytes: Uint8Array | string,
  name: string,
  type = 'application/pdf',
): Promise<{
  status: number;
  data: { duplicate: boolean; document: { id: string; status: string } };
}> {
  const res = await SELF.fetch(`${ORIGIN}/api/documents`, {
    method: 'POST',
    headers: {
      Cookie: api.cookie,
      Origin: ORIGIN,
      'Content-Type': type,
      'X-File-Name': encodeURIComponent(name),
    },
    body: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
  });
  return { status: res.status, data: (await res.json()) as never };
}

/** A synthetic text-layer "PDF" whose fake model reply is embedded (see the fake provider). */
export function fakePdf(text: string, extraction: unknown): string {
  return `%PDF-1.7\n${text}\n${'Synthetic test document. '.repeat(10)}\nFAKE_EXTRACTION:${JSON.stringify(extraction)}\n`;
}

export function receiptExtraction(p: Partial<Record<string, unknown>> = {}) {
  return {
    document_type: 'Receipt',
    line_items: [
      {
        appointment_date: '2024-03-05',
        payment_date: '2024-03-05',
        patient_name: 'Sam Example',
        provider_name: 'Lakeside Clinic',
        description: 'Office visit',
        category: 'Doctor',
        amount: '45.00',
        card_last4: '1111',
        additional_notes: null,
        flag_for_review: false,
        confidence: 0.95,
        source_quote: 'Amount paid $45.00',
        ...p,
      },
    ],
  };
}
