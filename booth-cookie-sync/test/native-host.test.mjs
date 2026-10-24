import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { installMac } from '../install-macos.mjs';

const sourceDir = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = 'com.quolabo.booth_cookie_sync';
const COOKIE = '_plaza_session_test=synthetic-cookie';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'booth-sync-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repo = join(temporary, "Mac user's 日本語 repo");
  const syncDir = join(repo, 'booth-cookie-sync');
  const hostDir = join(syncDir, 'host');
  const packageDir = join(repo, 'booth-mcp');
  await mkdir(hostDir, { recursive: true });
  await mkdir(packageDir);
  for (const file of ['host.js', 'package.json', `${HOST}.json.template`]) {
    await copyFile(join(sourceDir, 'host', file), join(hostDir, file));
  }
  return { syncDir, hostDir, packageDir, homeDir: join(temporary, 'profile') };
}

function request(cookie = COOKIE) {
  const body = Buffer.from(JSON.stringify({ cookie, reason: 'test' }));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}

function response(result) {
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.ok(result.stdout.length >= 4, 'native host returned a framed response');
  const size = result.stdout.readUInt32LE(0);
  assert.equal(size, result.stdout.length - 4, 'stdout contains only the protocol response');
  return JSON.parse(result.stdout.subarray(4).toString());
}

async function checkCookieFiles(f) {
  assert.equal(await readFile(join(f.packageDir, '.cookie'), 'utf8'), COOKIE);
  assert.equal(await readFile(join(f.packageDir, '.env'), 'utf8'), `BOOTH_COOKIE=${COOKIE}\nITEM_ID=keep-me\n`);
  assert.doesNotMatch(await readFile(join(f.hostDir, 'sync.log'), 'utf8'), /synthetic-cookie/);
  if (process.platform !== 'win32') {
    for (const name of ['.env', '.cookie']) assert.equal((await stat(join(f.packageDir, name))).mode & 0o777, 0o600);
  }
}

test('native host runs as an ES module and preserves other environment settings', async t => {
  const f = await fixture(t);
  await writeFile(join(f.packageDir, '.env'), 'BOOTH_COOKIE=old\nITEM_ID=keep-me\n', { mode: 0o644 });
  const result = spawnSync(process.execPath, [join(f.hostDir, 'host.js')], { input: request() });
  assert.equal(response(result).ok, true);
  await checkCookieFiles(f);
});

test('macOS registration handles spaces, quotes, a minimal PATH and reinstall/uninstall', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.packageDir, '.env'), 'ITEM_ID=keep-me\n');
  const installed = await installMac(f);
  const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8'));
  assert.equal(manifest.path, installed.launcher);
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://lolkadambhklnhfambjfndlcnhmjjffb/']);
  assert.equal((await stat(installed.launcher)).mode & 0o777, 0o700);
  assert.equal((await stat(installed.manifestPath)).mode & 0o777, 0o600);
  const result = spawnSync(manifest.path, ['chrome-extension://lolkadambhklnhfambjfndlcnhmjjffb/'], {
    input: request(), env: { PATH: '/usr/bin:/bin' }, cwd: tmpdir(),
  });
  assert.equal(response(result).ok, true);
  await checkCookieFiles(f);
  await installMac(f);
  await installMac({ ...f, uninstall: true });
  await assert.rejects(stat(installed.manifestPath), { code: 'ENOENT' });
  await assert.rejects(stat(installed.launcher), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.packageDir, '.cookie'), 'utf8'), COOKIE);
  assert.equal((await installMac({ ...f, uninstall: true })).removed, false);
});

test('install and uninstall preserve another installation', async t => {
  const f = await fixture(t);
  const result = await installMac(f);
  const other = { name: HOST, path: '/some/other/booth/host.sh' };
  await writeFile(result.manifestPath, JSON.stringify(other));
  await assert.rejects(installMac(f), /Another installation owns/);
  await assert.rejects(installMac({ ...f, uninstall: true }), /Another installation owns/);
  assert.deepEqual(JSON.parse(await readFile(result.manifestPath, 'utf8')), other);
});
