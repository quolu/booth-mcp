// manage.booth.pm のcookieを集めて、ネイティブホスト経由で booth-mcp の .env へ同期する。
// 同期契機: 起動時 / cookie変更時 / 30分ごと / ツールバーアイコンのクリック。

const HOST = "com.quolabo.booth_cookie_sync";
const DOMAIN_URL = "https://manage.booth.pm/";

async function collectCookieHeader() {
  // manage.booth.pm に送られる全cookie（httpOnly含む）を取得し Cookieヘッダ文字列にする。
  const cookies = await chrome.cookies.getAll({ url: DOMAIN_URL });
  if (!cookies.length) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function sync(reason) {
  try {
    const cookie = await collectCookieHeader();
    if (!cookie) {
      console.log(`[booth-sync] cookieなし（未ログイン?） reason=${reason}`);
      return;
    }
    const hasSession = /(_plaza_session|_session)/.test(cookie);
    const resp = await chrome.runtime.sendNativeMessage(HOST, { cookie, reason });
    console.log(`[booth-sync] 同期 reason=${reason} session=${hasSession} ->`, resp);
  } catch (e) {
    console.error("[booth-sync] 失敗:", e.message || e);
  }
}

chrome.runtime.onInstalled.addListener(() => sync("installed"));
chrome.runtime.onStartup.addListener(() => sync("startup"));
chrome.action.onClicked.addListener(() => sync("click"));

chrome.cookies.onChanged.addListener((info) => {
  const d = info.cookie.domain || "";
  if (d.includes("booth.pm") && /(_plaza_session|_session)/.test(info.cookie.name)) {
    sync("cookie-changed");
  }
});

chrome.alarms.create("periodic", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "periodic") sync("periodic");
});
