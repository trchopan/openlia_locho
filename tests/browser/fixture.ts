import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer, request as httpRequest } from 'node:http';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const binary = process.env.LOCHO_BINARY ?? 'locho';
export const password = 'synthetic-feasibility-only';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function startFixture() {
  const source = resolve(process.env.OPENLIA_SOURCE ?? '../open_lia');
  const entry = resolve(process.env.OPENLIA_SERVER_ENTRY ?? join(source, 'packages/workspace-ui/dist/server.js'));
  await access(entry);
  const version = await exec(binary, ['--version']);
  if (!version.stdout.includes('1.3.0-beta.2')) throw new Error('Fixture requires Locho 1.3.0-beta.2');
  const parent = join(tmpdir(), 'opencode');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'openlia-locho-'));
  const children: ChildProcess[] = [];
  let probe: ReturnType<typeof httpServer> | undefined;
  const stats = { mutations: 0, streams: 0, received: 0, pendingCookie: false };
  let releaseCookie: (() => void) | undefined;
  // Test-only backend observations; never send these credentials to the page,
  // console, assertions, screenshots, traces, or fixture files.
  const sessionValues = new Set<string>();
  const cleanup = async () => {
    probe?.closeAllConnections();
    if (probe) await new Promise<void>((resolve) => probe!.close(() => resolve()));
    await Promise.all(children.map(stop));
    await rm(root, { recursive: true, force: true });
  };
  try {
    for (const folder of ['workspace', 'skills', 'memories', 'runtime', 'locho', 'ingestion', 'migrations', 'usage', 'cron']) await mkdir(join(root, folder));
    await writeFile(join(root, 'workspace', 'probe.md'), '# Synthetic feasibility document\n\nOriginal content.\n');
    const hash = await exec('bun', ['-e', `console.log(await Bun.password.hash(${JSON.stringify(password)}, { algorithm: 'argon2id' }))`]);
    const hashFile = join(root, 'password.hash');
    await writeFile(hashFile, hash.stdout.trim(), { mode: 0o600 });
    const port = await unusedPort();
    const env = {
      ...process.env,
      OPENLIA_WORKSPACE_ROOT: join(root, 'workspace'),
      OPENLIA_SKILLS_ROOT: join(root, 'skills'),
      OPENLIA_MEMORIES_ROOT: join(root, 'memories'),
      OPENLIA_RUNTIME_ROOT: join(root, 'runtime'),
      OPENLIA_INGESTION_ROOT: join(root, 'ingestion'),
      OPENLIA_MIGRATIONS_ROOT: join(root, 'migrations'),
      OPENLIA_USAGE_ROOT: join(root, 'usage'),
      OPENLIA_CRON_ROOT: join(root, 'cron'),
      OPENLIA_WORKSPACE_UI_SESSION_DB: join(root, 'runtime', 'sessions.sqlite'),
      OPENLIA_WORKSPACE_UI_SHARES_DB: join(root, 'runtime', 'shares.sqlite'),
      OPENLIA_WORKSPACE_UI_PASSWORD_HASH_FILE: hashFile,
      OPENLIA_WORKSPACE_UI_AUTH_REQUIRED: 'true',
      OPENLIA_WORKSPACE_UI_ALLOWED_EMAILS: '',
      OPENLIA_WORKSPACE_UI_FIREBASE_PROJECT_ID: '',
      OPENLIA_WORKSPACE_UI_FIREBASE_API_KEY: '',
      OPENLIA_WORKSPACE_UI_FIREBASE_AUTH_DOMAIN: '',
      OPENLIA_WORKSPACE_UI_PUBLIC_ORIGIN: '',
      OPENLIA_WORKSPACE_UI_BIND: '127.0.0.1',
      OPENLIA_WORKSPACE_UI_PORT: String(port),
      OPENLIA_HERMES_API_URL: '', API_SERVER_KEY: '',
      LOCHO_STATE_DIR: join(root, 'locho'),
    };
    const upstream = spawn('bun', [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(upstream);
    upstream.stdout?.resume(); upstream.stderr?.resume();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { ready = true; break; } } catch {}
      if (upstream.exitCode !== null) throw new Error('Disposable Workspace UI exited');
      await sleep(100);
    }
    if (!ready) throw new Error('Disposable Workspace UI did not start');
    // Test-only byte/stream instrumentation. Non-probe requests reach the real,
    // unmodified OpenLia server. This is NOT part of the public static gateway.
    probe = httpServer((req, res) => {
      const url = new URL(req.url!, 'http://probe');
      if (!url.pathname.startsWith('/__probe/')) {
        const outgoing = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (incoming) => {
          for (const header of incoming.headers['set-cookie'] ?? []) {
            const value = header.match(/^openlia_workspace_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
            if (value) sessionValues.add(value);
          }
          res.writeHead(incoming.statusCode!, incoming.headers);
          incoming.pipe(res);
        });
        outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(outgoing);
        res.on('close', () => outgoing.destroy());
        return;
      }
      if (url.pathname === '/__probe/session-present') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ present: /(?:^|;\s*)openlia_workspace_session=/.test(req.headers.cookie ?? '') }));
        return;
      }
      if (url.pathname === '/__probe/session-update') {
        const token = req.headers.cookie?.match(/(?:^|;\s*)openlia_workspace_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
        if (!token || !sessionValues.has(token)) { res.writeHead(401); res.end(); return; }
        const kind = url.searchParams.get('kind');
        const header = `openlia_workspace_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${kind === 'expire' ? 1 : 30}`;
        const send = () => {
          if (!res.destroyed) { res.writeHead(200, { 'Set-Cookie': kind === 'ambiguous' ? [header, header] : header }); res.end('synthetic update'); }
        };
        if (kind === 'delayed') {
          stats.pendingCookie = true;
          releaseCookie = send;
          res.on('close', () => { stats.pendingCookie = false; releaseCookie = undefined; });
        } else send();
        return;
      }
      if (url.pathname === '/__probe/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        stats.streams++;
        res.write(': connected\n\n');
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 200);
        const delay = setTimeout(() => {
          res.write('data: {"event":"delta","text":"synthetic"}\n\n');
          if (!url.searchParams.has('hold')) res.end();
        }, 500);
        res.on('close', () => { stats.streams--; clearInterval(heartbeat); clearTimeout(delay); });
        return;
      }
      if (url.pathname === '/__probe/redirect') { res.writeHead(302, { Location: '/__probe/binary' }); res.end(); return; }
      if (url.pathname === '/__probe/external-redirect') { res.writeHead(302, { Location: 'https://example.invalid/' }); res.end(); return; }
      if (url.pathname === '/__probe/binary' || url.pathname === '/__probe/large') {
        const body = url.pathname.endsWith('large') ? Buffer.alloc(9 * 1024 * 1024, 42) : Buffer.from([0, 255, 1, 128, 2, 127]);
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
        if (range) {
          const start = Number(range[1]), end = Math.min(Number(range[2]), body.length - 1);
          res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
          res.end(body.subarray(start, end + 1));
        } else { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }); res.end(body); }
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        stats.received++;
        const body = Buffer.concat(chunks);
        if (url.pathname === '/__probe/mutation') {
          stats.mutations++;
          if (url.searchParams.has('lose')) { req.socket.destroy(); return; }
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Received-Content-Type': req.headers['content-type'] ?? 'none', 'Content-Length': body.length });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => probe!.listen(0, '127.0.0.1', resolve));
    const tunnelPort = (probe.address() as { port: number }).port;
    const config = join(root, 'locho.toml');
    await writeFile(config, `[[services]]\nname = "workspace-ui"\ntype = "tcp"\nendpoint = "127.0.0.1:${tunnelPort}"\n`);
    const host = spawn(binary, ['host', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(host);
    const hostId = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Locho fixture startup timeout')), 30_000);
      const read = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const id = output.match(/host id:\s*([a-f0-9]{64})/i)?.[1];
        if (id) { clearTimeout(timeout); resolve(id); }
      };
      host.stdout?.on('data', read); host.stderr?.on('data', read);
      host.once('error', () => { clearTimeout(timeout); reject(new Error('Locho fixture could not start')); });
      host.once('exit', () => { clearTimeout(timeout); reject(new Error('Locho fixture exited')); });
    });
    let relay: string | undefined;
    for (let i = 0; i < 6 && !relay; i++) {
      try {
        const result = await exec(binary, ['diagnose', '--host-id', hostId], { env, timeout: 20_000 });
        const value = `${result.stdout}\n${result.stderr}`.match(/relay:\s*(https:\/\/[^)\s]+)/)?.[1];
        if (value) { const u = new URL(value); u.hostname = u.hostname.replace(/\.$/, ''); relay = u.href; }
      } catch {}
      if (!relay) await sleep(1000);
    }
    const shared = await exec(binary, ['share', 'workspace-ui', '--config', config, '--ticket', ...(relay ? ['--peer-relay-url', relay] : [])], { env });
    const ticket = shared.stdout.trim();
    if (!ticket.startsWith('locho1:')) throw new Error('Ticket fixture invalid');
    let currentHost = host;
    return {
      ticket, cleanup, upstream, host, root, port, stats,
      hasCredentialLeak: (text: string) => [ticket, password, ...sessionValues].some((value) => text.includes(value)),
      observedSession: () => sessionValues.size > 0,
      releaseCookie: () => releaseCookie?.(),
      stopHost: () => stop(currentHost),
      restartHost: () => {
        currentHost = spawn(binary, ['host', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(currentHost);
        currentHost.stdout?.resume(); currentHost.stderr?.resume();
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
