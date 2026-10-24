import test from 'node:test';
import assert from 'node:assert/strict';
import { BoothClient } from '../src/booth.js';
import { itemUpdateFields } from '../src/item-update.js';

function fixture() {
  const requests = [];
  const client = new BoothClient('synthetic-test-cookie');
  client.getItem = async () => ({ id: 1, name: '商品', state: 'draft', price: 500,
    variations: [{ id: 9, downloadable_ids: [7] }],
    page_design: { previous: true, modules: [{ type: 'text', title: '旧', content: '旧本文' }] } });
  client._mutate = async (...args) => { requests.push(args); return { ok: true }; };
  return { client, requests };
}

test('native page_design preserves media, unknown modules and arbitrary metadata in the BOOTH payload', async () => {
  const page_design = { theme: { accent: 'blue' }, modules: [
    { type: 'media', content: '<iframe src="https://video.example/embed/1"></iframe>', arbitrary: 9 },
    { type: 'future-module', data: { keep: [1, 2] } }
  ] };
  const original = structuredClone(page_design);
  const { client, requests } = fixture();
  await client.updateItem(1, itemUpdateFields({ page_design }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'PATCH');
  assert.equal(requests[0][1], '/items/1');
  assert.deepEqual(JSON.parse(requests[0][2].json.item.page_design), original);
  assert.deepEqual(page_design, original);
  assert.equal(requests[0][2].json.item.state, 'draft');
  assert.equal(requests[0][2].json.item.price, 500);
  assert.deepEqual(requests[0][2].json.item.variations, [{ id: 9, downloadable_ids: [7] }]);
});

test('page_design is a full replacement and does not impose a merge policy', async () => {
  const { client, requests } = fixture();
  await client.updateItem(1, itemUpdateFields({ page_design: { modules: [] } }));
  assert.deepEqual(JSON.parse(requests[0][2].json.item.page_design), { modules: [] });
});

test('native JSON-string page_design is sent without double encoding', async () => {
  const page_design = '{"modules":[{"type":"media","content":"<iframe></iframe>"}],"custom":true}';
  const { client, requests } = fixture();
  await client.updateItem(1, itemUpdateFields({ page_design }));
  assert.equal(requests[0][2].json.item.page_design, page_design);
});

test('legacy text modules still default to text while explicit types and unknown keys are forwarded', () => {
  const page_design_modules = [{ title: '見出し', content: '本文' },
    { type: 'media', content: '<iframe></iframe>', extra: { keep: true } }];
  assert.deepEqual(itemUpdateFields({ page_design_modules }).page_design.modules,
    [{ type: 'text', title: '見出し', content: '本文' }, page_design_modules[1]]);
  assert.deepEqual(page_design_modules[0], { title: '見出し', content: '本文' });
});

test('ambiguous page-design inputs and an empty update are rejected', () => {
  assert.throws(() => itemUpdateFields({ page_design: {}, page_design_modules: [] }), /どちらか一方/);
  assert.throws(() => itemUpdateFields({ item_id: 1 }), /更新するフィールド/);
});

test('other existing argument mappings remain unchanged', () => {
  assert.deepEqual(itemUpdateFields({ name: '名', description: '説明', state: 'private', tags: ['tag'],
    category_id: 5, adult: false, purchase_limit: 0, preorder_enabled: false }), {
    name: '名', description: '説明', state: 'private', tags_array: ['tag'], category_id: 5,
    adult: 'false', purchase_limit: 0, preorder_enabled: false
  });
});

test('a BOOTH write failure propagates without retry or a separate confirmation workflow', async () => {
  const { client } = fixture();
  let writes = 0;
  client._mutate = async () => { writes++; throw new Error('uncertain write'); };
  await assert.rejects(client.updateItem(1, itemUpdateFields({ page_design: { modules: [] } })), /uncertain write/);
  assert.equal(writes, 1);
});
