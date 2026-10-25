// Static assets only. This server never accepts tickets or opens a Locho tunnel.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve('dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self' https://dns.iroh.link https://*.iroh.link wss://*.iroh.link; frame-ancestors 'none'; base-uri 'none'");
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.writeHead(302, { Location: '/__locho/' }); response.end(); return; }
  if (!url.pathname.startsWith('/__locho/') || request.method !== 'GET') { response.writeHead(404); response.end('No public upstream fallback'); return; }
  try {
    const name = decodeURIComponent(url.pathname.slice('/__locho/'.length)) || 'index.html';
    const file = resolve(root, name);
    if (!file.startsWith(root + '/')) throw new Error();
    if (name === 'sw.js') response.setHeader('Service-Worker-Allowed', '/');
    response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    const body = await readFile(file);
    response.writeHead(200); response.end(body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => console.log('Static gateway ready on loopback'));
