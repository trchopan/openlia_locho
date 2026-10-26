/// <reference lib="webworker" />
import { initializeLocho, LochoClient, LochoTicket, type LochoRequestOptions } from 'locho_web';
import wasmUrl from 'locho_web/wasm?url';
import { AUTHORITY, CONTROL, SessionCookie, requestBytes, responseHeaders, safeError, upstreamHeaders, type SessionScope } from './proxy';

const sw = globalThis as unknown as ServiceWorkerGlobalScope;
let client: LochoClient | undefined;
let connecting = false;
let authRequired = false;
let generation = 0;
let startup: AbortController | undefined;
let cookie: SessionCookie | undefined;
let scope: SessionScope | undefined;
let requestRevision = 0;
const clients = new Map<string, number>();

sw.addEventListener('install', (event) => event.waitUntil(sw.skipWaiting()));
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));
sw.addEventListener('message', (event) => {
  const source = event.source as Client | null;
  if (!source || new URL(source.url).origin !== sw.location.origin || !new URL(source.url).pathname.startsWith('/__locho/')) return;
  const port = event.ports[0];
  if (!port) return;
  event.waitUntil((async () => {
    try {
      if (event.data.type === 'status') {
        await sw.clients.claim();
        port.postMessage({ ok: true, connected: !!client, authRequired, state: client?.status.state ?? 'closed' });
        return;
      }
      if (event.data.type === 'disconnect') {
        generation++;
        startup?.abort();
        cookie?.clear(); cookie = undefined; scope = undefined;
        const old = client; client = undefined;
        await old?.close();
        port.postMessage({ ok: true }); return;
      }
      if (event.data.type !== 'connect') throw new Error('unsupportedCommand');
      if (client || connecting) throw new Error('alreadyConnected');
      connecting = true;
      const epoch = ++generation;
      const abort = new AbortController();
      startup = abort;
      const timer = setTimeout(() => abort.abort(), 45_000);
      let pending: LochoClient | undefined;
      try {
        const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some((window) => !new URL(window.url).pathname.startsWith(CONTROL))) throw new Error('oldWorkspaceTabs');
        await initializeLocho(wasmUrl);
        const ticket = await LochoTicket.parse(event.data.ticket);
        if (ticket.metadata.service !== 'workspace-ui' || ticket.metadata.serviceType !== 'tcp') throw new Error('wrongService');
        pending = await LochoClient.connect({ ticket, http: { authority: AUTHORITY }, signal: abort.signal });
        const health = await pending.fetch('/health', { signal: abort.signal });
        const value = await health.json();
        if (!health.ok || value.service !== 'workspace-ui' || value.ok !== true) throw new Error('wrongUpstream');
        const sessionResponse = await pending.fetch('/api/auth/session', { signal: abort.signal });
        const session = await sessionResponse.json();
        if (!sessionResponse.ok || typeof session.auth_required !== 'boolean') throw new Error('wrongUpstream');
        if (epoch !== generation || abort.signal.aborted) throw new Error('cancelled');
        clients.clear();
        cookie?.clear();
        scope = Object.freeze({ hostId: ticket.metadata.hostId, service: ticket.metadata.service, serviceType: ticket.metadata.serviceType });
        cookie = new SessionCookie(scope);
        authRequired = session.auth_required;
        client = pending; pending = undefined;
        port.postMessage({ ok: true, authRequired });
      } finally { clearTimeout(timer); startup = undefined; connecting = false; await pending?.close(); }
    } catch (error) {
      port.postMessage({ ok: false, code: safeError(error) });
    } finally { port.close(); }
  })());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith(CONTROL)) {
    // Explicitly serve the trusted control assets from the static host while
    // keeping the navigation under worker control (not an upstream fallback).
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(proxy(event));
});

function unavailable(request: Request, code: string, status = 503) {
  if (request.mode === 'navigate') return Response.redirect(new URL(CONTROL, sw.location.origin).href, 302);
  return Response.json({ ok: false, error: code, interrupted_mutation: !['GET', 'HEAD'].includes(request.method) }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

async function proxy(event: FetchEvent): Promise<Response> {
  const request = event.request;
  const current = client;
  const currentCookie = cookie;
  const currentScope = scope;
  const epoch = generation;
  if (!current || !currentCookie || !currentScope) return unavailable(request, 'reconnectRequired');
  const revision = ++requestRevision;
  try {
    let verifiedSource = false;
    if (request.mode === 'navigate') {
      // Do not turn a cross-origin form POST into an authenticated tunnel call.
      // Current Workspace UI mutations use same-origin fetch/server functions.
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('foreignOrigin');
      // Navigations keep native root paths. Old documents may never join a new
      // connection after a host switch, even if their requests finish late.
      if (event.clientId && clients.has(event.clientId) && clients.get(event.clientId) !== epoch) return unavailable(request, 'staleClient');
      if (event.resultingClientId) clients.set(event.resultingClientId, epoch);
    } else if (!event.clientId || clients.get(event.clientId) !== epoch) {
      return unavailable(request, 'unpairedClient');
    } else {
      const source = await sw.clients.get(event.clientId);
      verifiedSource = !!source && new URL(source.url).origin === sw.location.origin;
      if (!verifiedSource) return unavailable(request, 'unpairedClient');
    }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) throw new Error('unsupportedMethod');
    const url = new URL(request.url);
    const body = await requestBytes(request);
    if (epoch !== generation) return unavailable(request, 'staleClient');
    const { response, upstreamHeaders: rawHeaders } = await current.fetchStreamWithMetadata(url.pathname + url.search, {
      method: request.method as LochoRequestOptions['method'],
      headers: upstreamHeaders(request.headers, sw.location.origin, currentCookie.header(currentScope, url.pathname), verifiedSource),
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
      setupTimeoutMs: 30_000,
      idleTimeoutMs: 75_000,
    });
    if (epoch !== generation) { await response.body?.cancel(); return unavailable(request, 'staleClient'); }
    let headers: Headers;
    try {
      currentCookie.capture(rawHeaders, currentScope, revision);
      headers = responseHeaders(response.headers, sw.location.origin, url.pathname + url.search);
    } catch (error) { await response.body?.cancel(); throw error; }
    if (!response.body) return new Response(null, { status: response.status, headers });
    // Retain fetch-event ownership for the full stream, not just until headers.
    let finished!: () => void;
    const lifetime = new Promise<void>((resolve) => { finished = resolve; });
    event.waitUntil(lifetime);
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (epoch !== generation) throw new Error('staleClient');
          const result = await reader.read();
          if (epoch !== generation) throw new Error('staleClient');
          if (result.done) { controller.close(); reader.releaseLock(); finished(); }
          else controller.enqueue(result.value);
        } catch {
          controller.error(new Error('Tunnel response interrupted; outcome may be unknown.'));
          await reader.cancel().catch(() => {});
          reader.releaseLock(); finished();
        }
      },
      async cancel() { try { await reader.cancel(); } finally { reader.releaseLock(); finished(); } },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: response.status, headers });
  } catch (error) {
    const code = safeError(error);
    return unavailable(request, code, code === 'requestLimit' ? 413 : code === 'foreignOrigin' ? 403 : 502);
  }
}
