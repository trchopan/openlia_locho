// Static hosting smoke only. No ticket, password, login or workspace requests.
import { chromium, firefox, webkit } from '@playwright/test';

const report = { ok: false, browsers: [] };
let stage = 'origin';
let browser;
function check(value, code = 'checkFailed') { if (!value) throw new Error(code); }
try {
  const configured = process.env.OPENLIA_HOSTING_BASE_URL;
  check(configured?.trim(), 'hostingBaseUrlRequired');
  let url;
  try { url = new URL(configured); } catch { throw new Error('unsupportedHostingOrigin'); }
  check(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'), 'unsupportedHostingOrigin');
  check(url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'unsupportedHostingOrigin');
  const base = url.origin;
  const get = (path, options = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...options });
  stage = 'controlHeaders';
  const control = await get('/__locho/');
  check(control.status === 200 && control.headers.get('cache-control') === 'no-store');
  check(control.headers.get('referrer-policy') === 'no-referrer');
  check(control.headers.get('x-content-type-options') === 'nosniff');
  check(control.headers.get('content-security-policy')?.includes("script-src 'self' 'wasm-unsafe-eval'"));
  stage = 'workerHeaders';
  const worker = await get('/__locho/sw.js');
  check(worker.status === 200 && worker.headers.get('service-worker-allowed') === '/');
  check(/(?:application|text)\/javascript/.test(worker.headers.get('content-type') ?? ''));
  check(worker.headers.get('cache-control') === 'no-store');
  const workerSource = await worker.text();
  const wasmPath = workerSource.match(/\/__locho\/assets\/[A-Za-z0-9_-]+\.wasm/)?.[0];
  check(wasmPath);
  stage = 'wasmHeaders';
  const wasm = await get(wasmPath, { method: 'HEAD' });
  check(wasm.status === 200 && wasm.headers.get('content-type')?.split(';')[0] === 'application/wasm');
  stage = 'noPrivateFallback';
  for (const path of ['/api/auth/session', '/health', '/__locho/missing.js']) {
    check((await get(path)).status === 404);
  }
  stage = 'rootRedirect';
  const root = await get('/');
  check(root.status === 302 && root.headers.get('location') === '/__locho/');

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    stage = `${name}:workerScopeAndWasm`;
    browser = await engine.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/__locho/`);
    await page.getByRole('status').filter({ hasText: 'Ready.' }).waitFor({ timeout: 30_000 });
    const state = await page.evaluate(async (wasmPath) => {
      const registration = await navigator.serviceWorker.ready;
      await WebAssembly.compileStreaming(fetch(wasmPath));
      return { controlled: !!navigator.serviceWorker.controller, scope: new URL(registration.scope).pathname };
    }, wasmPath);
    check(state.controlled && state.scope === '/');
    report.browsers.push({ browser: name, ok: true, rootScope: true, wasmCompiled: true });
    await context.close();
    await browser.close(); browser = undefined;
  }
  report.ok = true;
} catch (error) {
  report.failedStage = stage;
  if (stage === 'origin' && ['hostingBaseUrlRequired', 'unsupportedHostingOrigin'].includes(error?.message)) {
    report.configurationError = error.message;
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
