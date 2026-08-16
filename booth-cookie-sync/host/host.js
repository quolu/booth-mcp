// ネイティブメッセージングホスト: 拡張から {cookie} を受け取り booth-mcp/.env の BOOTH_COOKIE を更新する。
// Chromeとの通信は「4バイトのリトルエンディアン長プレフィックス + UTF-8 JSON」。

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// host/ から見て ../../booth-mcp/
const MCP_DIR = join(__dirname, "..", "..", "booth-mcp");
const ENV_PATH = join(MCP_DIR, ".env");
// cookie専用ファイル（MCPサーバーが毎回読み直す＝再起動なしで反映）
const COOKIE_PATH = join(MCP_DIR, ".cookie");
const LOG_PATH = join(__dirname, "sync.log");

function log(msg) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function updateEnv(cookie) {
  let lines = [];
  if (existsSync(ENV_PATH)) {
    lines = readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  }
  let found = false;
  lines = lines.map((l) => {
    if (/^BOOTH_COOKIE=/.test(l)) {
      found = true;
      return `BOOTH_COOKIE=${cookie}`;
    }
    return l;
  });
  if (!found) lines.unshift(`BOOTH_COOKIE=${cookie}`);
  // 末尾空行の整理
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([len, json]));
}

// stdinからメッセージを1件読む（ChromeはsendNativeMessage毎にホストを起動する）。
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
    buf = buf.slice(4 + len);
    try {
      if (!msg.cookie) throw new Error("cookie empty");
      updateEnv(msg.cookie);
      writeFileSync(COOKIE_PATH, msg.cookie, "utf8");
      log(`OK reason=${msg.reason} len=${msg.cookie.length} -> ${COOKIE_PATH}`);
      send({ ok: true, wrote: [ENV_PATH, COOKIE_PATH], length: msg.cookie.length });
    } catch (e) {
      log(`ERR ${e.message}`);
      send({ ok: false, error: e.message });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
