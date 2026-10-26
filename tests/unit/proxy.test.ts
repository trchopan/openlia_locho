import { describe, expect, it } from 'vitest';
import { SessionCookie, requestBytes, responseHeaders, safeError, upstreamHeaders } from '../../src/proxy';

describe('logical upstream request boundary', () => {
  it('does not forward browser cookies, hop headers, or spoofed proxy identity', () => {
    const headers = upstreamHeaders(new Headers({ Cookie: 'public=value', Host: 'public.example', Connection: 'x-hop', 'X-Hop': 'private', 'X-Forwarded-Host': 'spoofed', Range: 'bytes=1-3' }), 'https://public.example', 'scoped=token');
    expect([...headers.keys()]).toEqual(['cookie', 'range']);
    expect(headers.get('cookie')).toBe('scoped=token');
  });
  it('maps only independently validated same-origin clients to logical Origin', () => {
    expect(upstreamHeaders(new Headers(), 'https://public.example', '').has('origin')).toBe(false);
    expect(upstreamHeaders(new Headers(), 'https://public.example', '', true).get('origin')).toBe('http://workspace-ui');
    expect(() => upstreamHeaders(new Headers({ Origin: 'https://evil.example' }), 'https://public.example', '', true)).toThrow('foreignOrigin');
    expect(() => upstreamHeaders(new Headers({ 'Sec-Fetch-Site': 'cross-site' }), 'https://public.example', '', true)).toThrow('foreignOrigin');
  });
  it('retains application headers and maps a matching public Origin', () => {
    const headers = upstreamHeaders(new Headers({ Origin: 'https://public.example', 'Idempotency-Key': 'synthetic', 'Content-Type': 'multipart/form-data; boundary=x' }), 'https://public.example', '');
    expect(headers.get('origin')).toBe('http://workspace-ui');
    expect(headers.get('idempotency-key')).toBe('synthetic');
    expect(headers.get('content-type')).toContain('boundary=x');
  });
});

describe('response handling', () => {
  it('keeps upstream CSP unchanged and never caches private responses', () => {
    const headers = responseHeaders(new Headers({ 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'public', 'Set-Cookie': 'secret', 'Content-Length': '50' }), 'https://public.example');
    expect(headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.has('set-cookie')).toBe(false);
    expect(headers.has('content-length')).toBe(false);
  });
  it('maps logical redirects but refuses external and reserved destinations', () => {
    expect(responseHeaders(new Headers({ Location: 'http://workspace-ui/chat?q=x' }), 'https://public.example').get('location')).toBe('https://public.example/chat?q=x');
    expect(responseHeaders(new Headers({ Location: 'next' }), 'https://public.example', '/files/current').get('location')).toBe('https://public.example/files/next');
    expect(() => responseHeaders(new Headers({ Location: 'https://external.example' }), 'https://public.example')).toThrow('externalRedirect');
    expect(() => responseHeaders(new Headers({ Location: '/__locho/' }), 'https://public.example')).toThrow('reservedRedirect');
  });
  it('does not display arbitrary exception messages', () => {
    expect(safeError(new Error('password-or-ticket'))).toBe('unavailable');
    expect(safeError({ code: 'requestLimit' })).toBe('requestLimit');
  });
});

describe('bounded byte bodies', () => {
  it('preserves encoded binary and rejects oversized requests', async () => {
    expect(await requestBytes(new Request('https://public.example/', { method: 'POST', body: new Uint8Array([0, 255, 128]) }))).toEqual(new Uint8Array([0, 255, 128]));
    await expect(requestBytes(new Request('https://public.example/', { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) }))).rejects.toThrow('requestLimit');
  });
  it('reads and bounds POST bytes when Request.body is null but Blob bytes exist', async () => {
    const request = new Request('https://public.example/', { method: 'POST', body: new Uint8Array([0, 255, 128]) });
    Object.defineProperty(request, 'body', { value: null });
    expect(await requestBytes(request)).toEqual(new Uint8Array([0, 255, 128]));
    const oversized = new Request('https://public.example/', { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) });
    Object.defineProperty(oversized, 'body', { value: null });
    await expect(requestBytes(oversized)).rejects.toThrow('requestLimit');
  });
});

describe('ticket-scoped worker-memory cookie sessions', () => {
  const scope = { hostId: 'a'.repeat(64), service: 'workspace-ui', serviceType: 'tcp' as const };
  const token = 'A'.repeat(43);
  const replacement = 'B'.repeat(43);
  const field = (value = token, expiry = 'Max-Age=10') => `openlia_workspace_session=${value}; Path=/; HttpOnly; SameSite=Strict; ${expiry}`;
  const pairs = (value: string): ReadonlyArray<readonly [string, string]> => [['set-cookie', value]];

  it('reads the raw pair without a browser Headers/Response conversion', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture([['set-cookie', 'unrelated=value; Path=/'], ...pairs(field())], scope, 1, 1000);
    expect(cookie.header(scope, '/api/workspace/tree', 1001)).toBe(`openlia_workspace_session=${token}`);
    expect(cookie.header(scope, '/', 11000)).toBe('');
  });
  it('preserves Expires commas and gives Max-Age precedence', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field(token, 'Expires=Wed, 21 Oct 2037 07:28:00 GMT')), scope, 1, 1000);
    expect(cookie.header(scope, '/files/a.md', 1001)).not.toBe('');
    cookie.capture(pairs(field(token, 'Max-Age=2; Expires=Wed, 21 Oct 2015 07:28:00 GMT')), scope, 2, 1000);
    expect(cookie.header(scope, '/', 2999)).not.toBe('');
    expect(cookie.header(scope, '/', 3000)).toBe('');
  });
  it('caps excessively long expiry at 30 days', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field(token, 'Max-Age=999999999')), scope, 1, 1000);
    expect(cookie.header(scope, '/', 1000 + 30 * 86400 * 1000)).toBe('');
  });
  it('supports optional Secure on the encrypted logical-HTTP tunnel', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field() + '; Secure'), scope, 1, 1000);
    expect(cookie.header(scope, '/_serverFn/example', 1001)).not.toBe('');
  });
  it('replaces a session and processes empty/zero-age logout', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field()), scope, 1, 1000);
    cookie.capture(pairs(field(replacement)), scope, 2, 1000);
    expect(cookie.header(scope, '/', 1001)).toBe(`openlia_workspace_session=${replacement}`);
    cookie.capture(pairs(field('', 'Max-Age=0')), scope, 3, 1000);
    expect(cookie.header(scope, '/', 1001)).toBe('');
  });
  it('ignores out-of-order updates after replacement and logout', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field(replacement)), scope, 4, 1000);
    cookie.capture(pairs(field()), scope, 1, 1000);
    expect(cookie.header(scope, '/', 1001)).toBe(`openlia_workspace_session=${replacement}`);
    cookie.capture(pairs(field('', 'Max-Age=0')), scope, 5, 1000);
    cookie.capture(pairs(field()), scope, 2, 1000);
    expect(cookie.header(scope, '/', 1001)).toBe('');
  });
  it('does not let later read-only responses suppress an earlier login', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture([['content-type', 'application/json']], scope, 20, 1000);
    cookie.capture(pairs(field()), scope, 1, 1000);
    expect(cookie.header(scope, '/', 1001)).not.toBe('');
  });
  it('rejects ambiguous repeated session cookies atomically', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field()), scope, 1, 1000);
    expect(() => cookie.capture([...pairs(field()), ...pairs(field(replacement))], scope, 2, 1000)).toThrow('unsupportedCookie');
    expect(cookie.header(scope, '/', 1001)).toBe('');
    cookie.capture(pairs(field()), scope, 1, 1000);
    expect(cookie.header(scope, '/', 1001)).toBe('');
  });
  it.each([
    field() + '; Domain=external.example',
    field().replace('Path=/', 'Path=/api/'),
    field().replace('; HttpOnly', ''),
    field().replace('SameSite=Strict', 'SameSite=None'),
    field() + '; Path=/',
    field('invalid'),
    field(token, 'Max-Age=Infinity'),
    field(token, 'Max-Age=9007199254740992'),
    field(token, 'Expires=invalid'),
    field(token, 'Priority=High'),
  ])('rejects unsupported cookie attributes/values without retaining a session (%#)', (value) => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field()), scope, 1, 1000);
    expect(() => cookie.capture(pairs(value), scope, 2, 1000)).toThrow();
    expect(cookie.header(scope, '/', 1001)).toBe('');
  });
  it('never exposes a session to another ticket or the gateway control namespace', () => {
    const cookie = new SessionCookie(scope);
    cookie.capture(pairs(field()), scope, 1, 1000);
    for (const other of [{ ...scope, hostId: 'b'.repeat(64) }, { ...scope, service: 'other' }, { ...scope, serviceType: 'http' as const }]) {
      expect(() => cookie.header(other, '/', 1001)).toThrow('sessionScopeMismatch');
      expect(() => cookie.capture(pairs(field(replacement)), other, 2, 1000)).toThrow('sessionScopeMismatch');
    }
    for (const path of ['/__locho/', '//external.example/', '/\\external.example/']) expect(() => cookie.header(scope, path, 1001)).toThrow('sessionScopeMismatch');
    expect(cookie.header(scope, '/', 1001)).toBe(`openlia_workspace_session=${token}`);
  });
  it('clears memory explicitly without affecting another connection', () => {
    const cookie = new SessionCookie(scope);
    const other = new SessionCookie({ ...scope, hostId: 'b'.repeat(64) });
    cookie.capture(pairs(field()), scope, 1, 1000);
    cookie.clear();
    expect(cookie.header(scope, '/', 1001)).toBe('');
    expect(other.header({ ...scope, hostId: 'b'.repeat(64) }, '/', 1001)).toBe('');
  });
});
