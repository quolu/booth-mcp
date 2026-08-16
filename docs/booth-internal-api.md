# BOOTH 内部API 偵察結果（2026-08-15 実測）

BOOTH管理画面（manage.booth.pm）の商品更新を、UI操作なしのHTTPだけで行うための実測仕様。
自分のショップの非公開商品（実験用）で read-modify-write 往復を実証済み。

## エンドポイント

| 操作 | メソッド/URL | 備考 |
|---|---|---|
| 商品一覧 | `GET https://manage.booth.pm/items` | HTML（商品リスト）。JSON APIは要調査 |
| 商品取得 | `GET https://manage.booth.pm/items/{id}` | `Accept: application/json` で商品全データのJSON |
| 商品更新 | `PATCH https://manage.booth.pm/items/{id}` | body: `{"item": {…GETで得た商品オブジェクト…}}` |
| バリエーション更新 | `POST https://manage.booth.pm/items/{id}/variations` | body: `{"variations":[…]}`。UIの保存はPATCHとセットで送る |
| DLファイル追加 | `POST https://manage.booth.pm/items/{id}/downloadables` | **FormData**、フィールド名 `downloadable[file]`。実証200 |
| DLファイル削除 | `DELETE https://manage.booth.pm/items/{id}/downloadables/{dl_id}` | 実証200 |
| 画像追加 | `POST https://manage.booth.pm/items/{id}/images` | **FormData**、フィールド名 `image[file]`（.jpg/.jpeg/.gif/.png、複数可）。実証200、レスポンス`{files}` |
| 画像削除 | `DELETE https://manage.booth.pm/items/{id}/images/{image_id}` | 実証204 |
| 画像並べ替え | `PATCH https://manage.booth.pm/items/{id}/images/reorder` | body `{"image":{"ids":["<id>",...]}}`（**文字列ID配列**）。実証200。**罠: 現在の並びから「1枚だけ移動した並び」しか適用されない**。複数枚が同時に動く並び（全逆順等）は HTTP 200 のまま黙って無視される（2026-08-16 実測）。任意の並びは1枚移動の列に分解して連続送信する（booth-mcp の `reorderImages` が自動でやる）。ヘッダ（Origin/Referer/X-Requested-With/UA）は無関係 |
| 価格・在庫更新 | `POST https://manage.booth.pm/items/{id}/variations` | body `{"variations":[{…GETのvariations要素にprice/stock等を反映…}]}`。実証200 |

### ZIP差し替え（バージョンアップ）の手順 ＝ 実証済みレシピ

1. `GET /items/{id}` で現在の `downloadables[]` を取得（旧ファイルの `id` を控える）
2. `POST /items/{id}/downloadables`（FormData `downloadable[file]` = 新ZIP）→ 新ファイルが追加される
3. `DELETE /items/{id}/downloadables/{旧id}` で旧ファイルを削除
4. （必要なら）`PATCH /items/{id}` で説明文のバージョン番号等を更新

- アップロードUIは `<input type=file>` を持たず**D&Dゾーンのみ**。ブラウザ自動化するならdropイベント合成が要る。**が、HTTPで直接POSTすれば不要**（MCPサーバーはこちら）。
- モーダルの「チェックをつけたファイルがユーザーに提供されます」= 提供対象の選択。アップロード直後の新ファイルは提供対象に入る挙動（要最終確認）。
- 対応形式: .psd .ai .lip .pdf .mp3 .m4a .wav .aif .aiff .flac .epub .vroid .vroidcustomitem .vrm .vrma .xwear .xavatar .xroid .jpg .jpeg .gif .png .mp4 .mov .avi .zip .rar / 1ファイル1.2GBまで / 総容量2.7GB(標準10GB)

- 在庫系は `GET /items/{id}?optimistic_locking_for_stock=1` という楽観ロック付き取得もある。
- UIの「保存」= PATCH（商品本体）+ POST variations の2連発。両方200で成功。

## 認証・ヘッダ

- ログインセッションcookie（ブラウザのログイン状態）
- `X-CSRF-Token`: 編集ページの `<meta name="csrf-token">` から取得
- `Content-Type: application/json`

## 商品JSONの主なフィールド（全48キー中の編集対象）

PATCH `/items/{id}`（body `{item:{…}}`）で更新できる（read-modify-write推奨）:
- `name` 商品名
- `description` 商品紹介文（プレーン）
- `page_design.modules[]` 段落本文。各要素 `{type:"text", title, content}`（改行は`\n`）。他type（image/embed等）もあり得る。**⚠️ page_designは必ずJSON文字列で送る**（`item.page_design = JSON.stringify({modules:[...]})`）。オブジェクトのまま送るとPATCHは200を返すが黙って無視される（実測）。既存modulesは種類問わずverbatim保持して追記する
- `state` `"public"` / `"private"`
- `price` 価格（**item.priceだけでなく variations[].price も更新しないとUI表示と不整合。価格変更は下のvariations POSTと併用**）
- `tags_array` タグ（string配列）
- `category_id` カテゴリID（数値。候補は同JSONの`category_ids[]`）
- `adult` `"true"`（R18）/ `"false"`（全年齢）
- `purchase_limit` 購入制限数（0=無制限）
- `item_message_for_twitter` X共有文
- `preorder_enabled` 予約販売

画像は**PATCHのimages配列では並び替わらない**（swapped=false実証）。並べ替えは専用の reorder エンドポイントを使う。

価格・在庫は variations POST:
- `variations[]` 各 `{id,name,type,stock,price,margin,production_cost,item_id,display_order,...}`

## 実証手順（ブラウザページ文脈のfetchで実行）

1. GET で商品JSON取得
2. `description` 末尾へマーカー追記 → PATCH → 200
3. GET で反映確認（marked: true）
4. 元の説明文へ PATCH → 200、完全復元確認

## 罠（caveat 実証済み）

- **Node（v22 native fetch/undici）は booth.pm のCloudflareを通過する**（2026-08-15実測: `booth.pm/ja`→200/195KB実ページ、`manage.booth.pm/items`→未ログインで正常302）。→ **MCPサーバーは純Nodeでよい。curl_cffi不要。**
- **Python素のhttpx/requestsは booth.pm のCloudflareにTLS指紋で403弾き**される。Pythonで叩くなら curl_cffi の impersonate か system curl。
  （caveat: `booth-pm-cloudflare-blocks-httpx-requests-with-403-...`）
- **編集UIのtextareaへの値注入（fill/.value=）は保存されない**（React制御state不整合）。UI自動化はせずAPIを使うこと。
  （caveat: `booth-react-textarea-fill-value`）
- **セッションcookieはhttpOnly**で `document.cookie` からは取れない（2026-08-15確認: 読めるのは `_ga` 系のみ、本命のRailsセッションcookie `_plaza_session_*` は隠れている）。外部プロセス（MCPサーバー）から叩くには、(a)DevToolsで手動コピー、(b)Chrome拡張の `chrome.cookies` API で吸い出す、のいずれかが必要。
- **CSRFトークン**は編集ページHTMLの `<meta name="csrf-token">`（86文字）にある。SPAはこれを1回読んで全XHRの `X-CSRF-Token` に使い回す。MCPサーバーも同様に、認証済みHTMLページを1回GETしてscrapeすればよい。

## 認証アーキテクチャの決定事項

MCPサーバー（純Node）が必要とするもの:
1. **セッションcookie**（httpOnly、手動コピー or 拡張で吸出し）
2. **CSRFトークン**（認証済みページをGETして meta からscrape。cookieさえあれば自動取得可）

## 未調査

- 商品画像（サムネ）アップロードのエンドポイント（`POST /items/{id}/images` ？ 要確認）
- 商品新規作成（`POST /items` ？）
- セッションcookieの寿命（remember-me有無）
- 商品一覧のJSON API（現状HTMLスクレイプ）
