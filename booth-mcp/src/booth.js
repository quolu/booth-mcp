// BOOTH (manage.booth.pm) 内部APIクライアント。
// 認証: セッションcookie（httpOnly、手動 or 拡張で供給）+ CSRFトークン（認証済みページから自動scrape）。
// Cloudflare TLSゲートは Node native fetch(undici) で通過する（curl_cffi不要・実測済み）。
// 注: ルート `/` はCloudflareチャレンジ対象。CSRFは `/items` からscrapeする。

const BASE = "https://manage.booth.pm";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// PATCH /items/{id} の item オブジェクトで更新できるフィールド（実証済み）。
const ITEM_FIELDS = [
  "name",
  "description",
  "page_design",
  "state",
  "tags_array",
  "category_id",
  "adult",
  "purchase_limit",
  "preorder_enabled",
];

export class BoothClient {
  constructor(cookie) {
    if (!cookie || !cookie.trim()) {
      throw new Error(
        "BOOTH_COOKIE が未設定です。manage.booth.pm のログイン済みcookie（少なくとも _plaza_session_* を含むCookieヘッダ全体）を渡してください。"
      );
    }
    this.cookie = cookie.trim();
    this._csrf = null;
  }

  _headers(extra = {}) {
    return { "User-Agent": UA, Cookie: this.cookie, ...extra };
  }

  async csrf() {
    if (this._csrf) return this._csrf;
    const r = await fetch(`${BASE}/items`, {
      headers: this._headers({ Accept: "text/html" }),
      redirect: "manual",
    });
    if (r.status === 302 || r.status === 301) {
      throw new Error(
        `cookieが無効かログイン切れです（${BASE}/items が ${r.status} でログインへリダイレクト）。cookieを取り直してください。`
      );
    }
    if (!r.ok) throw new Error(`CSRFトークン取得に失敗: HTTP ${r.status}`);
    const html = await r.text();
    const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
    if (!m) throw new Error("CSRFトークンがページ内に見つかりませんでした。");
    this._csrf = m[1];
    return this._csrf;
  }

  async _json(res) {
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    if (!text) return { status: res.status };
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`JSONではないレスポンス: ${text.slice(0, 300)}`);
    }
  }

  // 認証必須GET（302はログイン切れとして明示）。
  async _authGet(path, accept = "application/json") {
    const r = await fetch(`${BASE}${path}`, {
      headers: this._headers({ Accept: accept }),
      redirect: "manual",
    });
    if (r.status === 302 || r.status === 301) {
      throw new Error(`cookieが無効かログイン切れです（${path} が ${r.status}）。`);
    }
    return r;
  }

  async _mutate(method, path, { json, formData } = {}) {
    const csrf = await this.csrf();
    const headers = this._headers({ Accept: "application/json", "X-CSRF-Token": csrf });
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (formData !== undefined) {
      body = formData;
    }
    const r = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    return this._json(r);
  }

  async getItem(id) {
    return this._json(await this._authGet(`/items/${id}`));
  }

  async listItems() {
    const r = await this._authGet(`/items`, "text/html");
    if (!r.ok) throw new Error(`一覧取得に失敗: HTTP ${r.status}`);
    const html = await r.text();
    const ids = [...new Set([...html.matchAll(/booth\.pm\/items\/(\d+)/g)].map((m) => m[1]))];
    const items = [];
    for (const id of ids) {
      try {
        const it = await this.getItem(id);
        items.push({
          id: it.id,
          name: it.name,
          state: it.state,
          price: it.price,
          url: it.url,
          images: (it.images || []).length,
          downloadables: (it.downloadables || []).map((d) => ({ id: d.id, name: d.name })),
        });
      } catch {
        items.push({ id: Number(id), name: "(取得失敗)" });
      }
    }
    return items;
  }

  // 商品フィールド更新（read-modify-write）。priceは含めない（setPrice参照）。
  async updateItem(id, fields) {
    const unknown = Object.keys(fields).filter((k) => !ITEM_FIELDS.includes(k));
    if (unknown.length) {
      throw new Error(
        `未対応の更新フィールド: ${unknown.join(", ")}（対応: ${ITEM_FIELDS.join(", ")}。価格はsetPrice、画像/DLは専用メソッド）`
      );
    }
    const item = await this.getItem(id);
    Object.assign(item, fields);
    // page_design はオブジェクトだと無視される。JSON文字列で送る（実測）。
    if (item.page_design && typeof item.page_design === "object") {
      item.page_design = JSON.stringify(item.page_design);
    }
    return this._mutate("PATCH", `/items/${id}`, { json: { item } });
  }

  // 価格変更: item.price と 全variationのprice を揃えて更新（UI表示と整合させるため両方叩く）。
  async setPrice(id, price) {
    if (typeof price !== "number" || price < 0) throw new Error("priceは0以上の数値で指定してください。");
    const item = await this.getItem(id);
    item.price = price;
    for (const v of item.variations || []) v.price = price;
    await this._mutate("PATCH", `/items/${id}`, { json: { item } });
    if ((item.variations || []).length) {
      await this._mutate("POST", `/items/${id}/variations`, { json: { variations: item.variations } });
    }
    return { ok: true, price };
  }

  // variationsを直接更新（在庫・複数バリエーション等の細かい制御用）。
  async updateVariations(id, variations) {
    await this._mutate("POST", `/items/${id}/variations`, { json: { variations } });
    return { ok: true };
  }

  // ---- 段落本文（page_design.modules）----
  // 既存モジュールは種類問わず verbatim で保持し、テキスト段落だけ足す/編集する。
  async getModules(id) {
    const it = await this.getItem(id);
    return { item: it, modules: (it.page_design && it.page_design.modules) || [] };
  }

  async _setModules(item, modules) {
    // 注: page_design はオブジェクトで送ると無視される。JSON文字列で送る必要がある（実測）。
    const pd = { ...(item.page_design || {}), modules };
    item.page_design = JSON.stringify(pd);
    return this._mutate("PATCH", `/items/${item.id}`, { json: { item } });
  }

  // テキスト段落を追加。position 省略で末尾、0で先頭、負数で末尾からの位置。
  async addParagraph(id, title, content, position) {
    const { item, modules } = await this.getModules(id);
    const mod = { type: "text", title: title || "", content: content || "" };
    let idx = position === undefined || position === null ? modules.length : position;
    if (idx < 0) idx = modules.length + idx + 1;
    idx = Math.max(0, Math.min(idx, modules.length));
    const next = [...modules.slice(0, idx), mod, ...modules.slice(idx)];
    await this._setModules(item, next);
    return { ok: true, inserted_at: idx, module_count: next.length };
  }

  async editParagraph(id, index, fields) {
    const { item, modules } = await this.getModules(id);
    if (index < 0 || index >= modules.length) {
      throw new Error(`段落indexが範囲外: ${index}（0〜${modules.length - 1}）`);
    }
    const cur = modules[index];
    if (cur.type !== "text") {
      throw new Error(`index ${index} はtext段落ではありません（type=${cur.type}）。壊さないため編集を中止。`);
    }
    const next = [...modules];
    next[index] = {
      ...cur,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.content !== undefined ? { content: fields.content } : {}),
    };
    await this._setModules(item, next);
    return { ok: true, index, module_count: next.length };
  }

  async deleteParagraph(id, index) {
    const { item, modules } = await this.getModules(id);
    if (index < 0 || index >= modules.length) {
      throw new Error(`段落indexが範囲外: ${index}（0〜${modules.length - 1}）`);
    }
    const removed = modules[index];
    const next = modules.filter((_, i) => i !== index);
    await this._setModules(item, next);
    return { ok: true, removed: { type: removed.type, title: removed.title }, module_count: next.length };
  }

  // 段落の並べ替え。order は希望順のindex配列（現在の全段落を過不足なく含める）。
  async reorderParagraphs(id, order) {
    const { item, modules } = await this.getModules(id);
    const sorted = [...order].sort((a, b) => a - b);
    const expected = modules.map((_, i) => i);
    if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
      throw new Error(`orderは現在の全段落index [0..${modules.length - 1}] を過不足なく含めてください。`);
    }
    const next = order.map((i) => modules[i]);
    await this._setModules(item, next);
    return { ok: true, module_count: next.length };
  }

  // ---- ダウンロードファイル ----
  async uploadDownload(id, fileBuffer, filename) {
    const fd = new FormData();
    fd.append("downloadable[file]", new Blob([fileBuffer], { type: "application/octet-stream" }), filename);
    return this._mutate("POST", `/items/${id}/downloadables`, { formData: fd });
  }

  async deleteDownload(id, downloadableId) {
    return this._mutate("DELETE", `/items/${id}/downloadables/${downloadableId}`);
  }

  // ZIP差し替え（新アップロード→旧削除）。
  async replaceDownload(id, fileBuffer, filename, { deleteOld = true } = {}) {
    const before = await this.getItem(id);
    const oldFiles = (before.downloadables || []).map((d) => ({ id: d.id, name: d.name }));
    await this.uploadDownload(id, fileBuffer, filename);
    const mid = await this.getItem(id);
    const added = (mid.downloadables || []).filter((d) => !oldFiles.some((o) => o.id === d.id));
    if (added.length === 0) throw new Error("アップロード後に新規ファイルが検出できませんでした。");
    const deleted = [];
    if (deleteOld) {
      for (const o of oldFiles) {
        await this.deleteDownload(id, o.id);
        deleted.push(o);
      }
    }
    const after = await this.getItem(id);
    return {
      added: added.map((d) => ({ id: d.id, name: d.name, file_size: d.file_size })),
      deleted,
      current: (after.downloadables || []).map((d) => ({ id: d.id, name: d.name })),
    };
  }

  // ---- 商品画像 ----
  async uploadImage(id, fileBuffer, filename) {
    const type = filename.toLowerCase().endsWith(".png")
      ? "image/png"
      : filename.toLowerCase().endsWith(".gif")
      ? "image/gif"
      : "image/jpeg";
    const fd = new FormData();
    fd.append("image[file]", new Blob([fileBuffer], { type }), filename);
    return this._mutate("POST", `/items/${id}/images`, { formData: fd });
  }

  async deleteImage(id, imageId) {
    return this._mutate("DELETE", `/items/${id}/images/${imageId}`);
  }

  // 画像の並べ替え。ids は希望順の画像ID配列（先頭がメイン画像＝サムネ）。
  // BOOTHの reorder は「現在の並びから1枚だけ移動した並び」しか適用しない
  // （複数枚が同時に動く並びは HTTP 200 のまま無視される。2026-08-16 実測）。
  // 公式UIのドラッグ1回と同じ「1枚移動」の列に分解して順に送る。
  async reorderImages(id, ids) {
    const want = ids.map(String);
    const current = ((await this.getItem(id)).images || []).map((i) => String(i.id));
    if ([...want].sort().join(",") !== [...current].sort().join(",")) {
      throw new Error(
        `image_idsは現在の全画像ID [${current.join(", ")}] を過不足なく含めてください。`
      );
    }
    for (let i = 0; i < want.length; i++) {
      if (current[i] === want[i]) continue;
      current.splice(current.indexOf(want[i]), 1);
      current.splice(i, 0, want[i]);
      await this._mutate("PATCH", `/items/${id}/images/reorder`, {
        json: { image: { ids: [...current] } },
      });
    }
    const after = ((await this.getItem(id)).images || []).map((i) => String(i.id));
    if (after.join(",") !== want.join(",")) {
      throw new Error(
        `並べ替えがBOOTH側に反映されませんでした（要求: ${want.join(",")} / 現在: ${after.join(",")}）。`
      );
    }
    return { ids: after };
  }
}

export { ITEM_FIELDS };
