// ネイティブメッセージングホスト: 拡張から {cookie} を受け取り booth-mcp/.env の BOOTH_COOKIE を更新する。
// Chromeとの通信は「4バイトのリトルエンディアン長プレフィックス + UTF-8 JSON」。

import { readFileSync, writeFileSync, existsSync, chmodSync, openSync, closeSync, readSync, writeSync, fstatSync, lstatSync, ftruncateSync, constants } from "node:fs";
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
  let file;
  try {
    if (existsSync(LOG_PATH) && lstatSync(LOG_PATH).isSymbolicLink()) return;
    file = openSync(LOG_PATH, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) return;
    const limit = 1024 * 1024;
    const line = Buffer.from(`${new Date().toISOString()} ${String(msg).slice(0, 1000)}\n`);
    let size = stat.size;
    if (size + line.length > limit) {
      const tail = Buffer.alloc(Math.min(size, 128 * 1024));
      const count = readSync(file, tail, 0, tail.length, size - tail.length);
      const lines = tail.subarray(0, count);
      const newline = lines.indexOf(10);
      const kept = newline < 0 ? Buffer.alloc(0) : lines.subarray(newline + 1);
      ftruncateSync(file, 0);
      writeSync(file, kept, 0, kept.length, 0);
      size = kept.length;
    }
    // Explicit offsets keep concurrent writers within the cap; diagnostics are best effort.
    writeSync(file, line, 0, line.length, Math.min(size, limit - line.length));
  } catch {} finally {
    if (file !== undefined) {
      try { closeSync(file); } catch {}
    }
  }
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
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(ENV_PATH, 0o600);
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
      writeFileSync(COOKIE_PATH, msg.cookie, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") chmodSync(COOKIE_PATH, 0o600);
      const reason = ["installed", "startup", "click", "cookie-changed", "periodic", "test"].includes(msg.reason) ? msg.reason : "unknown";
      log(`OK reason=${reason} len=${msg.cookie.length} -> ${COOKIE_PATH}`);
      send({ ok: true, wrote: [ENV_PATH, COOKIE_PATH], length: msg.cookie.length });
    } catch (e) {
      log(`ERR ${e.message}`);
      send({ ok: false, error: e.message });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
