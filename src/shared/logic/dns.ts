// Checking the inbox setup from what's publicly visible: the subdomain's MX records (from a
// DNS-over-HTTPS answer) and the inbox log (mail that actually arrived).

export type MxStatus = 'ok' | 'missing' | 'other';

/** Cloudflare Email Routing's MX hosts look like route1.mx.cloudflare.net. */
export function mxStatus(answers: { type?: number; data?: string }[] | undefined): {
  status: MxStatus;
  hosts: string[];
} {
  const hosts = (answers ?? [])
    .filter((a) => a.type === 15 && typeof a.data === 'string')
    .map((a) => a.data!.trim().split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase());
  if (!hosts.length) return { status: 'missing', hosts };
  return {
    status: hosts.some((h) => /(^|\.)mx\.cloudflare\.net$/.test(h)) ? 'ok' : 'other',
    hosts,
  };
}

export type RoutingStatus = 'ok' | 'waiting' | 'mismatch';

/**
 * Whether the routing rule works, judged from the inbox log (newest first): mail to the current
 * address arrived → ok; only mail to other names at the subdomain (rejected as unknown) →
 * mismatch, with the name Cloudflare is actually routing; nothing yet → waiting.
 */
export function routingStatus(
  log: { to_addr: string | null; outcome: string; reason: string | null }[],
  address: string,
  domain: string,
): { status: RoutingStatus; other: string | null } {
  const addr = address.toLowerCase();
  const atDomain = log.filter((l) => l.to_addr?.toLowerCase().endsWith(`@${domain.toLowerCase()}`));
  if (atDomain.some((l) => l.to_addr?.toLowerCase() === addr && l.reason !== 'unknown_recipient'))
    return { status: 'ok', other: null };
  const wrong = atDomain.find(
    (l) =>
      l.outcome === 'rejected' &&
      l.reason === 'unknown_recipient' &&
      l.to_addr?.toLowerCase() !== addr,
  );
  return wrong ? { status: 'mismatch', other: wrong.to_addr } : { status: 'waiting', other: null };
}

/**
 * Two-label public suffixes where the registrable domain is three labels (example.co.uk).
 * Not the full Public Suffix List: the result is only a suggestion the person can edit.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'co.za',
  'org.za',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'co.in',
  'net.in',
  'org.in',
  'co.il',
  'com.br',
  'net.br',
  'com.mx',
  'com.ar',
  'com.co',
  'com.sg',
  'com.my',
  'com.hk',
  'com.tw',
  'com.cn',
  'com.tr',
  'com.ph',
  'co.id',
  'co.th',
]);

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The domain someone registered, from a hostname: app.example.com → example.com,
 * hsa.example.co.uk → example.co.uk. Null for IPs, single labels and invalid names.
 */
export function registrableDomain(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(h)) return null;
  const labels = h.split('.');
  const n = TWO_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.length < n ? null : labels.slice(-n).join('.');
}

/**
 * The domain the app itself is served on, when that tells us something: a Worker custom domain
 * or route is necessarily on this Cloudflare account. Null on workers.dev and local hosts.
 */
export function appDomain(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.workers.dev')) return null;
  return registrableDomain(h);
}

/** Where to receive mail on a domain: a new subdomain, so the domain's own mail is untouched. */
export function suggestInboxSubdomain(domain: string): string {
  return `hsa-in.${domain}`;
}

export type NsStatus = 'cloudflare' | 'elsewhere' | 'unknown';

/** Whether a domain's nameservers (a DNS-over-HTTPS NS answer) are Cloudflare's. */
export function nsStatus(answers: { type?: number; data?: string }[] | undefined): {
  status: NsStatus;
  ns: string[];
} {
  const ns = (answers ?? [])
    .filter((a) => a.type === 2 && typeof a.data === 'string')
    .map((a) => a.data!.trim().replace(/\.$/, '').toLowerCase());
  if (!ns.length) return { status: 'unknown', ns };
  return {
    status: ns.every((h) => h.endsWith('.ns.cloudflare.com')) ? 'cloudflare' : 'elsewhere',
    ns,
  };
}
