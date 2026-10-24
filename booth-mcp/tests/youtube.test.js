import assert from 'node:assert/strict';
import test from 'node:test';
import { BoothClient } from '../src/booth.js';
import { editYouTubeModule, pageDesignSha256, planYouTubeModule, youtubeVideoId } from '../src/youtube.js';

const url = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
const otherUrl = 'https://youtu.be/AbCdEf012_-';
const input = () => ({ id: 1, state: 'draft', price: 500,
  variations: [{ id: 9, downloadable_ids: [7] }],
  page_design: { layout: 'keep', unknown: { accent: ['a', 'b'] }, modules: [
    { type: 'text', title: '説明', content: '保持する本文' },
    { type: 'future-module', unknown: { preserve: true } },
    { type: 'media', id: 'existing', width: 420,
      content: '<iframe src="https://www.youtube.com/embed/AbCdEf012_-"></iframe>' }
  ] } });

function fixture({ changeBeforeWrite, ignoreWrite = false, failWrite = false } = {}) {
  let saved = input();
  let reads = 0;
  const requests = [];
  const client = new BoothClient('synthetic-test-cookie');
  client.getItem = async () => {
    reads++;
    if (reads === 2 && changeBeforeWrite) changeBeforeWrite(saved);
    return structuredClone(saved);
  };
  client._mutate = async (method, path, body) => {
    requests.push({ method, path, body: structuredClone(body) });
    if (failWrite) throw new Error('uncertain write');
    if (!ignoreWrite) {
      saved = structuredClone(body.json.item);
      saved.page_design = JSON.parse(saved.page_design);
    }
    return { ok: true };
  };
  return { client, requests, reads: () => reads, saved: () => structuredClone(saved) };
}

test('supported YouTube links normalize to a single video ID', () => {
  for (const link of [url, 'https://youtu.be/M7lc1UVf-VE?si=tracking',
    'https://m.youtube.com/shorts/M7lc1UVf-VE', 'https://youtube.com/live/M7lc1UVf-VE',
    'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE']) assert.equal(youtubeVideoId(link), 'M7lc1UVf-VE');
});

test('non-YouTube, HTML, credentials, ports and ambiguous videos are rejected', () => {
  for (const link of [undefined, '<iframe src="https://youtube.com/embed/M7lc1UVf-VE"></iframe>',
    'http://youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com.evil.test/watch?v=M7lc1UVf-VE',
    'https://user:pass@youtube.com/watch?v=M7lc1UVf-VE', 'https://youtube.com:444/watch?v=M7lc1UVf-VE',
    'https://youtube.com/watch?v=M7lc1UVf-VE&v=AbCdEf012_-', 'https://youtube.com/playlist?list=foo',
    'https://youtube.com/embed/M7lc1UVf-VE%22', ' https://youtu.be/M7lc1UVf-VE']) {
    assert.throws(() => youtubeVideoId(link), /YouTube/);
  }
});

test('insertion keeps unknown modules and page-design metadata without changing the input', () => {
  const item = input();
  const original = structuredClone(item);
  const plan = planYouTubeModule(item, { youtube_url: url, position: 1 });
  assert.deepEqual(item, original);
  assert.deepEqual(plan.page_design, { ...original.page_design, modules: [original.page_design.modules[0],
    plan.media_module, ...original.page_design.modules.slice(1)] });
  assert.equal(plan.index, 1);
  assert.equal(plan.media_module.type, 'media');
  assert.match(plan.media_module.content, /src="https:\/\/www.youtube.com\/embed\/M7lc1UVf-VE"/);
});

test('generated iframe has no inherited URL parameters or arbitrary HTML', () => {
  const plan = planYouTubeModule(input(), { youtube_url: url + '&autoplay=1&origin=https://evil.test#x', start_seconds: 12 });
  assert.match(plan.media_module.content, /\/embed\/M7lc1UVf-VE\?start=12"/);
  assert.doesNotMatch(plan.media_module.content, /autoplay|evil|<script/);
  assert.throws(() => planYouTubeModule(input(), { youtube_url: url, html: '<script>' }), /未対応/);
});

test('replacement retains existing media metadata and refuses other module kinds or sources', () => {
  const item = input();
  const plan = planYouTubeModule(item, { youtube_url: url, action: 'replace', index: 2 });
  assert.equal(plan.media_module.id, 'existing');
  assert.equal(plan.media_module.width, 420);
  assert.deepEqual(plan.page_design.modules.slice(0, 2), item.page_design.modules.slice(0, 2));
  for (const index of [0, 1, -1, 3]) {
    assert.throws(() => planYouTubeModule(item, { youtube_url: url, action: 'replace', index }), /置換対象/);
  }
  for (const content of ['<iframe src="https://example.test/embed/M7lc1UVf-VE"></iframe>',
    '<iframe data-src="https://www.youtube.com/embed/M7lc1UVf-VE"></iframe>',
    '<iframe src="https://www.youtube.com/embed/M7lc1UVf-VE" src="https://evil.test"></iframe>',
    '<iframe src="https://www.youtube.com/embed/M7lc1UVf-VE"></iframe><p>別要素</p>']) {
    item.page_design.modules[2].content = content;
    assert.throws(() => planYouTubeModule(item, { youtube_url: url, action: 'replace', index: 2 }), /置換対象/);
  }
});

test('positions, operation modes and timestamp bounds are checked rather than clamped', () => {
  for (const options of [{ position: -1 }, { position: 4 }, { position: 0.1 }, { index: 0 },
    { action: 'replace' }, { action: 'replace', index: 2, position: 0 }, { action: 'delete' },
    { start_seconds: -1 }, { start_seconds: 1.2 }, { start_seconds: 2147483648 }, { dry_run: 'false' },
    { expected_page_design_sha256: ['a'.repeat(64)] }, { expected_page_design_sha256: 'A'.repeat(64) }]) {
    assert.throws(() => planYouTubeModule(input(), { youtube_url: url, ...options }));
  }
});

test('canonical fingerprints handle key ordering and JSON-string page_design', () => {
  const item = input();
  assert.equal(pageDesignSha256(item), pageDesignSha256({ page_design: JSON.stringify(item.page_design) }));
  assert.equal(pageDesignSha256(item), pageDesignSha256({ page_design: {
    modules: item.page_design.modules, unknown: item.page_design.unknown, layout: item.page_design.layout } }));
  const empty = planYouTubeModule({ page_design: null }, { youtube_url: url });
  assert.equal(empty.index, 0);
  for (const page_design of ['bad-json', [], { modules: {} }]) {
    assert.throws(() => planYouTubeModule({ page_design }, { youtube_url: url }), /page_design/);
  }
});

test('preview is the default and never calls the write endpoint', async () => {
  const f = fixture();
  const preview = await editYouTubeModule(f.client, 1, { youtube_url: url });
  assert.equal(preview.dry_run, true);
  assert.equal(preview.verified, false);
  assert.equal(preview.module_count, 4);
  assert.equal(preview.previous_page_design_sha256, pageDesignSha256(input()));
  assert.equal(f.reads(), 1);
  assert.equal(f.requests.length, 0);
});

test('invalid URL, ID and missing write precondition fail before any product read or write', async () => {
  const f = fixture();
  await assert.rejects(editYouTubeModule(f.client, 1, { youtube_url: 'https://evil.test' }), /YouTube/);
  await assert.rejects(editYouTubeModule(f.client, 1.5, { youtube_url: url }), /item_id/);
  await assert.rejects(editYouTubeModule(f.client, 1, { youtube_url: url, dry_run: false }), /expected_page_design_sha256/);
  assert.equal(f.reads(), 0);
  assert.equal(f.requests.length, 0);
});

test('stale preview and a change observed immediately before PATCH prevent writes', async () => {
  const stale = fixture();
  await assert.rejects(editYouTubeModule(stale.client, 1, { youtube_url: url, dry_run: false,
    expected_page_design_sha256: '0'.repeat(64) }), /page_designが変わりました/);
  assert.equal(stale.requests.length, 0);
  const race = fixture({ changeBeforeWrite: item => { item.page_design.modules[0].content = '別の変更'; } });
  await assert.rejects(editYouTubeModule(race.client, 1, { youtube_url: url, dry_run: false,
    expected_page_design_sha256: pageDesignSha256(input()) }), /適用直前/);
  assert.equal(race.requests.length, 0);
});

test('apply uses the current item fields, a JSON-string page_design and verified readback', async () => {
  const f = fixture({ changeBeforeWrite: item => { item.price = 700; } });
  const result = await editYouTubeModule(f.client, 1, { youtube_url: url, position: 1, dry_run: false,
    expected_page_design_sha256: pageDesignSha256(input()) });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.method, 'PATCH');
  assert.equal(request.path, '/items/1');
  assert.equal(typeof request.body.json.item.page_design, 'string');
  assert.equal(request.body.json.item.price, 700);
  assert.equal(request.body.json.item.state, 'draft');
  assert.deepEqual(request.body.json.item.variations, input().variations);
  assert.deepEqual(f.saved().page_design.modules.filter((_, i) => i !== 1), input().page_design.modules);
  assert.equal(f.saved().page_design.layout, 'keep');
  assert.equal(result.verified, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.page_design_sha256, pageDesignSha256(f.saved()));
});

test('id mismatch, uncertain write and an ignored PATCH do not trigger another PATCH', async () => {
  const wrong = fixture();
  wrong.client.getItem = async () => ({ ...input(), id: 2 });
  await assert.rejects(editYouTubeModule(wrong.client, 1, { youtube_url: url }), /商品ID/);
  assert.equal(wrong.requests.length, 0);
  for (const options of [{ failWrite: true }, { ignoreWrite: true }]) {
    const f = fixture(options);
    await assert.rejects(editYouTubeModule(f.client, 1, { youtube_url: url, dry_run: false,
      expected_page_design_sha256: pageDesignSha256(input()) }));
    assert.equal(f.requests.length, 1);
  }
});

test('replacing an identical generated iframe is a verified no-op', async () => {
  const f = fixture();
  const plan = planYouTubeModule(input(), { youtube_url: otherUrl, action: 'replace', index: 2 });
  f.client.getItem = async () => ({ ...input(), page_design: structuredClone(plan.page_design) });
  const result = await editYouTubeModule(f.client, 1, { youtube_url: otherUrl, action: 'replace', index: 2,
    dry_run: false, expected_page_design_sha256: plan.page_design_sha256 });
  assert.equal(result.changed, false);
  assert.equal(result.verified, true);
  assert.equal(f.requests.length, 0);
});
