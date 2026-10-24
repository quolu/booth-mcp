# booth-mcp

BOOTH（manage.booth.pm）の商品管理を、ブラウザ操作なしにHTTPで直接叩くローカルMCPサーバー。
OLTranslator / LiveTR などの商品更新（説明文の書き換え・ZIPのバージョンアップ）を数秒で終わらせるために作った。

## 仕組み

- 純Node（native fetch / undici）。booth.pm のCloudflare TLSゲートはNodeなら通過する（curl_cffi不要・実測済み）。
- 認証はログイン済みセッションcookie（httpOnly）を環境変数 `BOOTH_COOKIE` で供給。
- CSRFトークンは認証済みページから自動scrapeするので手入力不要。
- 内部APIの詳細は [`../docs/booth-internal-api.md`](../docs/booth-internal-api.md)。

## セットアップ

```bash
cd booth-mcp
npm install
cp .env.example .env   # .env に BOOTH_COOKIE を記入（下記）
```

### cookieの入れ方

**推奨: 自動同期**（[`../booth-cookie-sync`](../booth-cookie-sync/)）を入れると `.cookie` が自動更新され、
手作業は一切不要になる。以下は手動で入れる場合。

1. Chromeで https://manage.booth.pm にログイン
2. F12 → **Application** → 左の Cookies → `https://manage.booth.pm`
3. `_plaza_session_` で始まる行の Name と Value を `名前=値` の形で
   `.env` の `BOOTH_COOKIE=` に貼る（`.env.example` をコピーして作る）

cookieはログイン切れで無効になる。その時は取り直す（自動同期なら再ログインだけでよい）。

### cookieの解決順

1. 環境変数 `BOOTH_COOKIE_FILE` が指すファイル（未指定なら`booth-mcp/.cookie`）
2. 環境変数 `BOOTH_COOKIE`（上のファイルが無いか空の場合）
3. `booth-mcp/.env` の `BOOTH_COOKIE=` 行

`BOOTH_COOKIE_FILE`を指定した場合、既定の`.cookie`は使わない。

## 受入テスト（非破壊）

実験用の商品（**非公開・下書き推奨**）に対し、全機能を「変更→確認→復元」で検証する：

```bash
ITEM_ID=<実験用の商品ID> node --env-file=.env src/probe.js
```

## MCPサーバーとして登録

Claude Code の場合、リポジトリ直下に `.mcp.json` を置く（`.mcp.json.example` をコピー）:

```json
{
  "mcpServers": {
    "booth": {
      "command": "node",
      "args": ["booth-mcp/src/index.js"]
    }
  }
}
```

cookieは上記の解決順で自動的に読まれるので、設定への書き込みは不要。
別の場所から起動する場合は `args` を絶対パスにする。

### MacBookでの登録

[cookie同期のMac手順](../booth-cookie-sync/README.md#macbookのセットアップchrome)を済ませ、
リポジトリ直下で次を実行すると、このMacのNodeとMCP本体の絶対パスを使う設定を表示できる：

```sh
node --input-type=module -e 'import {resolve} from "node:path"; console.log(JSON.stringify({mcpServers:{booth:{command:process.execPath,args:[resolve("booth-mcp/src/index.js")]}}},null,2))'
```

表示結果の`booth`設定を利用中のMCPクライアントへ登録する。cookieは設定へ書かない。
ファイルのアップロードには、このMacから読めるローカルパスを渡す。
Windowsの`C:\\...`というパスはMacから使えない。

### Codexでの登録

`.mcp.json`の例だけではCodexの登録を済ませたことにはならない。
利用中のユーザー/信頼済みプロジェクトの`.codex/config.toml`へ、実際のNodeとサーバーの絶対パスを指定する：

```toml
[mcp_servers.booth]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/booth-mcp/booth-mcp/src/index.js"]
```

既存設定を保持して追加し、対象クライアントのMCP一覧で道具が認識されたか確認する。
実行中の会話に反映済みとは推測せず、進行中の作業を中断しない。
公式仕様: [CodexのMCP登録](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## ツール（全17種）

| ツール | 用途 |
|---|---|
| `booth_list_items` | 商品一覧（id/名前/状態/価格/URL/画像数/DLファイル） |
| `booth_get_item` | 商品の全データ取得 |
| `booth_update_item` | 商品名/説明文/段落本文/公開状態/タグ/カテゴリ/R18/購入制限/予約販売を更新 |
| `booth_list_paragraphs` | 商品紹介の段落をindex付きで一覧 |
| `booth_add_paragraph` | 段落（見出し＋本文）を追加（既存は種類問わず保持） |
| `booth_edit_paragraph` / `booth_delete_paragraph` / `booth_reorder_paragraphs` | 段落の編集 / 削除 / 並べ替え |
| `booth_set_price` | 価格変更（item＋全variation連動） |
| `booth_update_variations` | バリエーション直接更新（在庫・別価格など） |
| `booth_replace_download` | ZIP差し替え（新アップロード＋旧削除）＝バージョンアップ |
| `booth_upload_download` / `booth_delete_download` | DLファイル追加 / 削除 |
| `booth_download_and_verify` | 管理側ファイルを再取得して、期待SHA-256・サイズ・任意のvariation紐付けを確認。検証成功後に新しいローカルファイルへ保存 |
| `booth_upload_image` / `booth_delete_image` / `booth_reorder_images` | 商品画像 追加 / 削除 / 並べ替え |

再取得の引数は`item_id`、`downloadable_id`、保存先の絶対パス`file_path`、照合元の`expected_sha256`が必須。
`expected_size`省略時は商品情報の`file_size`を使う。`variation_id`を渡した場合だけ、その紐付けの一致も検証する。
返却値は`bytes`、`sha256`、`sha256_matched`、`size_matched`、`variation_verified`、`linked_variation_ids`など。
検証不一致・途中失敗で一時ファイルを削除し、既存の保存先を上書きしない。認証cookieと転送URLは結果へ含めない。

## cookie自動同期（推奨）

手貼りの代わりに、`../booth-cookie-sync`（Chrome拡張＋ネイティブホスト）を入れると
cookieが自動で `.cookie` に同期され、booth-mcpは毎回それを読み直す（**再起動不要・手貼り不要**）。
サーバーは実行ファイルの位置を基準に`.cookie`と`.env`を読み込む。作業ディレクトリに依存しない。

## 対応できないこと（実測で確認）

- **X共有文（`item_message_for_twitter`）は変更不可** … サーバーが「商品名 | ショップ名」で自動生成。PATCHは200を返すが無視される。
- 商品の**新規作成**、商品画像の**トリミング指定**は未対応（今回のスコープ外。必要なら追加偵察）。

## 制限

- 極端に小さい画像はBOOTH側が拒否（`booth_upload_image`はエラーを返す）。
- cookie失効時は再ログイン（自動同期を入れていれば再ログインだけで復帰）。
