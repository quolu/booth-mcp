import test from "node:test";
import assert from "node:assert/strict";
import { BoothClient } from "../src/booth.js";

function fixture(initialState, savedState = initialState) {
  const client = new BoothClient("テスト専用");
  const requests = [];
  let reads = 0;
  client.getItem = async () => ({ id: 1, state: reads++ ? savedState : initialState,
    name: "商品", page_design: { modules: [] } });
  client._mutate = async (...args) => { requests.push(args); return { ok: true }; };
  return { client, requests };
}

test("下書きの公開はpublishイベントを送る", async () => {
  const { client, requests } = fixture("draft", "public");
  await client.updateItem(1, { state: "public", name: "新しい商品名" });
  assert.equal(requests[0][0], "PATCH");
  assert.equal(requests[0][1], "/items/1");
  assert.deepEqual(requests[0][2].json.item, { id: 1, state: "draft",
    name: "新しい商品名", page_design: '{"modules":[]}', state_event: "publish" });
});

test("公開済み商品の非公開化はto_privateイベントを送る", async () => {
  const { client, requests } = fixture("public", "private");
  await client.updateItem(1, { state: "private" });
  assert.equal(requests[0][2].json.item.state_event, "to_private");
});

test("同じ公開状態の保存では状態遷移を再送しない", async () => {
  const { client, requests } = fixture("public");
  await client.updateItem(1, { state: "public" });
  assert.equal(Object.hasOwn(requests[0][2].json.item, "state_event"), false);
});

test("通常の説明更新は公開状態を変更しない", async () => {
  const { client, requests } = fixture("draft");
  await client.updateItem(1, { description: "説明" });
  assert.equal(requests[0][2].json.item.state, "draft");
  assert.equal(Object.hasOwn(requests[0][2].json.item, "state_event"), false);
});

test("HTTP成功でも状態が変わらなければ失敗を返す", async () => {
  const { client } = fixture("draft");
  await assert.rejects(client.updateItem(1, { state: "public" }), /公開状態が反映されませんでした/);
});

test("未対応状態は送信前に拒否する", async () => {
  const { client, requests } = fixture("public");
  await assert.rejects(client.updateItem(1, { state: "draft" }), /publicまたはprivate/);
  assert.equal(requests.length, 0);
});
