import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
