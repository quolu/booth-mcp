# BOOTH-MCP 機能構造とデータフロー

対象は本体0.5.1候補（修理前main `9dccf00`）。所有者はBOOTH-MCP担当ナガ。機能図とDFDの正本は本書。2026-11-06のライフサイクル修理は下の設計を実装前に定めてから反映した。共有CLI設定・ホストruntime更新・商品内容や公開価格の判断は境界外。

## 機能図（現行）

| 機能 | 入力→出力、実装/呼出元 | 所有する状態と失敗 |
| --- | --- | --- |
| P1 MCP受付・認証供給 | stdio tools/list・call→17道具のschemaとtext JSON/isError。`booth-mcp/src/index.js`→P2/P3 | 呼出しごとに.cookie→環境変数→.envから認証を読む。アップロード入力は呼出元の既存fileをread。永続DB/商品copyを作らない |
| P2 BOOTH操作 | 商品一覧/GET、商品/段落/価格/variation/画像/ダウンロードの操作→BOOTHの保存結果。`src/booth.js`、`item-update.js` | cookie/CSRF/商品応答はprocess内。BOOTH側が商品状態を所有。入力の変換とエラー返却を担い、価格/公開等の判断は呼出元。未知のpage_designキーを保持 |
| P3 ZIP検証保存 | item/file/variation ID、既知SHA/size、絶対保存先→検証結果と完成file。`src/download.js:downloadAndVerify`、P1とtestsがcaller | 保存先の隣にhost/PID/UUID.partを排他的生成、サイズ/SHA/紐付け検査後に上書きせず公開。try/finallyで正常/例外時にpart削除。次の通常入口で同host停止writer/既完了pendingだけを回収。完成fileは呼出元の成果物、後片付け不足は結果のcleanup_pendingで分離 |
| P4 Cookie同期 | Chrome起動/変更/30分alarm/クリック→native message→cookie保存結果。`extension/background.js`→`host/host.js` | hostが.cookieと.envのBOOTH_COOKIEのみ上書き。他envキー保持、POSIX0600。専有通常sync.logは1MiB上限、超過時は末尾128KiB、同時writerもoffset上限内。保存エラーを応答し、ログ失敗はcookie同期を妨げない |
| P5 OS登録 | template/設置先/Node→launcherとnative manifest。`install.ps1`、`install.sh`→`install-macos.mjs:installMac` | Windowsは製品内manifestとHKCU登録、Macは製品launcherとユーザーChrome登録。Mac一時manifestはrename/finally削除。既別配置を保護。uninstallはcookieを残す。自動backupは作らない |
| P6 検証・配布 | source/lock/既fixture→テスト結果と配布source。`.github/workflows/ci.yml`、`test/`、`tests/` | Node標準testのt.after/finallyで専用tempを削除。build成果/独自cache/DBなし、依存はlockからnpm ci。CI cacheはCIの所有。自席保守/一回配布補助の保持は担当手順で管理 |

P1の17道具は既`src/index.js`のTOOLSを公開正本とする。P2の操作APIは[booth-internal-api.md](booth-internal-api.md)、P3は[パッケージREADME](../booth-mcp/README.md)、P4/P5は[同期README](../booth-cookie-sync/README.md)。機能数/JSON schemaを本書へ複製しない。

## データフロー図（現行、表形式）

外部主体E1=呼出元AI、E2=BOOTH管理API/CDN、E3=Chrome、E4=OS登録先、E5=開発/CI。ストアD1=認証2file（利用者データ、P4 writer/P1 reader）、D2=BOOTH商品（E2所有）、D3=ZIP part（P3専有）、D4=完成ZIP（呼出元所有）、D5=sync.log（P4診断）、D6=launcher/manifest（P5 writer/Chrome reader）、D7=source/lockと依存（開発者所有）、D8=試験temp（P6専有）。

| ID | 送信元→受信先 | データ・変換と失敗先 |
| --- | --- | --- |
| F1 | E1→P1 | 道具名/引数/既存アップロードfile絶対path。P1がschemaと操作をP2/P3へ対応付け |
| F2 | D1→P1→P2/P3 | 呼出し時cookie、管理originにだけ送る。値を永続ログへ出さない |
| F3 | P2→E2/D2 | 認証GET、CSRF付き更新JSON/FormData。商品writeは呼出元の依頼時だけ |
| F4 | E2/D2→P2→P1→E1 | 商品/保存応答→道具の結果JSON。HTTP/変換失敗はisErrorへ |
| F5 | P3→E2→P3 | 商品metadata、管理URLの認証要求、BOOTH許可HTTPS転送、ZIP stream。CDNへcookieを送らない |
| F6 | P3→D3→P3 | streamを600の専有partへ書込み、サイズ/SHAを逐次計算。例外/正常終了でpart削除。強制終了後は同host停止writerのpartを次の通常P3へ回収し、unknownは保持 |
| F7 | P3→D4、P3→P1→E1 | 再GETで紐付けを確認後、link/exclusive copyで公開し、path/bytes/SHAを返す。既存完成fileは保持 |
| F8 | E3→P4→D1 | cookieと同期理由のnative frame→.envの当該キーと.cookie。別envキーと権限を保持 |
| F9 | P4→D5、P4→E3 | 時刻/既知理由/長さ/エラーという診断metadata、フレーム化したok/error応答。D5は上限超過時に同fileの末尾だけを保持し回収、cookie本文は診断に不要 |
| F10 | D7/E4→P5→D6/E4 | template、設置path、通常Node解決→OS別登録。Macのpid.tmpはrename後/finallyで削除、異常はinstallerの非0へ |
| F11 | E5/D7→P6→D8 | fixtureとfake cookie/小ZIP、OS起動試験→一時出力。test後のt.after/finallyで回収 |
| F12 | P6→E5 | 結果/失敗と配布source。実Cookie/商品本文をfixtureや配布へ混ぜない |

## 2026-11-06 実装前に定めた変更と保持条件

P3はローカルの保存先directoryだけで、同一host識別子/PID/UUIDを含む専有partを作る。次の通常downloadで同host・正しい専有名・通常fileだけを調べ、元PIDへのsignal0がESRCHのときだけunlinkする。生存/権限不明/他host/旧UUID-only名/非通常fileは保持。完成file、別directory、利用者入力fileを走査/削除しない。P3は他processへpartの書込を委譲しないため、元processの不存在をそのpart writer終端の根拠にする。PID再利用は保持側へ倒す。F6へ「同host停止writerのpart→P3通常開始時の回収」を追加する。容量の大小・TTLだけで削除しない。

P4の診断writerを既log関数内で上限管理する。通常host起動/ログ書込でsync.logが1MiBを超えたら最後の128KiBから完整行だけを残し、1行も固定上限にする。別のrotated copyや日付backupを増やさず、同じD5へ書く。P4のcookie保存・応答契約とログ失敗時の扱いは保持。入力由来reasonは既同期理由だけを記録する。F9へ「上限超過の古い診断→同じD5の末尾保持による回収」を追加する。

レヴィアタン06:55の指導（同席docs/storage-consultations-20261106.md）を受領。既機能境界で十分、新GC基盤や無理なmodule分割は不要。P4はappendでなく固定上限内の明示offsetへ書き、同時rotationで旧sizeを読んだwriterでも1MiBを超えるoffsetに書かない。競合時に診断行の完全保存を保証しない既best-effort性を明記し、cookie保存結果をログ整理と混ぜない。P3は検証済み成果fileが公開済みなら、part削除失敗をdownload失敗へ変えず結果へcleanup_pending/cleanup_errorを付ける。通常の次download回収対象にそのpartを残し、既完成fileとlinkしたinodeを壊さない。copy fallbackの強制終了は部分的な最終pathが残り得る既限界で、利用者所有pathを自動削除しない。新しい全製品lock/復旧機構へ広げない。

P3自身のprocess内で公開後のunlinkに失敗したpathは、小さいSetへ「writer完了済み」と記録する。次の通常downloadはこのSetにあるpathを生存PIDの例外として回収でき、稼働中の他downloadは触らない。再起動後は同host停止PIDの規則へ戻る。回収済み/不在ならSetから外す。グローバルなlease/lockを追加しない。

回収は成果downloadとは独立した結果とする。既停止partの列挙/削除がEACCES等でできなくても新しいdownloadが可能なら続け、完成結果へcleanup_pending/cleanup_errorを添える。unknownの生存判定は回収しない。P4はsymlink/非通常file/複数hardlinkのsync.logを変更せず、利用者の他fileへのtruncateを防ぐ。これらの診断保存不能がCookie更新の成否を変えない。

変更の接点はhost.jsとそのnative fixture、download.jsとその局所試験、0.5.1のpackage/lock/index表示とstdio版fixture、公開README/CIの同試験。依存追加や17道具の入力schema変更はない。P6の試験がP3/P4の反例を通し、通常配布先でも同じ入口を架空cookie/ZIPで確認する。

P6のHomebrew更新fixtureは、2つの架空kegへNode実行fileをコピーしてold keg撤去後のlauncherを確認する。共有libnodeを使うmacOS Nodeでは、その隣接libnode.dylibを架空kegから元runtimeへsymlink参照し、大きいlibraryの重複コピーを作らない。借用runtimeは書換/削除しない。fixtureのt.after回収は専有tempとsymlink自体だけを削除する。製品installerの入力/出力契約は変えない。

Mac installerのpid.tmpは正常/例外時に回収済み。強制終了後の既tmpはowner状態不明なので一括削除しない。今回source/lockを配布する過程で一時backupを増やさず、現用/唯一復旧元は保護する。コード変更前に図不足の指導をレヴィアタンへ依頼し、設計変更時も本節を先に直す。
