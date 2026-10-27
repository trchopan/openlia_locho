// Package only the known static build layout, never operator configuration.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const artifacts = resolve(root, 'artifacts');
const files = [];
async function collect(directory) {
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const entry = await lstat(path);
    const nameInArchive = relative(dist, path).replaceAll('\\', '/');
    if (entry.isDirectory() && nameInArchive === 'assets') await collect(path);
    else if (entry.isFile() && /^(index\.html|sw\.js|assets\/[A-Za-z0-9_-]+\.(js|css|wasm))$/.test(nameInArchive)) files.push(nameInArchive);
    else throw new Error(`Unexpected static build entry: ${nameInArchive}`);
  }
}
await collect(dist);
if (!files.includes('index.html') || !files.includes('sw.js') || !files.some((name) => name.endsWith('.wasm'))) {
  throw new Error('Incomplete static build');
}
await mkdir(artifacts, { recursive: true });
const pending = resolve(artifacts, '.release.tar.gz');
execFileSync('tar', ['-czf', pending, '--', ...files], {
  cwd: dist, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe',
});
const sha256 = createHash('sha256').update(await readFile(pending)).digest('hex');
const archive = resolve(artifacts, `openlia-locho-${sha256}.tar.gz`);
await rename(pending, archive);
const manifest = { openlia_locho_artifact: archive, openlia_locho_sha256: sha256 };
await writeFile(resolve(artifacts, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, files: files.length }, null, 2));
