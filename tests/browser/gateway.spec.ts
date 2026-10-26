import { test, expect, type Page } from '@playwright/test';
import { startFixture, password } from './fixture';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let fixture: Awaited<ReturnType<typeof startFixture>>;
test.beforeAll(async ({ browser }) => {
  fixture = await startFixture();
  console.log('Browser runtime:', browser.browserType().name(), browser.version());
});
test.afterAll(async () => { await fixture?.cleanup(); });

async function connect(page: Page) {
  await page.goto('/__locho/');
  await expect(page.getByRole('status')).toContainText('Ready.');
  await page.getByLabel('Workspace UI ticket').fill(fixture.ticket);
  await page.getByLabel('I trust').check();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Connected.', { timeout: 60_000 });
  await expect(page.getByRole('status')).toContainText('Workspace UI to sign in');
  await page.getByRole('link', { name: 'Open deployed Workspace UI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
}

test('real deployed HTML/assets hydrate without a public upstream fallback', async ({ page }) => {
  const privateResponses: { status: number; worker: boolean }[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === 'http://127.0.0.1:4173' && !url.pathname.startsWith('/__locho/')) privateResponses.push({ status: response.status(), worker: response.fromServiceWorker() });
  });
  await connect(page);
  expect(privateResponses.length).toBeGreaterThan(2);
  expect(privateResponses.every((r) => r.worker)).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.goto('/files/probe.md');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.goto('/__locho/');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Disconnected;');
  const result = await page.evaluate(async () => {
    const r = await fetch('/api/auth/session');
    return { status: r.status, value: await r.json().catch(() => null) };
  });
  expect(result.status).toBe(503);
  await page.goto('/');
  await expect(page).toHaveURL(/\/__locho\/$/);
});

async function login(page: Page) {
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();
}

async function assertNoCredentialLeak(page: Page) {
  const snapshot = await page.evaluate(async () => ({
    local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage),
    cookies: document.cookie, caches: await caches.keys(), databases: await indexedDB.databases(),
  }));
  expect(fixture.hasCredentialLeak(JSON.stringify(snapshot))).toBe(false);
  expect(snapshot.cookies.includes('openlia_workspace_session')).toBe(false);
  expect(snapshot.caches.length).toBe(0);
  expect(snapshot.databases.length).toBe(0);
}

test('authenticates the deployed UI, saves a document, reloads and logs out without exposing sessions', async ({ page, context }) => {
  await connect(page);
  // Response still filters Set-Cookie; successful authentication below proves
  // the worker uses beta.3 upstream metadata rather than Response.headers.
  const synthetic = await page.evaluate(() => ({
    raw: new Headers({ 'Set-Cookie': 'synthetic=value' }).has('Set-Cookie'),
    response: new Response('', { headers: { 'Set-Cookie': 'synthetic=value' } }).headers.has('Set-Cookie'),
  }));
  expect(synthetic).toEqual({ raw: true, response: false });
  await login(page);
  const auth = await page.evaluate(async () => {
    const session = await fetch('/api/auth/session').then((r) => r.json());
    const tree = await fetch('/api/workspace/tree');
    return { required: session.auth_required, authenticated: session.authenticated, treeStatus: tree.status };
  });
  expect(auth).toEqual({ required: true, authenticated: true, treeStatus: 200 });
  expect(fixture.observedSession()).toBe(true);
  expect((await context.cookies()).some((cookie) => cookie.name === 'openlia_workspace_session')).toBe(false);
  await assertNoCredentialLeak(page);
  await page.getByRole('button', { name: 'probe.md', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Markdown preview' })).toContainText('Original content.');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const updated = '# Synthetic feasibility document\n\nSaved through authenticated Locho.\n';
  await page.locator('.cm-content[contenteditable="true"]').fill(updated);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await expect.poll(() => readFile(join(fixture.root, 'workspace', 'probe.md'), 'utf8')).toBe(updated);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('article', { name: 'Markdown preview' })).toContainText('Saved through authenticated Locho.');
  await assertNoCredentialLeak(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  const afterLogout = await page.evaluate(async () => ({
    session: await fetch('/api/auth/session').then((r) => r.json()),
    treeStatus: (await fetch('/api/workspace/tree')).status,
  }));
  expect(afterLogout.session.authenticated).toBe(false);
  expect(afterLogout.treeStatus).toBe(401);
  await assertNoCredentialLeak(page);
});

test('a rejected password never creates an authenticated session', async ({ page }) => {
  await connect(page);
  await page.getByLabel('Password', { exact: true }).fill('wrong-synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('password');
  expect(await page.evaluate(async () => (await fetch('/api/auth/session').then((r) => r.json())).authenticated)).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/workspace/tree')).status)).toBe(401);
});

test('expires the worker-managed session without putting it into browser storage', async ({ page }) => {
  await connect(page);
  await login(page);
  expect(await page.evaluate(async () => (await fetch('/__probe/session-update?kind=expire')).status)).toBe(200);
  await expect.poll(() => page.evaluate(async () => (await fetch('/__probe/session-present').then((r) => r.json())).present), {
    timeout: 10_000, intervals: [250, 500, 1000],
  }).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/workspace/tree')).status)).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await assertNoCredentialLeak(page);
});

test('fails closed on ambiguous repeated session cookies', async ({ page }) => {
  await connect(page);
  await login(page);
  const update = await page.evaluate(async () => {
    const r = await fetch('/__probe/session-update?kind=ambiguous');
    return { status: r.status, code: (await r.json()).error };
  });
  expect(update).toEqual({ status: 502, code: 'unsupportedCookie' });
  expect(await page.evaluate(async () => (await fetch('/__probe/session-present').then((r) => r.json())).present)).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/workspace/tree')).status)).toBe(401);
  await assertNoCredentialLeak(page);
});

test('a late cookie update cannot resurrect a logged-out session', async ({ page }) => {
  await connect(page);
  await login(page);
  // Keep the request pending in the document, but never expose raw metadata.
  await page.evaluate(() => {
    (window as unknown as { lateUpdate: Promise<number> }).lateUpdate = fetch('/__probe/session-update?kind=delayed').then(async (r) => { await r.body?.cancel(); return r.status; });
  });
  await expect.poll(() => fixture.stats.pendingCookie).toBe(true);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  fixture.releaseCookie();
  expect(await page.evaluate(() => (window as unknown as { lateUpdate: Promise<number> }).lateUpdate)).toBe(200);
  expect(await page.evaluate(async () => (await fetch('/__probe/session-present').then((r) => r.json())).present)).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/workspace/tree')).status)).toBe(401);
  await assertNoCredentialLeak(page);
});

test('disconnect and re-pair discard the old session even for the same ticket', async ({ page }) => {
  await connect(page);
  await login(page);
  await page.goto('/__locho/');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Disconnected;');
  await connect(page);
  expect(await page.evaluate(async () => (await fetch('/api/auth/session').then((r) => r.json())).authenticated)).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/__probe/session-present').then((r) => r.json())).present)).toBe(false);
  expect(await page.evaluate(async () => (await fetch('/api/workspace/tree')).status)).toBe(401);
  await assertNoCredentialLeak(page);
});

test('carries incremental SSE, encoded multipart, binary/range/large responses and redirects', async ({ page }) => {
  await connect(page);
  const result = await page.evaluate(async () => {
    const events = await fetch('/__probe/events');
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const rest: string[] = [];
    for (;;) { const r = await reader.read(); if (r.done) break; rest.push(new TextDecoder().decode(r.value)); }
    const form = new FormData();
    form.set('title', 'synthetic upload');
    form.set('file', new Blob([new Uint8Array([0, 255, 128, 1])]), 'probe.bin');
    const echo = await fetch('/__probe/echo', { method: 'POST', body: form });
    const encoded = new Uint8Array(await echo.arrayBuffer());
    const range = await fetch('/__probe/binary', { headers: { Range: 'bytes=1-3' } });
    const redirected = await fetch('/__probe/redirect');
    const large = await fetch('/__probe/large');
    let largeBytes = 0;
    const bigReader = large.body!.getReader();
    for (;;) { const r = await bigReader.read(); if (r.done) break; largeBytes += r.value.byteLength; }
    const external = await fetch('/__probe/external-redirect');
    return {
      first, rest: rest.join(''), multipart: echo.headers.get('x-received-content-type'),
      includesFilename: new TextDecoder().decode(encoded).includes('probe.bin'),
      includesBinary: encoded.some((v, i) => v === 255 && encoded[i + 1] === 128),
      range: { status: range.status, bytes: [...new Uint8Array(await range.arrayBuffer())], header: range.headers.get('content-range') },
      redirected: [...new Uint8Array(await redirected.arrayBuffer())], largeBytes,
      external: { status: external.status, code: (await external.json()).error },
    };
  });
  expect(result.first).toContain(': connected');
  expect(result.first).not.toContain('synthetic');
  expect(result.rest).toContain('synthetic');
  expect(result.multipart).toContain('multipart/form-data; boundary=');
  expect(result.includesFilename && result.includesBinary).toBe(true);
  expect(result.range).toEqual({ status: 206, bytes: [255, 1, 128], header: 'bytes 1-3/6' });
  expect(result.redirected).toEqual([0, 255, 1, 128, 2, 127]);
  expect(result.largeBytes).toBe(9 * 1024 * 1024);
  expect(result.external).toEqual({ status: 502, code: 'externalRedirect' });
});

test('cancels streams, bounds uploads and never replays a lost mutation', async ({ page }) => {
  await connect(page);
  const before = { ...fixture.stats };
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const stream = await fetch('/__probe/events?hold=1', { signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    const oversized = await fetch('/__probe/echo', { method: 'POST', body: new Uint8Array(4 * 1024 * 1024 + 1) });
    let lost = false;
    try {
      const r = await fetch('/__probe/mutation?lose=1', { method: 'POST', body: 'synthetic mutation' });
      lost = !r.ok;
      await r.body?.cancel();
    } catch { lost = true; }
    return { oversized: oversized.status, lost };
  });
  expect(result).toEqual({ oversized: 413, lost: true });
  await expect.poll(() => fixture.stats.streams).toBe(0);
  expect(fixture.stats.mutations - before.mutations).toBe(1);
  expect(fixture.stats.received - before.received).toBe(1);
});

test('worker termination returns safely to pairing without persisting credentials', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Explicit service-worker termination requires Chromium CDP; other engines are not claimed.');
  await connect(page);
  await login(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.goto('/');
  await expect(page).toHaveURL(/\/__locho\/$/);
  await expect(page.getByRole('status')).toContainText('Ready.');
  await expect(page.getByLabel('Workspace UI ticket')).toHaveValue('');
  const storage = await page.evaluate(async ({ ticket, password }) => {
    const persisted = [JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
    return {
      credentialsPersisted: persisted.some((value) => value.includes(ticket) || value.includes(password) || value.includes('openlia_workspace_session')),
      caches: (await caches.keys()).length, databases: (await indexedDB.databases()).length,
    };
  }, { ticket: fixture.ticket, password });
  // The upstream UI may write its own scroll-restoration state. That is not
  // credential persistence by this gateway.
  expect(storage).toEqual({ credentialsPersisted: false, caches: 0, databases: 0 });
});

test('does not replay a mutation while the host is stopped and recovers after restart', async ({ page }) => {
  await connect(page);
  const before = fixture.stats.mutations;
  await fixture.stopHost();
  try {
    const failed = await page.evaluate(async () => {
      try {
        const r = await fetch('/__probe/mutation', { method: 'POST', body: 'must not replay' });
        await r.body?.cancel();
        return !r.ok;
      } catch { return true; }
    });
    expect(failed).toBe(true);
  } finally { fixture.restartHost(); }
  await expect.poll(async () => page.evaluate(async () => {
    try { return (await fetch('/health')).ok; } catch { return false; }
  }), { timeout: 90_000, intervals: [1000, 2000, 5000] }).toBe(true);
  expect(fixture.stats.mutations).toBe(before);
});
