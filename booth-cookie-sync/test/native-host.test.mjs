import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('Homebrew registration survives an upgrade and cleanup without reinstalling', { skip: process.platform === 'win32' }, async t => {
  for (const formula of ['node', 'node@24']) {
    const f = await fixture(t);
    const prefix = join(f.homeDir, 'Homebrew');
    const oldKeg = join(prefix, 'Cellar', formula, '1.0');
    const newKeg = join(prefix, 'Cellar', formula, '1.1_1');
    const opt = join(prefix, 'opt', formula);
    for (const keg of [oldKeg, newKeg]) {
      await mkdir(join(keg, 'bin'), { recursive: true });
      await copyFile(process.execPath, join(keg, 'bin', 'node'));
    }
    await mkdir(dirname(opt), { recursive: true });
    await symlink(oldKeg, opt);
    const installer = pathToFileURL(join(sourceDir, 'install-macos.mjs')).href;
    const result = spawnSync(join(oldKeg, 'bin', 'node'), ['--input-type=module', '-e',
      `import { installMac } from ${JSON.stringify(installer)}; console.log(JSON.stringify(await installMac(${JSON.stringify(f)})));`,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const installed = JSON.parse(result.stdout);
    assert.equal(installed.nodePath, join(opt, 'bin', 'node'));
    const launcher = await readFile(installed.launcher, 'utf8');
    assert.doesNotMatch(launcher, /\/Cellar\//);
    const registration = await readFile(installed.manifestPath, 'utf8');
    await rm(opt);
    await symlink(newKeg, opt);
    await rm(oldKeg, { recursive: true });
    const manifest = JSON.parse(registration);
    assert.equal(response(spawnSync(manifest.path, [], {
      input: request(), env: { PATH: '/usr/bin:/bin' }, cwd: tmpdir(),
    })).ok, true);
    assert.equal(await readFile(installed.launcher, 'utf8'), launcher);
    assert.equal(await readFile(installed.manifestPath, 'utf8'), registration);
    assert.equal(await readFile(join(f.packageDir, '.cookie'), 'utf8'), COOKIE);
  }
});

test('missing or mismatched Node leaves the launcher and registration unchanged', async t => {
  const f = await fixture(t);
  const installed = await installMac(f);
  const launcher = await readFile(installed.launcher);
  const manifest = await readFile(installed.manifestPath);
  const otherNode = join(f.hostDir, 'other-node');
  await copyFile(process.execPath, otherNode);
  await assert.rejects(installMac({ ...f, nodePath: otherNode }), /does not resolve to the installing Node/);
  await assert.rejects(installMac({ ...f, nodePath: join(f.hostDir, 'missing-node') }), { code: 'ENOENT' });
  assert.deepEqual(await readFile(installed.launcher), launcher);
  assert.deepEqual(await readFile(installed.manifestPath), manifest);
  // Uninstall must remain possible even if the selected Node has disappeared.
  await installMac({ ...f, nodePath: join(f.hostDir, 'missing-node'), uninstall: true });
  await assert.rejects(stat(installed.manifestPath), { code: 'ENOENT' });
});
