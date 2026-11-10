import { describe, expect, it } from 'vitest';
import {
  appDomain,
  mxStatus,
  nsStatus,
  registrableDomain,
  routingStatus,
  suggestInboxSubdomain,
} from '../../src/shared/logic';

describe('inbox setup checks', () => {
  it('recognizes Cloudflare Email Routing MX records', () => {
    expect(
      mxStatus([
        { type: 15, data: '20 route1.mx.cloudflare.net.' },
        { type: 15, data: '8 route2.mx.cloudflare.net.' },
      ]),
    ).toEqual({ status: 'ok', hosts: ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'] });
    expect(mxStatus([{ type: 15, data: '10 in1-smtp.messagingengine.com.' }]).status).toBe('other');
    expect(mxStatus(undefined).status).toBe('missing');
    expect(mxStatus([{ type: 5, data: 'x.example.' }]).status).toBe('missing');
  });

  it('confirms routing from mail that arrived, and spots a mismatched name', () => {
    const addr = 'inbound@hsa.example.com';
    expect(routingStatus([], addr, 'hsa.example.com').status).toBe('waiting');
    expect(
      routingStatus(
        [{ to_addr: 'inbound@hsa.example.com', outcome: 'ignored', reason: 'empty_message' }],
        addr,
        'hsa.example.com',
      ).status,
    ).toBe('ok');
    expect(
      routingStatus(
        [{ to_addr: 'receipts@hsa.example.com', outcome: 'rejected', reason: 'unknown_recipient' }],
        addr,
        'hsa.example.com',
      ),
    ).toEqual({ status: 'mismatch', other: 'receipts@hsa.example.com' });
    // A rejection for another reason (e.g. paused) still proves the rule routes to the Worker.
    expect(
      routingStatus(
        [{ to_addr: 'inbound@hsa.example.com', outcome: 'rejected', reason: 'paused' }],
        addr,
        'hsa.example.com',
      ).status,
    ).toBe('ok');
  });
});

describe('the domain behind a hostname', () => {
  it('takes the last two labels for ordinary domains', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('hsa.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.org.')).toBe('example.org');
    expect(registrableDomain('HSA.Example.COM')).toBe('example.com');
  });

  it('keeps three labels under two-part suffixes like co.uk', () => {
    expect(registrableDomain('hsa.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('app.example.com.au')).toBe('example.com.au');
    expect(registrableDomain('co.uk')).toBeNull();
  });

  it('rejects things that are not domain names', () => {
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('192.168.1.10')).toBeNull();
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('not a domain')).toBeNull();
  });

  it('knows the app’s own domain only on a custom domain', () => {
    expect(appDomain('hsa-locker.someone.workers.dev')).toBeNull();
    expect(appDomain('localhost')).toBeNull();
    expect(appDomain('127.0.0.1')).toBeNull();
    expect(appDomain('hsa.example.com')).toBe('example.com');
    expect(appDomain('receipts.example.co.uk')).toBe('example.co.uk');
    expect(suggestInboxSubdomain('example.com')).toBe('hsa-in.example.com');
  });

  it('recognizes Cloudflare nameservers', () => {
    expect(
      nsStatus([
        { type: 2, data: 'ada.ns.cloudflare.com.' },
        { type: 2, data: 'bob.ns.cloudflare.com.' },
      ]).status,
    ).toBe('cloudflare');
    expect(nsStatus([{ type: 2, data: 'ns1.registrar.example.' }]).status).toBe('elsewhere');
    expect(nsStatus(undefined).status).toBe('unknown');
    expect(nsStatus([{ type: 6, data: 'soa' }]).status).toBe('unknown');
  });
});
