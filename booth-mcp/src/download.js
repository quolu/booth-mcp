import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MANAGE_ORIGIN = 'https://manage.booth.pm';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
class DownloadError extends Error {}
const fail = message => new DownloadError(message);
const validSize = size => Number.isSafeInteger(size) && size >= 0;

function positiveId(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw fail(`${name}は正の整数で指定してください。`);
}

function downloadURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw fail('ダウンロードURLが不正です。'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !(url.hostname === 'booth.pm' || url.hostname.endsWith('.booth.pm'))) {
    throw fail('ダウンロード先はHTTPSのBOOTH配信元に限ります。');
  }
  return url;
}

async function metadata(client, itemId, downloadableId, variationId) {
  let item;
  try { item = await client.getItem(itemId); } catch { throw fail('商品の読取りに失敗しました。'); }
  if (String(item.id) !== String(itemId)) throw fail('取得した商品IDが一致しません。');
  const file = (item.downloadables || []).find(value => String(value.id) === String(downloadableId));
  if (!file) throw fail('指定したダウンロードファイルは商品にありません。');
  const variations = (item.variations || []).filter(value =>
    (value.downloadable_ids || []).some(id => String(id) === String(downloadableId)));
  if (variationId !== undefined && !variations.some(value => String(value.id) === String(variationId))) {
    throw fail('指定したバリエーションにファイルが紐付いていません。');
  }
  return { file, linkedVariationIds: variations.map(value => value.id) };
}

async function responseFor(client, initialURL, signal) {
  let url = downloadURL(initialURL);
  for (let redirects = 0; redirects <= 5; redirects++) {
    let response;
    // Session credentials belong only to the management origin, never a CDN.
    // The management route negotiates HTML before returning its signed redirect;
    // asking it for octet-stream returns HTTP 406 (2026-10-24 live verification).
    const headers = url.origin === MANAGE_ORIGIN ? client._headers({ Accept: 'text/html' })
      : { Accept: 'application/octet-stream' };
    try { response = await fetch(url, { headers, redirect: 'manual', signal }); }
    catch { throw fail('ダウンロード要求に失敗しました。'); }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw fail('ダウンロード転送を完了できませんでした。');
      url = downloadURL(location, url);
      continue;
    }
    if (!response.ok || !response.body || /^(text\/|application\/json)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw fail(`ダウンロード応答が不正です（HTTP ${response.status}）。`);
    }
    return response;
  }
}

/** Read-only on BOOTH; publish a local file only after all requested checks pass. */
export async function downloadAndVerify(client, itemId, downloadableId, filePath, {
  expectedSha256, expectedSize, variationId,
} = {}) {
  positiveId(itemId, 'item_id');
  positiveId(downloadableId, 'downloadable_id');
  if (variationId !== undefined) positiveId(variationId, 'variation_id');
  if (typeof expectedSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(expectedSha256)) {
    throw fail('expected_sha256は照合するSHA-256の64桁の16進文字列で指定してください。');
  }
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw fail('file_pathは保存先の絶対パスで指定してください。');
  if (expectedSize !== undefined && !validSize(expectedSize)) throw fail('expected_sizeは0以上の整数で指定してください。');
  try {
    await lstat(filePath);
    throw fail('保存先が既に存在します。上書きしません。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const before = await metadata(client, itemId, downloadableId, variationId);
  const size = expectedSize ?? before.file.file_size;
  if (!validSize(size)) throw fail('商品に有効なサイズ情報がないためexpected_sizeが必要です。');
  if (validSize(before.file.file_size) && before.file.file_size !== size) throw fail('期待サイズと商品のサイズ情報が一致しません。');
  if (typeof before.file.url !== 'string' || !before.file.url) throw fail('商品のダウンロードURLがありません。');

  const temporary = join(dirname(filePath), `.booth-download-${randomUUID()}.part`);
  let handle;
  let created = false;
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    const response = await responseFor(client, before.file.url, AbortSignal.timeout(900000));
    const meter = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > size) return done(fail('ダウンロードが期待サイズを超えました。'));
      hash.update(chunk);
      done(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body), meter, handle.createWriteStream());
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw fail('ダウンロードまたは一時ファイルの保存が途中で失敗しました。');
    }
    await handle.close();
    handle = undefined;
    if (bytes !== size) throw fail('ダウンロードのサイズが一致しません。');
    const sha256 = hash.digest('hex');
    if (sha256 !== expectedSha256.toLowerCase()) throw fail('ダウンロードのSHA-256が一致しません。');
    const after = await metadata(client, itemId, downloadableId, variationId);
    if (validSize(after.file.file_size) && after.file.file_size !== size) throw fail('検証中に商品のサイズ情報が変更されました。');
    // link is atomic and refuses any existing destination. Non-link filesystems
    // use an exclusive copy of the already verified file, also without overwrite.
    try { await link(temporary, filePath); }
    catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
      await copyFile(temporary, filePath, constants.COPYFILE_EXCL);
    }
    return { item_id: itemId, downloadable_id: downloadableId, filename: after.file.name ?? null,
      saved_path: filePath, bytes, sha256, sha256_matched: true, size_matched: true,
      variation_id: variationId ?? null, variation_verified: variationId === undefined ? null : true,
      linked_variation_ids: after.linkedVariationIds };
  } finally {
    if (handle) await handle.close();
    if (created) await unlink(temporary);
  }
}
