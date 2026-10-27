import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startFixture } from '../browser/fixture';

// Misconfigured scripts must not start processes, bind ports or access a host.
const guard = 'data:text/javascript,' + encodeURIComponent(`
  import childProcess from 'node:child_process';
  import net from 'node:net';
  import { syncBuiltinESMExports } from 'node:module';
  const forbidden = () => {
    console.error('UNEXPECTED_EXTERNAL_ACCESS');
    throw new Error('UNEXPECTED_EXTERNAL_ACCESS');
  };
  globalThis.fetch = forbidden;
  childProcess.execFile = forbidden;
  childProcess.spawn = forbidden;
  net.createServer = forbidden;
  syncBuiltinESMExports();
`);

function verifyFailure(script: string, overrides: Record<string, string>, stage: string, code: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENLIA_LIVE_') && !key.startsWith('OPENLIA_HOSTING_')));
  const child = spawnSync(process.execPath, ['--import', guard, fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url))], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stderr).toBe('');
  expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, failedStage: stage, configurationError: code, browsers: [] });
}

describe('explicit static hosting target', () => {
  it.each([undefined, '', '   '])('rejects a missing or blank origin (%s)', (value) => {
    verifyFailure('verify-hosting.mjs', value === undefined ? {} : { OPENLIA_HOSTING_BASE_URL: value }, 'origin', 'hostingBaseUrlRequired');
  });

  it.each([
    'not-a-url',
    'http://gateway.example.com',
    'https://gateway.example.com/private',
    'https://gateway.example.com/?ticket=synthetic',
    'https://gateway.example.com/#synthetic',
    'https://user:synthetic@gateway.example.com',
  ])('rejects an invalid origin without network access (%s)', (origin) => {
    verifyFailure('verify-hosting.mjs', { OPENLIA_HOSTING_BASE_URL: origin }, 'origin', 'unsupportedHostingOrigin');
  });
});

describe('explicit live deployment target', () => {
  it.each([undefined, '', '   '])('rejects a missing or blank profile (%s)', (value) => {
    verifyFailure('verify-live.mjs', value === undefined ? {} : { OPENLIA_LIVE_CONFIG: value }, 'configuration', 'liveConfigRequired');
  });

  it.each(['', 'not-a-url', 'http://gateway.example.com', 'https://gateway.example.com/private', 'https://user:synthetic@gateway.example.com'])('validates public origin before reading a profile or exporting a ticket (%s)', (origin) => {
    verifyFailure('verify-live.mjs', { OPENLIA_LIVE_CONFIG: '/path/to/profile/config.toml', OPENLIA_LIVE_BASE_URL: origin }, 'configuration', 'unsupportedPublicOrigin');
  });

  it('validates the requested browsers before reading a profile or exporting a ticket', () => {
    verifyFailure('verify-live.mjs', { OPENLIA_LIVE_CONFIG: '/path/to/profile/config.toml', OPENLIA_LIVE_BROWSERS: 'unknown' }, 'configuration', 'unsupportedBrowser');
  });
});

describe('portable disposable browser fixture', () => {
  it('requires an explicit source checkout or built server entry', async () => {
    vi.stubEnv('OPENLIA_SOURCE', '');
    vi.stubEnv('OPENLIA_SERVER_ENTRY', '');
    try {
      await expect(startFixture()).rejects.toThrow('Set OPENLIA_SOURCE or OPENLIA_SERVER_ENTRY');
    } finally { vi.unstubAllEnvs(); }
  });
});
