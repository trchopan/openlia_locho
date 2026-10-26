// Read-only application smoke: authenticate, inspect health/tree, reload, logout.
// Password comes from stdin; tickets and sessions are never written or printed.
import { chromium, firefox, webkit } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = process.env.OPENLIA_LIVE_CONFIG ?? join(homedir(), '.config/openlia/dev/config.toml');
const engines = { chromium, firefox, webkit };
const requested = (process.env.OPENLIA_LIVE_BROWSERS ?? 'chromium,firefox,webkit').split(',');
const sshOptions = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { ok: false, workspaceEditsAttempted: false, browsers: [] };
let stage = 'configuration';
let server;
let browser;
let page;
let password = '';

function check(condition, code) { if (!condition) throw new Error(code); }
function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
async function privatePython(code, args = []) {
  const result = await exec('python3', ['-c', code, ...args], { timeout: 15_000 });
  return JSON.parse(result.stdout);
}

try {
  const selected = await privatePython(`import tomllib,json,sys
x=tomllib.load(open(sys.argv[1],'rb'))
o=x['openlia']
print(json.dumps({k:o.get(k) for k in ['mode','target','root','project']}))`, [config]);
  check(selected.mode === 'ssh' && /^[A-Za-z0-9_.@:-]+$/.test(selected.target) && /^[A-Za-z0-9_-]+$/.test(selected.project), 'unsupportedDeployment');
  check(requested.length > 0 && requested.every((name) => Object.hasOwn(engines, name)), 'unsupportedBrowser');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks);
  password = input.toString('utf8').replace(/\r?\n$/, '');
  input.fill(0); chunks.forEach((chunk) => chunk.fill(0));
  check(password.length > 0, 'passwordRequiredOnStdin');

  stage = 'ticketExport';
  // SSH stdout is captured in this process, never inherited by the terminal.
  const ticketCode = `import json,subprocess
p=${JSON.stringify(selected.project)}
r=subprocess.run(['docker','ps','--filter','label=com.docker.compose.project='+p,'--filter','label=com.docker.compose.service=locho-host','--format','{{.ID}}'],capture_output=True,text=True,timeout=15)
ids=r.stdout.split()
if r.returncode or len(ids)!=1: print(json.dumps({'ok':False}));raise SystemExit(0)
c=ids[0]
v=subprocess.run(['docker','exec',c,'locho','--version'],capture_output=True,text=True,timeout=15)
t=subprocess.run(['docker','exec',c,'locho','share','workspace-ui','--config','/var/lib/openlia-locho-host/locho.toml','--ticket'],capture_output=True,text=True,timeout=30)
print(json.dumps({'ok':v.returncode==0 and t.returncode==0,'version':v.stdout.strip(),'ticket':t.stdout.strip() if t.returncode==0 else ''}))`;
  const exported = await exec('ssh', [...sshOptions, selected.target, `python3 -c ${quote(ticketCode)}`], { timeout: 65_000, maxBuffer: 256 * 1024 });
  const pairing = JSON.parse(exported.stdout);
  check(pairing.ok && pairing.ticket.startsWith('locho1:'), 'ticketUnavailable');
  check(/^locho 1\.3\.0-beta\.3(?:\s|$)/.test(pairing.version), 'unexpectedHostVersion');
  report.hostLochoVersion = pairing.version;

  stage = 'staticGateway';
  const listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  server.on('error', () => {});
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/__locho/`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) break;
    await sleep(100);
  }
  check(ready, 'staticGatewayUnavailable');
  const temp = process.env.OPENLIA_LIVE_TEMP ?? join(process.env.TMPDIR ?? '/tmp', 'opencode');
  await mkdir(temp, { recursive: true });

  for (const name of requested) {
    const result = { browser: name, ok: false };
    report.browsers.push(result);
    stage = `${name}:launch`;
    browser = await engines[name].launch({ env: { ...process.env, TMPDIR: temp } });
    result.version = browser.version();
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    stage = `${name}:pairing`;
    await page.goto(`${base}/__locho/`);
    await page.getByRole('status').filter({ hasText: 'Ready.' }).waitFor();
    await page.getByLabel('Workspace UI ticket').fill(pairing.ticket);
    await page.getByLabel('I trust').check();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('link', { name: 'Open deployed Workspace UI', exact: true }).waitFor({ timeout: 65_000 });
    stage = `${name}:deployedUi`;
    await page.getByRole('link', { name: 'Open deployed Workspace UI', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).waitFor();
    stage = `${name}:login`;
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).waitFor();
    const state = await page.evaluate(async () => {
      const session = await fetch('/api/auth/session').then((r) => r.json());
      const health = await fetch('/health').then((r) => r.json());
      const tree = await fetch('/api/workspace/tree');
      const data = await tree.json();
      return { authenticated: session.authenticated === true, health: health.ok === true && health.service === 'workspace-ui', treeStatus: tree.status, entryCount: Array.isArray(data.entries) ? data.entries.length : null };
    });
    check(state.authenticated && state.health && state.treeStatus === 200, 'protectedAccessFailed');
    result.authenticated = true;
    result.workspaceEntryCount = state.entryCount;
    stage = `${name}:reload`;
    await page.reload();
    await page.getByRole('navigation', { name: 'Workspace navigation' }).waitFor();
    check(await page.evaluate(async () => (await fetch('/api/auth/session').then((r) => r.json())).authenticated === true), 'reloadLostSession');
    result.reloadAuthenticated = true;
    const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
    check(!persisted.includes(password) && !persisted.includes(pairing.ticket) && !persisted.includes('openlia_workspace_session'), 'credentialPersistenceDetected');
    check(!(await context.cookies()).some((cookie) => cookie.name === 'openlia_workspace_session'), 'browserCookieDetected');
    stage = `${name}:logout`;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).waitFor();
    const loggedOut = await page.evaluate(async () => ({ authenticated: (await fetch('/api/auth/session').then((r) => r.json())).authenticated, protectedStatus: (await fetch('/api/workspace/tree')).status }));
    check(loggedOut.authenticated === false && loggedOut.protectedStatus === 401, 'logoutFailed');
    result.logoutVerified = true;
    stage = `${name}:disconnect`;
    await page.goto(`${base}/__locho/`);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Disconnected;' }).waitFor();
    result.ok = true;
    await context.close();
    await browser.close(); browser = undefined; page = undefined;
  }
  report.ok = true;
} catch {
  // Do not print browser exceptions: call logs may contain passwords/tickets,
  // and real deployment pages may contain private document names/content.
  report.failedStage = stage;
  if (stage.endsWith(':pairing') && page) {
    const text = await page.getByRole('status').textContent().catch(() => '');
    const code = text?.match(/Connection failed: ([A-Za-z]{1,40})\./)?.[1];
    if (code) report.connectionErrorCode = code;
  }
  process.exitCode = 1;
} finally {
  password = '';
  await browser?.close().catch(() => {});
  if (server?.pid && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill('SIGTERM'); });
  console.log(JSON.stringify(report, null, 2));
}
