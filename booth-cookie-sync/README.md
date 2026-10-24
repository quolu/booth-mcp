# booth-cookie-sync

`manage.booth.pm` のログイン済みcookie（httpOnly含む）を、Chrome拡張の `chrome.cookies` API で読み取り、
ネイティブメッセージング経由で `booth-mcp` の `.env` と `.cookie` へ**自動同期**する。
これで booth-mcp のcookie手貼りが不要になる（ログインし続ける限り勝手に最新化）。

## 構成

- `extension/` … Chrome拡張（MV3）。cookie読み取り＋ホストへ送信。拡張IDは鍵固定で `lolkadambhklnhfambjfndlcnhmjjffb`
- `host/host.js` … ネイティブメッセージングホスト。受信cookieを `../../booth-mcp/.env`（`BOOTH_COOKIE`行）と `../../booth-mcp/.cookie` に書く
- `host/com.quolabo.booth_cookie_sync.json` … ネイティブホストのマニフェスト（`allowed_origins`に拡張IDを固定）
- `install.ps1` … レジストリ登録（Chrome/Edge、HKCU）
- `install.sh` / `install-macos.mjs` … macOSのChromeへ登録（ログイン中のユーザーだけ）

## Windowsのセットアップ（1回だけ）

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

そのあと：

1. `chrome://extensions` を開く → 右上「デベロッパーモード」ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `booth-cookie-sync\extension` を選択
3. 拡張IDが `lolkadambhklnhfambjfndlcnhmjjffb` であることを確認（違うと `allowed_origins` 不一致で動かない）
4. `manage.booth.pm` にログイン → 拡張アイコンをクリックで即同期

## MacBookのセットアップ（Chrome）

Node.js 18以降とGoogle Chromeが必要。Apple Silicon / Intelとも同じ手順を使う。
リポジトリ直下から実行する：

```sh
cd booth-mcp
npm ci
cd ..
sh booth-cookie-sync/install.sh
```

管理者権限は不要。登録先は
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.quolabo.booth_cookie_sync.json`。
インストール時のNodeの絶対パスを、生成する`host/run-host.sh`へ保存する。
ChromeをDockから開いた場合も、ターミナルのPATH設定に頼らず起動できる。
Nodeやリポジトリを移動した時は再登録する。別の配置が登録済みなら、元の配置で先にアンインストールする。

1. `chrome://extensions`で「デベロッパーモード」を有効にする。
2. 「パッケージ化されていない拡張機能を読み込む」で、このリポジトリの`booth-cookie-sync/extension`を選ぶ。
3. 拡張IDが`lolkadambhklnhfambjfndlcnhmjjffb`であることを確認する。
4. `https://manage.booth.pm`へログインし、拡張アイコンをクリックする。
5. ホストが見つからない場合は、Command-QでChromeを完全に終了して開き直す。

`.cookie`と`.env`は所有者だけが読み書きできる権限（0600）で保存する。
確認する時はファイルの存在・更新日時や`host/sync.log`を使い、cookie本文を共有しない。
MacのMCPクライアントへ登録する例は[booth-mcp/README.md](../booth-mcp/README.md#macbookでの登録)を参照。
SafariとFirefoxには対応していない。

以後は **cookie変更時・ブラウザ起動時・30分ごと** に自動同期。ログインが生きている限り booth-mcp は常に有効なcookieを持つ。

## 同期の確認

- `host/sync.log` に同期履歴が残る
- `booth-mcp/.cookie` が更新されていれば成功
- booth-mcp は `.cookie` を毎回読み直すので**サーバー再起動不要**

## アンインストール

Windows：

```powershell
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.quolabo.booth_cookie_sync"
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.quolabo.booth_cookie_sync"
```

macOS（リポジトリ直下から）：

```sh
sh booth-cookie-sync/install.sh --uninstall
```

この配置が登録したマニフェストと起動スクリプトを削除する。cookieとリポジトリは保持する。
別の配置が登録したマニフェストは削除しない。

拡張は `chrome://extensions` から削除。

## 注意

- Windowsでは`node`がPATHにある前提（Chromeが`run-host.bat`から起動する）。macOSは登録時にNodeの絶対パスを保存する。
- cookieは機密。`.env` / `.cookie` はgitignore済み。`host/sync.log` にcookie値は書かない（長さのみ）。
