# booth-cookie-sync

`manage.booth.pm` のログイン済みcookie（httpOnly含む）を、Chrome拡張の `chrome.cookies` API で読み取り、
ネイティブメッセージング経由で `booth-mcp` の `.env` と `.cookie` へ**自動同期**する。
これで booth-mcp のcookie手貼りが不要になる（ログインし続ける限り勝手に最新化）。

## 構成

- `extension/` … Chrome拡張（MV3）。cookie読み取り＋ホストへ送信。拡張IDは鍵固定で `lolkadambhklnhfambjfndlcnhmjjffb`
- `host/host.js` … ネイティブメッセージングホスト。受信cookieを `../../booth-mcp/.env`（`BOOTH_COOKIE`行）と `../../booth-mcp/.cookie` に書く
- `host/com.quolabo.booth_cookie_sync.json` … ネイティブホストのマニフェスト（`allowed_origins`に拡張IDを固定）
- `install.ps1` … レジストリ登録（Chrome/Edge、HKCU）

## セットアップ（1回だけ）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

そのあと：

1. `chrome://extensions` を開く → 右上「デベロッパーモード」ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `booth-cookie-sync\extension` を選択
3. 拡張IDが `lolkadambhklnhfambjfndlcnhmjjffb` であることを確認（違うと `allowed_origins` 不一致で動かない）
4. `manage.booth.pm` にログイン → 拡張アイコンをクリックで即同期

以後は **cookie変更時・ブラウザ起動時・30分ごと** に自動同期。ログインが生きている限り booth-mcp は常に有効なcookieを持つ。

## 同期の確認

- `host/sync.log` に同期履歴が残る
- `booth-mcp/.cookie` が更新されていれば成功
- booth-mcp は `.cookie` を毎回読み直すので**サーバー再起動不要**

## アンインストール

```powershell
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.quolabo.booth_cookie_sync"
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.quolabo.booth_cookie_sync"
```

拡張は `chrome://extensions` から削除。

## 注意

- `node` がPATHにある前提（Chromeが `run-host.bat` から `node host.js` を起動する）。
- cookieは機密。`.env` / `.cookie` はgitignore済み。`host/sync.log` にcookie値は書かない（長さのみ）。
