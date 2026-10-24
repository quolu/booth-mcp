// Candidate only: this module is not exposed by the production MCP tool list.
// BOOTH's media readback is known; writes still require an agreed private fixture.
import { createHash } from 'node:crypto';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const OPTION_KEYS = new Set(['youtube_url', 'action', 'position', 'index', 'start_seconds',
  'dry_run', 'expected_page_design_sha256']);

export function youtubeVideoId(value) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('YouTubeのHTTPS URLを指定してください。');
  let url;
  try { url = new URL(value); } catch { throw new Error('YouTubeのHTTPS URLを指定してください。'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error('対応するYouTubeのHTTPS URLだけを指定してください。');
  }
  let id;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  } else if (url.pathname === '/watch' && !url.hostname.endsWith('youtube-nocookie.com')) {
    if (url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
  } else {
    const paths = url.hostname.endsWith('youtube-nocookie.com') ? 'embed' : 'embed|shorts|live';
    id = url.pathname.match(new RegExp(`^/(?:${paths})/([A-Za-z0-9_-]{11})/?$`))?.[1];
  }
  if (!id || !VIDEO_ID.test(id)) throw new Error('単一動画のYouTube URLを指定してください。');
  return id;
}

function optionsFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('動画の編集条件が不正です。');
  if (Object.keys(input).some(key => !OPTION_KEYS.has(key))) throw new Error('未対応の動画編集フィールドです。');
  const options = { action: 'insert', dry_run: true, start_seconds: 0, ...input };
  const videoId = youtubeVideoId(options.youtube_url);
  if (!['insert', 'replace'].includes(options.action) || typeof options.dry_run !== 'boolean') {
    throw new Error('actionはinsert/replace、dry_runは真偽値で指定してください。');
  }
  if (!Number.isSafeInteger(options.start_seconds) || options.start_seconds < 0 || options.start_seconds > 2147483647) {
    throw new Error('start_secondsは0以上の整数で指定してください。');
  }
  if (options.action === 'insert' && options.index !== undefined) throw new Error('insertにindexは指定できません。');
  if (options.action === 'replace' && (options.position !== undefined || !Number.isSafeInteger(options.index))) {
    throw new Error('replaceはindexを指定し、positionは指定しないでください。');
  }
  if (options.position !== undefined && !Number.isSafeInteger(options.position)) throw new Error('positionは整数で指定してください。');
  if (options.expected_page_design_sha256 !== undefined &&
      (typeof options.expected_page_design_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expected_page_design_sha256))) {
    throw new Error('expected_page_design_sha256は小文字のSHA-256で指定してください。');
  }
  if (!options.dry_run && !options.expected_page_design_sha256) {
    throw new Error('適用には変更案のexpected_page_design_sha256が必要です。');
  }
  return { ...options, videoId };
}

function pageDesign(item) {
  let value = item.page_design;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('page_designのJSONが不正です。'); }
  }
  if (value === null || value === undefined) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('page_designはオブジェクトである必要があります。');
  if (value.modules !== undefined && !Array.isArray(value.modules)) throw new Error('page_design.modulesは配列である必要があります。');
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('page_designにJSONでない値があります。');
  return encoded;
}

export function pageDesignSha256(item) {
  return createHash('sha256').update(canonical(pageDesign(item))).digest('hex');
}

function isYouTubeMedia(module) {
  if (module?.type !== 'media' || typeof module.content !== 'string') return false;
  const iframe = module.content.match(/^\s*<iframe\b([^>]*)>\s*<\/iframe>\s*$/i);
  if (!iframe) return false;
  const sources = [...iframe[1].matchAll(/(?:^|\s)src\s*=\s*(["'])(.*?)\1/gi)];
  if (sources.length !== 1) return false;
  try {
    const url = new URL(sources[0][2]);
    return /^\/embed\//.test(url.pathname) && Boolean(youtubeVideoId(url.href));
  } catch { return false; }
}

export function planYouTubeModule(item, input) {
  const options = optionsFor(input);
  const before = pageDesign(item);
  const modules = before.modules ?? [];
  const previousHash = pageDesignSha256(item);
  if (options.expected_page_design_sha256 && options.expected_page_design_sha256 !== previousHash) {
    throw new Error('page_designが変わりました。変更案を再取得してください。');
  }
  const src = `https://www.youtube.com/embed/${options.videoId}` +
    (options.start_seconds ? `?start=${options.start_seconds}` : '');
  const content = `<iframe width="640" height="360" src="${src}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`;
  let index;
  const next = [...modules];
  if (options.action === 'insert') {
    index = options.position ?? modules.length;
    if (index < 0 || index > modules.length) throw new Error('positionがモジュールの範囲外です。');
    next.splice(index, 0, { type: 'media', content });
  } else {
    index = options.index;
    if (index < 0 || index >= modules.length || !isYouTubeMedia(modules[index])) {
      throw new Error('置換対象は既存のYouTube mediaモジュールだけです。');
    }
    next[index] = { ...modules[index], content };
  }
  const result = { ...before, modules: next };
  const hash = pageDesignSha256({ page_design: result });
  return { action: options.action, index, video_id: options.videoId,
    previous_page_design_sha256: previousHash, page_design_sha256: hash,
    changed: hash !== previousHash, page_design: result, media_module: next[index] };
}

function summary(plan, dryRun, verified) {
  const { page_design, ...details } = plan;
  return { ok: true, dry_run: dryRun, verified, ...details, module_count: page_design.modules.length };
}

// Local preconditions detect changes seen before PATCH, not an atomic server CAS.
// There is deliberately no automatic PATCH retry or rollback after uncertain writes.
export async function editYouTubeModule(client, itemId, input) {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new Error('item_idは正の整数で指定してください。');
  const options = optionsFor(input);
  const item = await client.getItem(itemId);
  if (item.id !== itemId) throw new Error('取得した商品IDが一致しません。');
  const plan = planYouTubeModule(item, input);
  if (options.dry_run) return summary(plan, true, false);
  const latest = await client.getItem(itemId);
  if (latest.id !== itemId || pageDesignSha256(latest) !== plan.previous_page_design_sha256) {
    throw new Error('適用直前にpage_designが変わりました。変更案を再取得してください。');
  }
  if (!plan.changed) return summary(plan, false, true);
  await client._setModules({ ...structuredClone(latest), page_design: plan.page_design }, plan.page_design.modules);
  const saved = await client.getItem(itemId);
  if (saved.id !== itemId || pageDesignSha256(saved) !== plan.page_design_sha256) {
    throw new Error('保存後のpage_designが変更案と一致しません。現状を確認し、自動再送しないでください。');
  }
  return summary(plan, false, true);
}
