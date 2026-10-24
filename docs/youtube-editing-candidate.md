# YouTube編集の候補（未公開）

`booth-mcp/src/youtube.js`は動画編集の設計と架空データ検証用の候補。
MCPの17道具にはまだ接続しておらず、リリース・既存実配置の更新も行わない。

## 確認済みの仕様と残る確認

| 対象 | 根拠 | この候補での扱い |
| --- | --- | --- |
| `page_design`の保存 | 既存クライアントでJSON文字列化が実証済み | `_setModules`を再利用 |
| YouTubeの読戻し | 2026-10-24の商品担当報告で`{type:'media', content:'<iframe ...>'}` | mediaのcontentを生成する候補 |
| YouTube embed URL | [YouTube公式](https://developers.google.com/youtube/player_parameters)の`https://www.youtube.com/embed/VIDEO_ID` | HTTPS・許可したhost/動画IDからだけ生成 |
| BOOTHの動画UI送信payload・保存時の正規化 | 未捕捉・未検証 | 実API書込成功とはしない |
| 新規DL商品作成 | endpoint/必須payload未確認 | 実装・推測POSTなし |
| 代理購入設定 | readbackの`accept_proxy_shipping=unselected/refused`だけ確認 | PATCH可能性/全enumは未確認、更新道具なし |

## 候補の入力

`planYouTubeModule(item, options)`はHTTPを送らず、変更案と前後のpage_designのSHA-256を返す。
`editYouTubeModule(client, itemId, options)`は既定でプレビューのみ。

| 入力 | 条件 |
| --- | --- |
| `youtube_url` | 必須。HTTPSの単一動画。youtube.com/www/mのwatch/embed/shorts/live、youtu.be、youtube-nocookieのembedを許可 |
| `action` | `insert`（既定）または`replace` |
| `position` | insert時だけ。0〜現在module数の整数、省略で末尾。範囲外は拒否 |
| `index` | replace時に必須。既存のYouTube iframeを持つmediaだけ置換。ほかの種類・配信元は拒否 |
| `start_seconds` | 0〜2147483647の整数、省略0。URLのquery/fragmentは引き継がず、この値だけを使用 |
| `dry_run` | 真偽値、既定true |
| `expected_page_design_sha256` | 適用時に必須。プレビューの`previous_page_design_sha256`を渡す |

動画IDはこの候補の入力制約として英数/`_`/`-`の11文字に限定する。
入力されたHTMLやiframeは受け取らない。出力は640×360の固定iframeで、自動再生の指定を付けない。
URLのトラッキング・playlist・時刻等のqueryは生成HTMLに引き継がない。
これはYouTube上の動画存在・視聴権・埋込許可を確認する処理ではない。

## 保持・適用・失敗時

page_designの未知metadataと対象外の全moduleを保持し、元入力を変更しない。
置換では対象mediaのcontent以外のキーも保持する。key順だけの違いでfingerprintは変わらない。

適用は、プレビューのfingerprintと一致することを確認してから再GETする。
直前GETでもpage_designが一致する時だけ、最新の商品オブジェクトを使って1回PATCHする。
既存クライアントの`page_design` JSON文字列化を使い、再GETでpage_design全体を照合する。
同じ変更案ならPATCHを送らない。価格・公開状態・variationの変更機能は追加しない。

これは**サーバー側の原子的CASではない**。最後のGET〜PATCH間の競合を完全には防げない。
HTTP/通信失敗、保存後不一致は失敗として返す。自動再PATCH・自動復旧は行わず、現状を読み直してから判断する。
実際のBOOTH保存時のiframe正規化等が未確認なので、これだけで本番の編集成功を保証しない。

## 検証・公開条件

架空データでURL/入力制限、未知module保持、プレビューの書込0、古い案と直前変更の拒否、
JSON文字列での送信、ほかの最新商品フィールドの保持、読戻し、再送なしを検証する。
実APIへの商品作成/設定変更/probeは行わない。

公開道具への適用接続・リリース・実配置反映は、BOOTHの実送信/保存仕様と、合意された非公開試験対象での
読戻し/保持/復元条件を確認してから進める。公開商品をprobe対象にしない。
共有Codex設定、他製品の作業や予定管理、ブラウザ道具の修理はこの工程に含めない。
