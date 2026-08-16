#!/usr/bin/env node
// BOOTH 商品管理 MCPサーバー（stdio）。
// 認証は環境変数 BOOTH_COOKIE、または BOOTH_COOKIE_FILE が指すファイル（拡張による自動更新用）で供給する。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BoothClient } from "./booth.js";

// パスはすべてこのスクリプトの位置から解決する（絶対パスの設定焼き込みを不要にする）。
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCookie() {
  // 優先順: ①BOOTH_COOKIE_FILE（明示指定） ②<pkg>/.cookie（拡張が自動更新）
  //         ③環境変数BOOTH_COOKIE ④<pkg>/.env の BOOTH_COOKIE 行
  const file = process.env.BOOTH_COOKIE_FILE || join(PKG_DIR, ".cookie");
  if (existsSync(file)) {
    const v = readFileSync(file, "utf8").trim();
    if (v) return v;
  }
  if (process.env.BOOTH_COOKIE) return process.env.BOOTH_COOKIE;
  const envPath = join(PKG_DIR, ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^BOOTH_COOKIE=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

// cookieはツール呼び出しごとに読み直す（拡張がファイルを更新したら次の呼び出しから反映）。
function client() {
  return new BoothClient(loadCookie());
}

const TOOLS = [
  {
    name: "booth_list_items",
    description:
      "自分のBOOTH商品一覧を返す（id, 商品名, 公開状態, 価格, URL, 画像数, DLファイル）。どの商品を操作するか特定するのに使う。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "booth_get_item",
    description:
      "指定IDのBOOTH商品の全データを返す（説明文・段落本文page_design・価格・タグ・カテゴリ・画像一覧・DLファイル・バリエーション等）。",
    inputSchema: {
      type: "object",
      properties: { item_id: { type: "number", description: "商品ID" } },
      required: ["item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_update_item",
    description:
      "BOOTH商品の情報を更新する。指定したフィールドだけ変更し、他は現状維持。対応: 商品名/説明文/段落本文(page_design)/公開状態/タグ/カテゴリ/R18/購入制限/予約販売。価格はbooth_set_price、画像・DLファイルは専用ツールを使う。X共有文はサーバー生成のため変更不可。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        name: { type: "string", description: "商品名" },
        description: { type: "string", description: "商品紹介文（プレーンテキスト、全文置換）" },
        page_design_modules: {
          type: "array",
          description:
            "段落本文（全置換）。各要素 {title, content}。既存を部分編集する時は booth_get_item で現状を取って加工して渡す",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "見出し" },
              content: { type: "string", description: "本文（改行は\\n）" },
            },
            required: ["title", "content"],
            additionalProperties: false,
          },
        },
        state: { type: "string", enum: ["public", "private"], description: "公開状態" },
        tags: { type: "array", items: { type: "string" }, description: "タグ（全置換）" },
        category_id: { type: "number", description: "カテゴリID（候補はbooth_get_itemのcategory_ids）" },
        adult: { type: "boolean", description: "R18商品ならtrue" },
        purchase_limit: { type: "number", description: "1人あたり購入制限数（0=無制限）" },
        preorder_enabled: { type: "boolean", description: "予約販売の有効化" },
      },
      required: ["item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_list_paragraphs",
    description:
      "商品紹介の段落(page_design)を index 付きで一覧する。段落の編集・削除・並べ替えの前に、対象indexを確認するのに使う。",
    inputSchema: {
      type: "object",
      properties: { item_id: { type: "number", description: "商品ID" } },
      required: ["item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_add_paragraph",
    description:
      "商品紹介にテキスト段落（見出し＋本文）を1つ追加する。既存段落は種類問わずそのまま保持。位置は省略で末尾。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        title: { type: "string", description: "見出し" },
        content: { type: "string", description: "本文（改行は\\n）" },
        position: {
          type: "number",
          description: "挿入位置（0=先頭、省略=末尾、負数=末尾から）",
        },
      },
      required: ["item_id", "title", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_edit_paragraph",
    description: "既存のテキスト段落を編集する（indexはbooth_list_paragraphsで確認）。text段落以外は保護のため拒否。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        index: { type: "number", description: "対象段落のindex" },
        title: { type: "string", description: "新しい見出し（省略で据え置き）" },
        content: { type: "string", description: "新しい本文（省略で据え置き）" },
      },
      required: ["item_id", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_delete_paragraph",
    description: "段落を1つ削除する（indexはbooth_list_paragraphsで確認）。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        index: { type: "number", description: "削除する段落のindex" },
      },
      required: ["item_id", "index"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_reorder_paragraphs",
    description: "段落を並べ替える。orderは希望順のindex配列（現在の全段落を過不足なく含める）。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        order: {
          type: "array",
          items: { type: "number" },
          description: "希望順のindex配列（例: [2,0,1]）",
        },
      },
      required: ["item_id", "order"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_set_price",
    description: "商品の価格を変更する（item本体と全バリエーションの価格を揃えて更新）。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        price: { type: "number", description: "新価格（円）" },
      },
      required: ["item_id", "price"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_update_variations",
    description:
      "バリエーションを直接更新する（在庫stock・バリエーション別価格などの細かい制御用）。booth_get_itemのvariationsを取得→加工して全量渡す。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        variations: {
          type: "array",
          description: "variations配列の全量（booth_get_itemの形式のまま）",
          items: { type: "object" },
        },
      },
      required: ["item_id", "variations"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_replace_download",
    description:
      "商品のダウンロードファイルを差し替える（バージョンアップ）。新ファイルをアップロードし、既定では旧ファイルを全削除する。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        file_path: { type: "string", description: "アップロードする新ファイルの絶対パス" },
        filename: { type: "string", description: "BOOTH上でのファイル名（省略時はfile_path名）" },
        delete_old: { type: "boolean", description: "旧ファイルを削除するか（既定true）" },
      },
      required: ["item_id", "file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_upload_download",
    description: "商品にダウンロードファイルを1つ追加する（既存は消さない）。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        file_path: { type: "string", description: "アップロードするファイルの絶対パス" },
        filename: { type: "string", description: "BOOTH上でのファイル名（省略可）" },
      },
      required: ["item_id", "file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_delete_download",
    description: "商品のダウンロードファイルを1つ削除する。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        downloadable_id: { type: "number", description: "削除するDLファイルのID（booth_get_itemで確認）" },
      },
      required: ["item_id", "downloadable_id"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_upload_image",
    description:
      "商品画像を追加する（.jpg/.jpeg/.gif/.png）。追加位置は末尾。順序変更はbooth_reorder_images。極端に小さい画像はBOOTH側で拒否される。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        file_path: { type: "string", description: "画像ファイルの絶対パス" },
      },
      required: ["item_id", "file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_delete_image",
    description: "商品画像を1枚削除する。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        image_id: { type: "number", description: "削除する画像のID（booth_get_itemのimagesで確認）" },
      },
      required: ["item_id", "image_id"],
      additionalProperties: false,
    },
  },
  {
    name: "booth_reorder_images",
    description: "商品画像を並べ替える。先頭がメイン画像（一覧サムネイル）になる。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "number", description: "商品ID" },
        image_ids: {
          type: "array",
          items: { type: "number" },
          description: "希望順の画像ID配列（全画像を含めること）",
        },
      },
      required: ["item_id", "image_ids"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "booth-mcp", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const result = await dispatch(name, args || {});
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

function summary(it) {
  return {
    id: it.id,
    name: it.name,
    state: it.state,
    price: it.price,
    tags: it.tags_array,
    images: (it.images || []).map((i) => i.id),
    downloadables: (it.downloadables || []).map((d) => ({ id: d.id, name: d.name })),
  };
}

async function dispatch(name, a) {
  const c = client();
  switch (name) {
    case "booth_list_items":
      return c.listItems();

    case "booth_get_item":
      return c.getItem(a.item_id);

    case "booth_update_item": {
      const fields = {};
      if (a.name !== undefined) fields.name = a.name;
      if (a.description !== undefined) fields.description = a.description;
      if (a.page_design_modules !== undefined)
        fields.page_design = {
          modules: a.page_design_modules.map((m) => ({ type: "text", ...m })),
        };
      if (a.state !== undefined) fields.state = a.state;
      if (a.tags !== undefined) fields.tags_array = a.tags;
      if (a.category_id !== undefined) fields.category_id = a.category_id;
      if (a.adult !== undefined) fields.adult = String(a.adult);
      if (a.purchase_limit !== undefined) fields.purchase_limit = a.purchase_limit;
      if (a.preorder_enabled !== undefined) fields.preorder_enabled = a.preorder_enabled;
      if (Object.keys(fields).length === 0) {
        throw new Error("更新するフィールドが1つも指定されていません。");
      }
      await c.updateItem(a.item_id, fields);
      return { ok: true, item: summary(await c.getItem(a.item_id)) };
    }

    case "booth_list_paragraphs": {
      const { modules } = await c.getModules(a.item_id);
      return {
        count: modules.length,
        paragraphs: modules.map((m, i) => ({
          index: i,
          type: m.type,
          title: m.title ?? null,
          content_preview: typeof m.content === "string" ? m.content.slice(0, 80) : null,
        })),
      };
    }

    case "booth_add_paragraph":
      return c.addParagraph(a.item_id, a.title, a.content, a.position);

    case "booth_edit_paragraph": {
      const fields = {};
      if (a.title !== undefined) fields.title = a.title;
      if (a.content !== undefined) fields.content = a.content;
      if (Object.keys(fields).length === 0) throw new Error("title か content のどちらかを指定してください。");
      return c.editParagraph(a.item_id, a.index, fields);
    }

    case "booth_delete_paragraph":
      return c.deleteParagraph(a.item_id, a.index);

    case "booth_reorder_paragraphs":
      return c.reorderParagraphs(a.item_id, a.order);

    case "booth_set_price": {
      await c.setPrice(a.item_id, a.price);
      const it = await c.getItem(a.item_id);
      return { ok: true, price: it.price, variation_prices: (it.variations || []).map((v) => v.price) };
    }

    case "booth_update_variations": {
      await c.updateVariations(a.item_id, a.variations);
      const it = await c.getItem(a.item_id);
      return { ok: true, variations: it.variations };
    }

    case "booth_replace_download": {
      const buf = await readFile(a.file_path);
      return c.replaceDownload(a.item_id, buf, a.filename || basename(a.file_path), {
        deleteOld: a.delete_old !== false,
      });
    }

    case "booth_upload_download": {
      const buf = await readFile(a.file_path);
      await c.uploadDownload(a.item_id, buf, a.filename || basename(a.file_path));
      const it = await c.getItem(a.item_id);
      return {
        ok: true,
        downloadables: (it.downloadables || []).map((d) => ({ id: d.id, name: d.name, file_size: d.file_size })),
      };
    }

    case "booth_delete_download":
      return c.deleteDownload(a.item_id, a.downloadable_id);

    case "booth_upload_image": {
      const buf = await readFile(a.file_path);
      await c.uploadImage(a.item_id, buf, basename(a.file_path));
      const it = await c.getItem(a.item_id);
      return { ok: true, images: (it.images || []).map((i) => i.id) };
    }

    case "booth_delete_image": {
      await c.deleteImage(a.item_id, a.image_id);
      const it = await c.getItem(a.item_id);
      return { ok: true, images: (it.images || []).map((i) => i.id) };
    }

    case "booth_reorder_images": {
      await c.reorderImages(a.item_id, a.image_ids);
      const it = await c.getItem(a.item_id);
      return { ok: true, images: (it.images || []).map((i) => i.id) };
    }

    default:
      throw new Error(`未知のツール: ${name}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("booth-mcp v0.3.0 ready");
