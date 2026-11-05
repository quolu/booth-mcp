import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { link, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { downloadAndVerify } from '../src/download.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'booth-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('test ZIP bytes 日本語');
  const item = { id: 1, downloadables: [{ id: 2, name: 'fixture.zip', file_size: bytes.length,
    url: 'https://manage.booth.pm/items/1/downloadables/2' }], variations: [{ id: 3, downloadable_ids: [2] }] };
  let reads = 0;
  const client = { getItem: async () => { reads++; return structuredClone(item); },
    _headers: extra => ({ Cookie: 'synthetic-test-cookie', ...extra }) };
  const path = join(dir, "user's 日本語.zip");
  const options = { expectedSha256: createHash('sha256').update(bytes).digest('hex'), variationId: 3 };
  return { dir, bytes, item, client, path, options, reads: () => reads };
}

test('download follows approved redirects without forwarding cookie and verifies file/linkage', async t => {
  const f = await fixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      if (options.headers.Accept !== 'text/html') return new Response(null, { status: 406 });
      return new Response(null, { status: 302, headers: { location: 'https://download.booth.pm/file?signature=synthetic' } });
    }
    if (requests.length === 2) return new Response(null, { status: 307, headers: { location: '/final.zip?signature=synthetic' } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(f.bytes.subarray(0, 5)); controller.enqueue(f.bytes.subarray(5)); controller.close();
    } }));
  });
  const result = await downloadAndVerify(f.client, 1, 2, f.path, f.options);
  assert.equal(result.sha256_matched, true);
  assert.equal(result.size_matched, true);
  assert.equal(result.variation_verified, true);
  assert.deepEqual(result.linked_variation_ids, [3]);
  assert.equal(result.bytes, f.bytes.length);
  assert.deepEqual(await readFile(f.path), f.bytes);
  assert.equal(f.reads(), 2);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers.Cookie, 'synthetic-test-cookie');
  for (const request of requests.slice(1)) assert.equal(request.options.headers.Cookie, undefined);
  for (const request of requests) assert.equal(request.options.redirect, 'manual');
  assert.equal(JSON.stringify(result).includes('signature'), false);
  assert.deepEqual(await readdir(f.dir), ["user's 日本語.zip"]);
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('hash mismatch removes temporary data and never publishes the destination', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, { ...f.options, expectedSha256: '0'.repeat(64) }), /SHA-256/);
  assert.deepEqual(await readdir(f.dir), []);
});

test('short and oversized bodies fail without leaving files', async t => {
  const f = await fixture(t);
  let body = f.bytes.subarray(1);
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), /サイズ/);
  body = Buffer.concat([f.bytes, Buffer.from('extra')]);
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), /サイズ/);
  assert.deepEqual(await readdir(f.dir), []);
});

test('an existing destination is preserved without starting a download', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'original');
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw Error('must not fetch'); });
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), /上書き/);
  assert.equal(await readFile(f.path, 'utf8'), 'original');
  assert.equal(fetched, false);
});

test('a destination created during the download is also preserved', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { await writeFile(f.path, 'created by someone else'); return new Response(f.bytes); });
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), { code: 'EEXIST' });
  assert.equal(await readFile(f.path, 'utf8'), 'created by someone else');
  assert.deepEqual(await readdir(f.dir), ["user's 日本語.zip"]);
});

test('foreign/insecure redirect is rejected before any credential can leave BOOTH', async t => {
  const f = await fixture(t);
  let fetched = 0;
  for (const location of ['https://booth.pm.evil.invalid/private?secret=hidden', 'http://download.booth.pm/file']) {
    const mock = t.mock.method(globalThis, 'fetch', async () => { fetched++; return new Response(null, { status: 302, headers: { location } }); });
    await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), error =>
      /HTTPSのBOOTH/.test(error.message) && !error.message.includes('hidden'));
    mock.mock.restore();
  }
  assert.equal(fetched, 2);
  assert.deepEqual(await readdir(f.dir), []);
});

test('variation mismatch is rejected before fetching the file', async t => {
  const f = await fixture(t);
  f.item.variations[0].downloadable_ids = [];
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw Error('must not fetch'); });
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), /紐付/);
  assert.equal(fetched, false);
  assert.deepEqual(await readdir(f.dir), []);
});

test('a linkage change during download prevents publishing the local file', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => {
    f.item.variations[0].downloadable_ids = []; return new Response(f.bytes);
  });
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), /紐付/);
  assert.deepEqual(await readdir(f.dir), []);
});

test('connection/body failure cleans up and does not echo signed URLs', async t => {
  const f = await fixture(t);
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw Error('signed-url-secret'); });
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), error => !error.message.includes('signed-url-secret'));
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('signed-url-secret')); } })));
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path, f.options), error => !error.message.includes('signed-url-secret'));
  assert.deepEqual(await readdir(f.dir), []);
});

test('missing expected hash is rejected; an omitted variation is not marked verified', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadAndVerify(f.client, 1, 2, f.path), /expected_sha256/);
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  const result = await downloadAndVerify(f.client, 1, 2, f.path, { expectedSha256: f.options.expectedSha256 });
  assert.equal(result.variation_verified, null);
  assert.deepEqual(result.linked_variation_ids, [3]);
});

test('the next download reclaims only stopped local writers and keeps published data', async t => {
  const f = await fixture(t);
  const previous = spawnSync(process.execPath, ['-e', '']);
  assert.equal(previous.status, 0);
  assert.throws(() => process.kill(previous.pid, 0), { code: 'ESRCH' });
  const prefix = `.booth-download-${createHash('sha256').update(hostname()).digest('hex').slice(0, 16)}-`;
  const stopped = join(f.dir, `${prefix}${previous.pid}-${randomUUID()}.part`);
  const live = `${prefix}${process.pid}-${randomUUID()}.part`;
  const unknown = `.booth-download-${randomUUID()}.part`;
  const published = join(f.dir, 'already-verified.zip');
  await writeFile(published, f.bytes);
  await link(published, stopped);
  await writeFile(join(f.dir, live), 'active writer');
  await writeFile(join(f.dir, unknown), 'unknown owner');
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  assert.equal((await downloadAndVerify(f.client, 1, 2, f.path, f.options)).sha256_matched, true);
  await assert.rejects(stat(stopped), { code: 'ENOENT' });
  assert.deepEqual(await readFile(published), f.bytes);
  assert.equal(await readFile(join(f.dir, live), 'utf8'), 'active writer');
  assert.equal(await readFile(join(f.dir, unknown), 'utf8'), 'unknown owner');
});

test('published data remains successful when part cleanup fails, and the next call retries cleanup', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  const original = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async () => { throw Object.assign(Error('cannot unlink'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  let result;
  try { result = await downloadAndVerify(f.client, 1, 2, f.path, f.options); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.unlink, original);
  assert.equal(result.sha256_matched, true);
  assert.equal(result.cleanup_pending, true);
  assert.equal(result.cleanup_error, 'EACCES');
  assert.deepEqual(await readFile(f.path), f.bytes);
  assert.equal((await readdir(f.dir)).filter(name => name.endsWith('.part')).length, 1);
  await downloadAndVerify(f.client, 1, 2, join(f.dir, 'second.zip'), f.options);
  assert.equal((await readdir(f.dir)).filter(name => name.endsWith('.part')).length, 0);
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('a stopped part that cannot be removed does not prevent a new verified download', async t => {
  const f = await fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']);
  const prefix = `.booth-download-${createHash('sha256').update(hostname()).digest('hex').slice(0, 16)}-`;
  const orphan = join(f.dir, `${prefix}${dead.pid}-${randomUUID()}.part`);
  await writeFile(orphan, 'incomplete');
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  const original = fs.unlink;
  const mocked = t.mock.method(fs, 'unlink', async path => {
    if (path === orphan) throw Object.assign(Error('busy'), { code: 'EACCES' });
    return original(path);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await downloadAndVerify(f.client, 1, 2, f.path, f.options); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.sha256_matched, true);
  assert.equal(result.cleanup_pending, true);
  assert.equal(result.cleanup_error, 'EACCES');
  assert.deepEqual(await readFile(f.path), f.bytes);
  assert.equal(await readFile(orphan, 'utf8'), 'incomplete');
});

test('a forced interruption is reclaimed by the next ordinary download', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const moduleURL = new URL('../src/download.js', import.meta.url).href;
  const script = `
    import { downloadAndVerify } from ${JSON.stringify(moduleURL)};
    import { readdir, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); }
    }));
    const directory = ${JSON.stringify(f.dir)};
    const timer = setInterval(async () => {
      for (const name of await readdir(directory)) {
        if (name.endsWith('.part') && (await stat(join(directory, name))).size > 0) {
          process.stdout.write('ready');
          clearInterval(timer);
          setInterval(() => {}, 1000);
          return;
        }
      }
    }, 20);
    await downloadAndVerify({ getItem: async () => (${JSON.stringify(f.item)}), _headers: () => ({}) },
      1, 2, ${JSON.stringify(f.path)}, ${JSON.stringify(f.options)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw Error(`fixture exited before writing a part: ${code}`); }),
  ]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal((await readdir(f.dir)).filter(name => name.endsWith('.part')).length, 1);
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  await downloadAndVerify(f.client, 1, 2, f.path, f.options);
  assert.deepEqual(await readdir(f.dir), ["user's 日本語.zip"]);
  assert.deepEqual(await readFile(f.path), f.bytes);
});
