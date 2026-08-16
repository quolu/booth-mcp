# 開発・貢献ガイド

## 最重要: cookieをコミットしない

このリポジトリはBOOTHのセッションcookieを扱います。次のファイルは `.gitignore` 済みです。
**絶対に `git add -f` などで追加しないでください。**

- `booth-mcp/.env` / `booth-mcp/.cookie`
- `.mcp.json`（端末固有の絶対パスを含みうる）
- `booth-cookie-sync/host/sync.log`

Issue やPRにログを貼るときは、cookie値・セッションIDを必ず伏せてください。

## 開発環境

```bash
cd booth-mcp
npm install
cp .env.example .env   # BOOTH_COOKIE と ITEM_ID を記入
```

`ITEM_ID` には**書き換えてよい実験用の商品**（非公開・下書き）を指定してください。
公開中の商品を対象にすると、実データが書き換わります。

## テスト

受入テストは実サーバーに対して「変更→確認→復元」を行う非破壊テストです。

```bash
ITEM_ID=<実験用の商品ID> node --env-file=.env src/probe.js
```

全項目が ✅ になり、最後に「実験台は完全に原状復帰」が出れば成功です。

## BOOTHの仕様変更で壊れたら

このツールは非公式の内部エンドポイントを叩いています。BOOTH側の変更で動かなくなった場合：

1. ブラウザのDevTools（Network）で、管理画面が実際に送っているリクエストを確認する
2. [docs/booth-internal-api.md](docs/booth-internal-api.md) の記載と突き合わせる
3. 差分を同ドキュメントに反映してからコードを直す

過去に踏んだ罠（`page_design` はJSON文字列で送る必要がある、など）も同ドキュメントにまとまっています。

## コードの方針

- 依存を増やさない（現状 `@modelcontextprotocol/sdk` のみ、あとはNode標準）
- 失敗は握りつぶさず例外にする。静かなフォールバックを入れない
- 既存データを壊さない（例: 段落操作は未知のモジュール種別もそのまま保持する）
