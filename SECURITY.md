# セキュリティ / Security

## 取り扱う資格情報について

このツールは **BOOTHのログインセッションcookie** を使って manage.booth.pm にアクセスします。
このcookieはアカウントへのアクセス権そのものです。次の点に注意してください。

- cookieは `booth-mcp/.env` または `booth-mcp/.cookie` に平文で保存されます。
  どちらも `.gitignore` 済みですが、**コミット・共有・スクリーンショットに含めない**でください。
- `booth-cookie-sync/host/sync.log` にはcookieの**値は記録しません**（長さのみ）。
- cookieが漏れたと思ったら、BOOTHでログアウト（全セッション無効化）してから再ログインしてください。
- 送信先は `https://manage.booth.pm` のみです。第三者のサーバーへは一切送信しません。

### 保存されるもの

| ファイル | 内容 | git管理 |
|---|---|---|
| `booth-mcp/.env` | cookie（手動設定時） | 除外 |
| `booth-mcp/.cookie` | cookie（拡張が自動更新） | 除外 |
| `booth-cookie-sync/host/sync.log` | 同期時刻・cookie長 | 除外 |
| `.mcp.json` | ローカルのMCP設定 | 除外 |

## 脆弱性の報告

セキュリティ上の問題を見つけた場合は、**公開Issueではなく**
[GitHub Security Advisories](https://github.com/quolu/booth-mcp/security/advisories/new) から
非公開で報告してください。

## Reporting a vulnerability

This tool stores a BOOTH session cookie in plain text locally (git-ignored) and sends it only to
`https://manage.booth.pm`. If you find a security issue, please report it privately via
[GitHub Security Advisories](https://github.com/quolu/booth-mcp/security/advisories/new)
rather than opening a public issue.
