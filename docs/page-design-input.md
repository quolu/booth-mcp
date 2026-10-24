# page_designをそのまま渡す入力

BOOTH-MCPは、AIからBOOTHの操作を正しく呼べる薄い接続層とする。
操作の選択・組合せ・公開/価格等の判断は呼出元AIが持つ。

`booth_update_item`にBOOTHの`page_design`全体を渡す入力を追加する。
オブジェクトまたはJSON文字列を受け、既存クライアントのJSON文字列化で送る。
型のホワイトリスト、URLの独自制限、プレビュー/指紋確認等の必須手順は加えない。

```json
{
  "item_id": 1234567,
  "page_design": {
    "modules": [
      {"type": "text", "title": "紹介", "content": "説明"},
      {"type": "media", "content": "<iframe src=\"https://www.youtube.com/embed/M7lc1UVf-VE\"></iframe>"}
    ]
  }
}
```

これは動画ファイルの編集ではなく、BOOTHの商品紹介のデータを更新するもの。
`page_design`はBOOTHと同じ**全文置換**であり、保持したい既存データは呼出元が含める。
未知のキーやmodule型もそのまま転送する。MCP側で別のmoduleを追加/削除したり内容を判断したりしない。

従来の`page_design_modules`も継続し、type省略時だけ従来どおりtextを補う。
指定されたtypeと未知キーは維持する。両入力の同時指定は曖昧なため拒否する。
既存の公開切替イベント・価格/variation・認証の処理は変更しない。

## 確認済みと未確認

- `page_design`のJSON文字列保存: 既存処理で実証済み。
- YouTubeのreadback: `modules`内の`{type:'media',content:'<iframe ...>'}`が2026-10-24に報告された。
- YouTubeのembed URL形式は[公式資料](https://developers.google.com/youtube/player_parameters)に基づく例であり、MCPのURL制限ではない。
- BOOTHの動画UI送信payloadと保存時正規化: 未捕捉。架空データの試験を実API書込成功とはしない。
- 新規DL作成のendpoint/必須payload、代理購入設定の送信形式: 未確認。readbackの値だけで実装しない。

模擬APIへのstdio呼出しで転送を検証する。これはBOOTH側での任意mediaの保存や動画再生までを保証する試験ではない。
実商品への書込み試験は行わない。
