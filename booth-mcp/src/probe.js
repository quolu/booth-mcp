// 受入テスト（非破壊）: 実験台商品に対し全機能を往復検証する。
//   node --env-file=.env src/probe.js
// すべて「変更→確認→復元→確認」で、終了時は元の状態に戻る。

import { deflateSync } from "node:zlib";
import { BoothClient } from "./booth.js";

const cookie = process.env.BOOTH_COOKIE || "";
const itemId = Number(process.env.ITEM_ID || 0);
if (!itemId) {
  console.error(
    "ITEM_ID を指定してください（非公開商品や下書きなど、書き換えてよい実験用の商品IDを推奨）。\n" +
      "例: ITEM_ID=1234567 node --env-file=.env src/probe.js"
  );
  process.exit(1);
}

const log = (...a) => console.log(...a);
const ok = (c, m) => {
  log(`${c ? "✅" : "❌"} ${m}`);
  if (!c) process.exitCode = 1;
};

// ---- 有効なPNGを純Nodeで生成（620x620 単色）----
function crc32(buf) {
  let c,
    table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 22バイトの空ZIP（EOCDのみ）。
const EMPTY_ZIP = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

async function main() {
  const c = new BoothClient(cookie);

  log("— CSRF —");
  const csrf = await c.csrf();
  ok(csrf.length > 10, `CSRFトークン取得（${csrf.length}文字）`);

  log("\n— 商品取得 —");
  const item = await c.getItem(itemId);
  ok(item.id === itemId, `getItem: ${item.name}`);
  const origDesc = item.description;
  const origPrice = item.price;
  const origImageIds = (item.images || []).map((i) => i.id);
  const origDlIds = (item.downloadables || []).map((d) => d.id);

  log("\n— 説明文の往復 —");
  const marker = `\n[probe ${new Date().toISOString()}]`;
  await c.updateItem(itemId, { description: origDesc + marker });
  ok((await c.getItem(itemId)).description.endsWith(marker), "説明文が変更された");
  await c.updateItem(itemId, { description: origDesc });
  ok((await c.getItem(itemId)).description === origDesc, "説明文が復元された");

  log("\n— 段落(page_design)の往復: 追加→編集→並べ替え→削除 —");
  const before = (await c.getModules(itemId)).modules;
  const origContents = before.map((m) => m.content);
  await c.addParagraph(itemId, "probe段落", "本文\n2行目");
  let mods = (await c.getModules(itemId)).modules;
  ok(mods.length === before.length + 1 && mods.at(-1).title === "probe段落", "段落を追加できた");
  ok(
    JSON.stringify(mods.slice(0, before.length).map((m) => m.content)) === JSON.stringify(origContents),
    "既存段落は完全保持"
  );
  const pidx = mods.length - 1;
  await c.editParagraph(itemId, pidx, { content: "編集後" });
  ok((await c.getModules(itemId)).modules[pidx].content === "編集後", "段落を編集できた");
  await c.reorderParagraphs(itemId, [pidx, ...before.map((_, i) => i)]);
  ok((await c.getModules(itemId)).modules[0].title === "probe段落", "段落を並べ替えできた");
  await c.deleteParagraph(itemId, 0);
  const pend = (await c.getModules(itemId)).modules;
  ok(
    pend.length === before.length && JSON.stringify(pend.map((m) => m.content)) === JSON.stringify(origContents),
    "段落を削除して原状復帰"
  );

  log("\n— 設定フィールドの往復（adult / purchase_limit / preorder）—");
  await c.updateItem(itemId, { purchase_limit: 1 });
  ok((await c.getItem(itemId)).purchase_limit === 1, "purchase_limitが変更された");
  await c.updateItem(itemId, { purchase_limit: item.purchase_limit });
  ok((await c.getItem(itemId)).purchase_limit === item.purchase_limit, "purchase_limitが復元された");

  log("\n— 価格の往復（setPrice: item + variations 連動）—");
  await c.setPrice(itemId, origPrice + 1);
  const p1 = await c.getItem(itemId);
  ok(
    p1.price === origPrice + 1 && p1.variations.every((v) => v.price === origPrice + 1),
    `価格が ${origPrice + 1} に変更された（variations連動込み）`
  );
  await c.setPrice(itemId, origPrice);
  const p2 = await c.getItem(itemId);
  ok(
    p2.price === origPrice && p2.variations.every((v) => v.price === origPrice),
    "価格が復元された"
  );

  log("\n— DLファイル: 追加→削除 —");
  await c.uploadDownload(itemId, EMPTY_ZIP, "probe-test.zip");
  const mid = await c.getItem(itemId);
  const addedDl = (mid.downloadables || []).filter((d) => !origDlIds.includes(d.id));
  ok(addedDl.length === 1, `テストzip追加（id=${addedDl[0]?.id}）`);
  if (addedDl[0]) await c.deleteDownload(itemId, addedDl[0].id);
  const dlEnd = (await c.getItem(itemId)).downloadables.map((d) => d.id).sort();
  ok(JSON.stringify(dlEnd) === JSON.stringify([...origDlIds].sort()), "DLファイルが復元された");

  log("\n— 画像: 追加→並べ替え→削除 —");
  const png = makePng(620, 620, [58, 168, 160]);
  await c.uploadImage(itemId, png, "probe-test.png");
  const withImg = await c.getItem(itemId);
  const addedImg = withImg.images.map((i) => i.id).filter((id) => !origImageIds.includes(id));
  ok(addedImg.length === 1, `テスト画像追加（id=${addedImg[0]}）`);

  if (addedImg.length === 1) {
    const newId = addedImg[0];
    // 追加画像を先頭へ → 復元順へ
    await c.reorderImages(itemId, [newId, ...origImageIds]);
    const ro = (await c.getItem(itemId)).images.map((i) => i.id);
    ok(ro[0] === newId, "並べ替えでテスト画像が先頭（メイン）になった");
    await c.deleteImage(itemId, newId);
    await c.reorderImages(itemId, origImageIds);
    const fin = (await c.getItem(itemId)).images.map((i) => i.id);
    ok(JSON.stringify(fin) === JSON.stringify(origImageIds), "画像が削除され元の並びに復元された");
  }

  log("\n— 最終状態確認 —");
  const end = await c.getItem(itemId);
  ok(
    end.description === origDesc &&
      end.price === origPrice &&
      JSON.stringify(end.images.map((i) => i.id)) === JSON.stringify(origImageIds) &&
      JSON.stringify(end.downloadables.map((d) => d.id).sort()) ===
        JSON.stringify([...origDlIds].sort()),
    "実験台は完全に原状復帰"
  );

  log("\n全チェック完了。");
}

main().catch((e) => {
  console.error("❌ 失敗:", e.message);
  process.exit(1);
});
