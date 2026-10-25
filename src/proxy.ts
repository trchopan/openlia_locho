export const CONTROL = '/__locho/';
export const AUTHORITY = 'workspace-ui';
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const stripped = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'upgrade', 'expect', 'accept-encoding', 'cookie', 'origin', 'referer',
  'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for',
]);

export interface SessionScope {
  readonly hostId: string;
  readonly service: string;
  readonly serviceType: 'http' | 'tcp';
}

type HeaderPairs = ReadonlyArray<readonly [string, string]>;
const SESSION_NAME = 'openlia_workspace_session';
const MAX_SESSION_MS = 30 * 86400 * 1000;
const scopeKey = (scope: SessionScope) => JSON.stringify([scope.hostId, scope.service, scope.serviceType]);

/** OpenLia-specific worker-memory session, not a general browser cookie jar. */
export class SessionCookie {
  private value = '';
  private expires = 0;
  private revision = 0;
  private readonly key: string;

  constructor(scope: SessionScope) {
    if (scope.service !== 'workspace-ui' || scope.serviceType !== 'tcp') throw new Error('unsupportedService');
    this.key = scopeKey(scope);
  }

  private checkScope(scope: SessionScope) {
    if (scopeKey(scope) !== this.key) throw new Error('sessionScopeMismatch');
  }

  capture(headers: HeaderPairs, scope: SessionScope, revision: number, now = Date.now()) {
    this.checkScope(scope);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('unsupportedCookie');
    if (revision <= this.revision) return;
    // Work on each raw pair separately: Headers would merge repeated values,
    // and splitting on commas would corrupt an Expires attribute.
    const fields = headers.filter(([name, value]) =>
      name.toLowerCase() === 'set-cookie' && value.split('=', 1)[0].trim() === SESSION_NAME,
    );
    if (!fields.length) return;
    this.revision = revision;
    this.clear();
    // Different values/scopes for the same session in one response are ambiguous.
    if (fields.length !== 1 || fields[0][1].length > 2048) throw new Error('unsupportedCookie');
    const [pair, ...attributes] = fields[0][1].split(';').map((part) => part.trim());
    const value = pair.slice(pair.indexOf('=') + 1);
    const parsed = new Map<string, string>();
    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const name = (index < 0 ? attribute : attribute.slice(0, index)).toLowerCase();
      const content = index < 0 ? '' : attribute.slice(index + 1);
      if (name === 'domain') throw new Error('unsupportedCookieDomain');
      if (!['path', 'max-age', 'expires', 'secure', 'httponly', 'samesite'].includes(name) || parsed.has(name)) throw new Error('unsupportedCookie');
      parsed.set(name, content);
    }
    if (parsed.get('path') !== '/' || parsed.get('httponly') !== '' || parsed.get('samesite')?.toLowerCase() !== 'strict') throw new Error('unsupportedCookie');
    // Secure is optional: OpenLia's upstream is HTTP inside the encrypted Locho
    // TCP connection. Neither HttpOnly nor SameSite becomes a native browser rule.
    if (parsed.has('secure') && parsed.get('secure') !== '') throw new Error('unsupportedCookie');
    let expires: number;
    if (parsed.has('max-age')) {
      const age = parsed.get('max-age')!;
      if (!/^-?\d+$/.test(age) || !Number.isSafeInteger(Number(age))) throw new Error('unsupportedCookie');
      expires = now + Math.min(Number(age) * 1000, MAX_SESSION_MS);
    } else {
      expires = Date.parse(parsed.get('expires') ?? '');
      if (!Number.isFinite(expires)) throw new Error('unsupportedCookie');
    }
    if (expires <= now) return;
    if (!/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new Error('unsupportedCookie');
    this.value = `${SESSION_NAME}=${value}`;
    this.expires = Math.min(expires, now + MAX_SESSION_MS);
  }

  header(scope: SessionScope, path: string, now = Date.now()) {
    this.checkScope(scope);
    const target = new URL(path, `http://${AUTHORITY}`);
    if (!path.startsWith('/') || path.startsWith('//') || target.origin !== `http://${AUTHORITY}` || target.pathname.startsWith(CONTROL)) throw new Error('sessionScopeMismatch');
    if (now >= this.expires) this.clear();
    return this.value;
  }

  // Keep the revision barrier so late responses cannot undo deletion/logout.
  clear() { this.value = ''; this.expires = 0; }
}

export function upstreamHeaders(input: Headers, publicOrigin: string, cookie: string, verifiedSameOriginClient = false) {
  const origin = input.get('origin');
  const fetchSite = input.get('sec-fetch-site');
  // Preserve the backend's origin check semantics: foreign-origin calls fail,
  // rather than receiving a rewritten, trusted Origin.
  if (origin && origin !== publicOrigin) throw new Error('foreignOrigin');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new Error('foreignOrigin');
  const headers = new Headers();
  const nominated = new Set((input.get('connection') ?? '').toLowerCase().split(',').map((x) => x.trim()));
  for (const [name, value] of input) {
    if (!stripped.has(name) && !nominated.has(name) && !name.startsWith('sec-')) headers.set(name, value);
  }
  // Fetch metadata / Origin can be absent at service-worker interception time.
  // Only supply a logical Origin when the caller independently verified the
  // browser Client's URL AND its current-connection binding.
  if (origin || verifiedSameOriginClient) headers.set('origin', `http://${AUTHORITY}`);
  // TanStack also validates same-origin GET server functions using this browser-
  // supplied provenance. Preserve it; do not fabricate a successful check.
  if (fetchSite) headers.set('sec-fetch-site', fetchSite);
  if (cookie) headers.set('cookie', cookie);
  return headers;
}

/** Read encoded multipart/binary bytes, not FormData, with a bounded allocation. */
export async function requestBytes(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new Error('requestLimit');
  if (!request.body) {
    // Firefox can expose a null FetchEvent Request.body while blob()/arrayBuffer()
    // still contain POST bytes. Check the Blob size before allocating our buffer.
    const blob = await request.blob();
    if (blob.size > MAX_REQUEST_BYTES) throw new Error('requestLimit');
    return blob.size ? new Uint8Array(await blob.arrayBuffer()) : undefined;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error('requestLimit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function responseHeaders(input: Headers, publicOrigin: string, requestPath = '/') {
  const headers = new Headers(input);
  for (const name of ['set-cookie', 'set-cookie2', 'content-length', 'content-encoding', 'connection', 'transfer-encoding', 'clear-site-data', 'service-worker-allowed']) headers.delete(name);
  // Never cache authenticated UI, assets or synthetic tunnel responses in this milestone.
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  const location = headers.get('location');
  if (location) {
    if (location.startsWith('/') && !location.startsWith('//')) {
      if (new URL(location, publicOrigin).pathname.startsWith(CONTROL)) throw new Error('reservedRedirect');
    } else {
      const target = new URL(location, new URL(requestPath, `http://${AUTHORITY}`));
      if (target.origin !== `http://${AUTHORITY}`) throw new Error('externalRedirect');
      if (target.pathname.startsWith(CONTROL)) throw new Error('reservedRedirect');
      headers.set('location', `${publicOrigin}${target.pathname}${target.search}${target.hash}`);
    }
  }
  return headers;
}

export function safeError(error: unknown) {
  const value = typeof error === 'object' && error && 'code' in error ? String(error.code) : error instanceof Error ? error.message : '';
  const allowed = new Set([
    'invalidTicket', 'wrongService', 'wrongUpstream', 'alreadyConnected', 'oldWorkspaceTabs',
    'cancelled', 'startupTimeout', 'timeout', 'setupTimeout', 'idleTimeout', 'resourceLimit',
    'requestLimit', 'responseLimit', 'foreignOrigin', 'externalRedirect', 'reservedRedirect',
    'unsupportedCookieDomain', 'unsupportedCookie', 'sessionScopeMismatch', 'unsupportedMethod', 'unsupportedCommand',
    'unsupportedService', 'transport', 'closed', 'invalidHeader', 'invalidResponse',
  ]);
  return allowed.has(value) ? value : 'unavailable';
}
