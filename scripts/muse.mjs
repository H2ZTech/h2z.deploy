// Meta Muse 连接器（Meta Model API，https://api.meta.ai/v1，Responses 接口）。
//
// 做什么：给 h2z.security 一条受控的「让 Muse 看图 / 回答问题」的通道。典型用途是摄像头抓图复核（镜头被挡 / 模糊 / 过暗 /
// 有没有人）和运维问答。**Muse 的结论只是参考，不参与保留决策**（AI 只能把画面升级为保留，不能决定删除，沿用 AGENTS 约定）。
//
// 接口（host-agent 经 unix socket 暴露，IOC 后台转发；形状见 docs/MUSE-API.md）：
//   GET  /v1/muse                      状态（不含密钥）
//   POST /v1/muse/bind {apiKey, model?, consent: true, allowTraining?, by?}   先用密钥真调一次，通了才保存
//   POST /v1/muse/enable {enabled}     开 / 关（密钥保留）
//   POST /v1/muse/unbind               解绑：删密钥和配置
//   POST /v1/muse/ask {prompt, images?, instructions?, model?, effort?, maxOutputTokens?, purpose?}
//
// 安全与隐私（和 cf-tunnel 同一套思路）：
//  - 密钥只存在宿主 /etc/h2z/muse/api-key（0600）：不进命令行、日志、审计、接口返回、镜像和 Git；错误信息里一律脱敏。
//  - 画面会发到 Meta 云端：绑定必须带 consent: true（界面上的确认勾选），并记下谁、什么时候确认的。
//  - 请求一律带 store:false（不让 Meta 在服务端留存请求和图片）。
//  - 不用 `-contributor` 模型（便宜但允许 Meta 拿内容训练模型），除非绑定时明确 allowTraining: true。
//  - 本地限流：同时在途数、每分钟请求数、每天 token 预算；超了直接拒绝（429），不排队，防止死循环烧钱。

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';
export const DEFAULT_MODEL = 'muse-spark-1.3';
export const MAX_IMAGES = 8; // Meta 上限 50；设备端自己收紧
export const MAX_IMAGE_BYTES = 5 * 2 ** 20;
export const MAX_PROMPT_CHARS = 20_000;
export const EFFORTS = ['low', 'medium', 'high']; // 文档示例只有 high；其余是常规取值，传错 Meta 会回 400

export class MuseError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const bad = (msg) => new MuseError('E_PARAM', msg, 400);

// ---------- 纯函数：参数校验 ----------

/**
 * 密钥：接受裸密钥，也接受 `MODEL_API_KEY=xxx` / `export MODEL_API_KEY="xxx"` / `Bearer xxx`（从文档示例里复制的常见形状）。
 * 错误信息里不回显输入。
 */
export function parseApiKey(input) {
  let s = String(input ?? '').trim();
  if (!s) throw bad('请粘贴 Meta Model API 密钥');
  s = s.replace(/^export\s+/i, '').replace(/^MODEL_API_KEY\s*=\s*/i, '').replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
  if (!/^[A-Za-z0-9_\-.~+/=]{16,512}$/.test(s)) throw bad('密钥格式不对（应是一长串字母数字，没有空格）：请重新从 Meta 开发者后台复制');
  return s;
}

/** 模型名：muse-spark-* / muse-wonder-*。图像、语音、SAM 模型走别的接口，不在这里。-contributor 要明确同意被用于训练。 */
export function parseModel(input, { allowTraining = false } = {}) {
  const m = String(input ?? '').trim().toLowerCase() || DEFAULT_MODEL;
  if (!/^muse-(spark|wonder)-\d+(\.\d+)*(-contributor)?$/.test(m)) throw bad('模型名不对：这里只支持文字 / 看图模型（muse-spark-x.y、muse-wonder-x.y）');
  if (m.endsWith('-contributor') && !allowTraining) {
    throw bad('contributor 模式会允许 Meta 用你的内容训练模型（监控画面不应如此）：换成标准模型，或在绑定时明确同意（allowTraining）');
  }
  return m;
}

/** 魔数识别图片格式（不信调用方给的 mime） */
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 图片入参 → data URL 数组。每项可以是 base64 字符串、`data:image/...;base64,...`，或 {base64 | dataUrl}。
 * 只收 jpeg / png / gif / webp；按魔数定格式；单张 ≤ 5 MB；最多 8 张。
 */
export function parseImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw bad('images 要是数组');
  if (images.length > MAX_IMAGES) throw bad(`一次最多 ${MAX_IMAGES} 张图`);
  return images.map((it, i) => {
    let b64 = typeof it === 'string' ? it : it?.dataUrl || it?.base64;
    if (typeof b64 !== 'string' || !b64) throw bad(`第 ${i + 1} 张图没有内容`);
    const m = /^data:[^;,]+;base64,/i.exec(b64);
    if (m) b64 = b64.slice(m[0].length);
    b64 = b64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad(`第 ${i + 1} 张图不是有效的 base64`);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw bad(`第 ${i + 1} 张图超过 ${MAX_IMAGE_BYTES / 2 ** 20} MB`);
    const mime = sniffImage(buf);
    if (!mime) throw bad(`第 ${i + 1} 张图格式不支持（只收 JPEG / PNG / GIF / WebP）`);
    return `data:${mime};base64,${b64}`;
  });
}

/** 抓图复核用的固定指令：只要 JSON，供程序解析；不让它做任何决定 */
export const REVIEW_INSTRUCTIONS =
  '你在复核一路监控摄像头的抓图。只描述画面事实，不做任何处置建议。只输出一个 JSON 对象，不要任何其他文字：' +
  '{"people_visible": true|false, "view_ok": true|false, "issues": [从 "blocked","blurry","dark","glare","moved","other" 里选，没有就空数组], "summary": "不超过 60 字的中文描述"}。' +
  'view_ok 表示画面能正常用于监控（没被遮挡、清晰、亮度够）。看不清时 people_visible 填 false 并在 issues 里写原因。';

/** 从模型输出里取第一个 JSON 对象并校验形状；不合格返回 null（调用方带上 parseError） */
export function parseReview(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try {
    j = JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!j || typeof j.people_visible !== 'boolean' || typeof j.view_ok !== 'boolean' || !Array.isArray(j.issues)) return null;
  return { people_visible: j.people_visible, view_ok: j.view_ok, issues: j.issues.map(String).slice(0, 8), summary: String(j.summary ?? '').slice(0, 200) };
}

/** 组装 Responses 请求体 */
export function buildRequest({ model, prompt, instructions, images = [], effort, maxOutputTokens, temperature }) {
  const content = [{ type: 'input_text', text: prompt }, ...images.map((u) => ({ type: 'input_image', image_url: u }))];
  return {
    model,
    store: false, // 不让 Meta 在服务端保存请求和图片
    input: [{ type: 'message', role: 'user', content }],
    ...(instructions ? { instructions } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

/** 把调用方入参校验成内部参数（不碰网络） */
export function parseAsk(body, { model, allowTraining }) {
  const b = body || {};
  const prompt = String(b.prompt ?? '').trim();
  const purpose = b.purpose === undefined ? '' : String(b.purpose);
  if (purpose && purpose !== 'snapshot-review') throw bad('purpose 目前只支持 snapshot-review');
  const images = parseImages(b.images);
  if (purpose === 'snapshot-review' && images.length === 0) throw bad('snapshot-review 需要至少一张图');
  if (!prompt && purpose !== 'snapshot-review') throw bad('prompt 不能为空');
  if (prompt.length > MAX_PROMPT_CHARS) throw bad(`prompt 太长（上限 ${MAX_PROMPT_CHARS} 字）`);
  let instructions = b.instructions === undefined ? '' : String(b.instructions);
  if (instructions.length > MAX_PROMPT_CHARS) throw bad('instructions 太长');
  if (purpose === 'snapshot-review') instructions = REVIEW_INSTRUCTIONS;
  let effort;
  if (b.effort !== undefined && b.effort !== null && b.effort !== '') {
    if (!EFFORTS.includes(b.effort)) throw bad(`effort 取值：${EFFORTS.join(' / ')}`);
    effort = b.effort;
  }
  let maxOutputTokens = 1024;
  if (b.maxOutputTokens !== undefined) {
    const n = Number(b.maxOutputTokens);
    if (!Number.isInteger(n) || n < 16 || n > 8192) throw bad('maxOutputTokens 要是 16 到 8192 的整数');
    maxOutputTokens = n;
  }
  return {
    model: b.model ? parseModel(b.model, { allowTraining }) : model,
    prompt: prompt || '请复核这张摄像头抓图。',
    instructions,
    images,
    effort,
    maxOutputTokens,
    purpose,
  };
}

// ---------- 纯函数：响应与错误 ----------

/** 去掉文本里的密钥（精确值 + Bearer 头 + 常见 key=value 形状） */
export function redact(text, key = '') {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('***');
  return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').replace(/((?:api[_-]?key|authorization|MODEL_API_KEY)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***');
}

export function parseRetryAfter(v, nowMs = Date.now()) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

/** Meta 的 HTTP 错误 → 我们的错误码、中文说明、能不能重试。映射依据 dev.meta.ai/docs/error-handling */
export function classifyHttp(status, text, headers, nowMs = Date.now()) {
  let err = {};
  try {
    const j = JSON.parse(text);
    if (j && typeof j.error === 'object' && j.error) err = j.error;
    else if (j && typeof j.error === 'string') err = { message: j.error };
  } catch {
    /* 404 等可能没有 JSON 体：只看状态码 */
  }
  const code = String(err.code ?? '');
  const detail = String(err.message ?? '').replace(/\s+/g, ' ').slice(0, 200);
  const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'), nowMs);
  const out = (c, message, httpStatus, retryable = false) => ({ code: c, message, detail, httpStatus, retryable, retryAfterMs });
  if (status === 401) return out('E_MUSE_KEY', 'Meta 拒绝了这个密钥（无效、已撤销或格式不对）：到 Meta 开发者后台重新生成并绑定', 502);
  if (status === 402) return out('E_MUSE_BILLING', 'Meta 账户余额不足或没有开通计费：到 Meta 开发者后台处理', 502);
  if (status === 403) return out('E_MUSE_FORBIDDEN', '这个密钥没有权限使用该模型或功能', 502);
  if (status === 404) {
    if (code === 'model_not_found') return out('E_MUSE_MODEL', '模型不存在或这个账号没开通：换一个模型', 502);
    return out('E_MUSE_ENDPOINT', 'Meta 接口地址不对（404）：检查 MUSE_BASE_URL', 502);
  }
  if (status === 413) return out('E_MUSE_TOO_LARGE', '请求太大：少传几张图或缩小图片', 413);
  if (status === 400) {
    if (code === 'content_policy_violation') return out('E_MUSE_POLICY', 'Meta 的内容策略拒绝了这次请求', 422);
    return out('E_MUSE_REQUEST', 'Meta 拒绝了请求参数' + (detail ? '：' + detail : ''), 502);
  }
  if (status === 429) return out('E_MUSE_RATE', 'Meta 限流了：稍后再试', 429, true);
  if (status === 504) return out('E_MUSE_TIMEOUT', 'Meta 处理超时（同一请求通常会再次超时）：减少图片或降低 effort', 502); // 文档：不建议直接重试
  if (status >= 500) return out('E_MUSE_UPSTREAM', 'Meta 服务暂时不可用', 502, true);
  return out('E_MUSE_REQUEST', `Meta 返回了意外状态 ${status}`, 502);
}

/** Responses 响应 → {id, model, status, text, truncated, usage}。字段不全时尽量容错（usage 的字段名文档里没写全，兼容两种常见写法） */
export function parseResponse(json) {
  if (!json || typeof json !== 'object') throw new MuseError('E_MUSE_EMPTY', 'Meta 返回的内容读不懂');
  if (json.status === 'failed') {
    const m = redact(String(json.error?.message || '').replace(/\s+/g, ' ').slice(0, 200));
    throw new MuseError('E_MUSE_UPSTREAM', 'Meta 处理失败' + (m ? '：' + m : ''));
  }
  let text = '';
  let refusal = '';
  if (typeof json.output_text === 'string') {
    text = json.output_text;
  } else {
    const msgs = (Array.isArray(json.output) ? json.output : []).filter((x) => x && x.type === 'message');
    const final = msgs.filter((x) => x.phase === 'final_answer');
    for (const m of final.length ? final : msgs) {
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
        else if (c?.type === 'refusal') refusal += String(c.refusal ?? c.text ?? '');
      }
    }
  }
  if (!text && refusal) throw new MuseError('E_MUSE_REFUSED', 'Muse 拒绝回答这个请求', 422);
  if (!text) throw new MuseError('E_MUSE_EMPTY', 'Muse 没有返回文字（可能 max_output_tokens 太小，或只返回了推理内容）');
  const u = json.usage || {};
  const input = Number(u.input_tokens ?? u.prompt_tokens) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens) || 0;
  return {
    id: typeof json.id === 'string' ? json.id : '',
    model: typeof json.model === 'string' ? json.model : '',
    status: json.status || 'completed',
    text,
    truncated: json.status === 'incomplete',
    usage: { inputTokens: input, outputTokens: output, totalTokens: Number(u.total_tokens) || input + output },
  };
}

/** 限流响应头 → 余量（没有就是 null） */
export function parseRateHeaders(headers) {
  const n = (k) => {
    const v = headers?.get?.(k);
    return v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  return { limitRequests: n('x-ratelimit-limit-requests'), remainingRequests: n('x-ratelimit-remaining-requests'), limitTokens: n('x-ratelimit-limit-tokens'), remainingTokens: n('x-ratelimit-remaining-tokens') };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 无状态的一次调用（带重试）：POST {baseUrl}/responses。
 * 重试：429 / 5xx（504 除外）/ 网络错误，最多 maxRetries 次；优先 Retry-After，没有就 0.5s 起翻倍加 0–1s 抖动；
 * Retry-After 超过 maxWaitMs（Meta 过载时常给 60s）不等，直接把失败交回去，别把 host-agent 的请求挂住。
 */
export async function callResponses({ key, baseUrl = DEFAULT_BASE_URL, body, fetch: doFetch = globalThis.fetch, sleep = sleepMs, timeoutMs = 60_000, maxRetries = 3, maxWaitMs = 30_000, random = Math.random }) {
  const url = baseUrl.replace(/\/+$/, '') + '/responses';
  for (let attempt = 0; ; attempt++) {
    let res;
    let text = '';
    let netErr = null;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      netErr = e;
    }
    if (netErr) {
      if (netErr.name === 'TimeoutError' || netErr.name === 'AbortError') throw new MuseError('E_MUSE_TIMEOUT', `等 Meta 应答超过 ${Math.round(timeoutMs / 1000)} 秒`);
      if (attempt >= maxRetries) throw new MuseError('E_MUSE_NETWORK', '设备连不上 Meta（api.meta.ai）：检查设备能否上网、出站 443 是否放行');
      await sleep(500 * 2 ** attempt + random() * 1000);
      continue;
    }
    if (res.ok) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new MuseError('E_MUSE_EMPTY', 'Meta 返回的内容不是 JSON');
      }
      return { json, headers: res.headers };
    }
    const c = classifyHttp(res.status, text, res.headers);
    const wait = c.retryAfterMs ?? 500 * 2 ** attempt + random() * 1000;
    if (!c.retryable || attempt >= maxRetries || wait > maxWaitMs) {
      const hint = c.retryable && c.retryAfterMs ? `（Meta 要求等 ${Math.round(c.retryAfterMs / 1000)} 秒）` : '';
      throw new MuseError(c.code, c.message + hint + (c.detail ? '；Meta 说：' + redact(c.detail, key) : ''), c.httpStatus);
    }
    await sleep(wait);
  }
}

// ---------- 工厂：带绑定状态、限流、用量 ----------

/**
 * 依赖都可注入（测试用）：fs（fs/promises 形状）、hostEtc（容器里 /host/etc）、serial、audit、now、fetch、sleep、random。
 * 额度参数：timeoutMs、maxRetries、maxConcurrent、rpm（每分钟请求数）、dailyTokens（每天 token 预算，0 = 不限）。
 */
export function createMuse(opts = {}) {
  const o = { baseUrl: DEFAULT_BASE_URL, timeoutMs: 60_000, maxRetries: 3, maxConcurrent: 4, rpm: 60, dailyTokens: 1_000_000, ...opts };
  const { fs } = o;
  const serial = o.serial || ((fn) => fn());
  const audit = o.audit || (async () => {});
  const now = o.now || (() => Date.now());
  const dir = join(o.hostEtc, 'h2z/muse');
  const P = { key: join(dir, 'api-key'), config: join(dir, 'config.json'), usage: join(dir, 'usage.json') };

  const readJson = async (f) => {
    try {
      return JSON.parse(await fs.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const rm = async (f) => {
    try {
      await fs.unlink(f);
    } catch {
      /* 不在就算了 */
    }
  };
  let tmpSeq = 0;
  async function writeFile600(f, text) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.${++tmpSeq}.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, f);
  }
  const day = () => new Date(now()).toISOString().slice(0, 10);

  // 用量：内存为准，尽力落盘；跨天清零
  let usage = null;
  let rate = null;
  const blankUsage = () => ({ day: day(), requests: 0, ok: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastOkAt: null, lastError: null });
  async function loadUsage() {
    if (!usage) usage = (await readJson(P.usage)) || blankUsage();
    if (usage.day !== day()) usage = { ...blankUsage(), lastOkAt: usage.lastOkAt, lastError: usage.lastError };
    return usage;
  }
  const saveUsage = () => writeFile600(P.usage, JSON.stringify(usage) + '\n').catch(() => {});

  let inFlight = 0;
  const recent = []; // 最近一分钟的请求时刻

  const notBound = (msg = '还没有绑定 Muse 密钥') => new MuseError('E_MUSE_NOT_BOUND', msg, 409);
  const callOpts = () => ({ baseUrl: o.baseUrl, fetch: o.fetch, sleep: o.sleep, random: o.random, timeoutMs: o.timeoutMs, maxRetries: o.maxRetries });

  async function status() {
    const cfg = await readJson(P.config);
    const u = await loadUsage();
    const base = { provider: 'meta-muse', baseUrl: o.baseUrl, defaultModel: DEFAULT_MODEL };
    if (!cfg?.model) return { ...base, bound: false, state: 'unbound', enabled: false };
    const out = {
      ...base,
      bound: true,
      enabled: cfg.enabled !== false,
      model: cfg.model,
      allowTraining: !!cfg.allowTraining,
      keyHint: cfg.keyHint || '',
      boundAt: cfg.boundAt || null,
      boundBy: cfg.boundBy || '',
      consentAt: cfg.consentAt || null,
      today: { requests: u.requests, ok: u.ok, errors: u.errors, inputTokens: u.inputTokens, outputTokens: u.outputTokens },
      budget: { dailyTokens: o.dailyTokens, usedToday: u.inputTokens + u.outputTokens, maxConcurrent: o.maxConcurrent, rpm: o.rpm },
      rateLimit: rate,
      lastOkAt: u.lastOkAt,
      error: null,
    };
    if (!out.enabled) return { ...out, state: 'disabled' };
    const errAt = u.lastError ? Date.parse(u.lastError.at) : 0;
    const okAt = u.lastOkAt ? Date.parse(u.lastOkAt) : 0;
    if (u.lastError && errAt > okAt) return { ...out, state: 'error', error: { code: u.lastError.code, message: u.lastError.message } };
    return { ...out, state: 'ready' };
  }

  function bind(body) {
    return serial(async () => {
      const key = parseApiKey(body?.apiKey);
      const allowTraining = body?.allowTraining === true;
      const model = parseModel(body?.model, { allowTraining });
      if (body?.consent !== true) throw new MuseError('E_MUSE_CONSENT', '需要先确认：摄像头画面会发送到 Meta 的云端服务（api.meta.ai）进行分析', 400);
      const by = String(body?.by || '').slice(0, 80);
      // 先真调一次：通了才保存（失败不留半成品）。max_output_tokens 16 是文档给的下限
      try {
        const { json } = await callResponses({ ...callOpts(), key, body: buildRequest({ model, prompt: 'Reply with the single word: ok', maxOutputTokens: 16 }) });
        parseResponse(json);
      } catch (e) {
        if (e instanceof MuseError) {
          await audit('muse-bind-failed', { model, code: e.code, by });
          throw new MuseError(e.code, '绑定失败，未保存：' + redact(e.message, key), e.status);
        }
        throw e;
      }
      const at = new Date(now()).toISOString();
      try {
        await writeFile600(P.key, key + '\n');
        await writeFile600(P.config, JSON.stringify({ schema: 1, provider: 'meta-muse', model, enabled: true, allowTraining, consentAt: at, boundAt: at, boundBy: by, keyHint: '…' + key.slice(-4) }, null, 2) + '\n');
      } catch (e) {
        await rm(P.key);
        await rm(P.config);
        throw new MuseError('E_MUSE_STORE', '保存密钥失败：' + redact(String(e.message || e), key).slice(0, 120), 500);
      }
      usage = { ...blankUsage(), lastOkAt: at };
      await saveUsage();
      await audit('muse-bind', { model, by, keyHint: '…' + key.slice(-4), allowTraining });
      return status();
    });
  }

  function setEnabled(body) {
    return serial(async () => {
      if (typeof body?.enabled !== 'boolean') throw bad('enabled 要是 true 或 false');
      const cfg = await readJson(P.config);
      if (!cfg?.model) throw notBound();
      cfg.enabled = body.enabled;
      await writeFile600(P.config, JSON.stringify(cfg, null, 2) + '\n');
      await audit(body.enabled ? 'muse-enable' : 'muse-disable', { by: String(body?.by || '').slice(0, 80) });
      return status();
    });
  }

  function unbind(body) {
    return serial(async () => {
      const cfg = await readJson(P.config);
      await rm(P.key);
      await rm(P.config);
      rate = null;
      if (cfg?.model) await audit('muse-unbind', { model: cfg.model, by: String(body?.by || '').slice(0, 80) });
      return status();
    });
  }

  /** 问 Muse（文字或带图）。不走 serial：一次调用可能几十秒，不能挡住 host-agent 的网络 / 升级操作 */
  async function ask(body) {
    const cfg = await readJson(P.config);
    if (!cfg?.model) throw notBound();
    if (cfg.enabled === false) throw new MuseError('E_MUSE_DISABLED', 'Muse 现在是关闭状态，先打开', 409);
    const req = parseAsk(body, { model: cfg.model, allowTraining: !!cfg.allowTraining });
    let key = '';
    try {
      key = (await fs.readFile(P.key, 'utf8')).trim();
    } catch {
      /* 下面统一报 */
    }
    if (!key) throw notBound('密钥文件丢失：请重新绑定');
    const u = await loadUsage();
    if (o.dailyTokens > 0 && u.inputTokens + u.outputTokens >= o.dailyTokens) {
      throw new MuseError('E_MUSE_BUDGET', `今天的 token 预算（${o.dailyTokens}）已用完，明天（UTC）自动恢复；需要更多请调大 MUSE_DAILY_TOKENS`, 429);
    }
    const t = now();
    while (recent.length && t - recent[0] >= 60_000) recent.shift();
    if (o.rpm > 0 && recent.length >= o.rpm) throw new MuseError('E_MUSE_BUSY', `请求太频繁（每分钟最多 ${o.rpm} 次）：稍后再试`, 429);
    if (inFlight >= o.maxConcurrent) throw new MuseError('E_MUSE_BUSY', `同时进行的请求太多（最多 ${o.maxConcurrent} 个）：稍后再试`, 429);
    recent.push(t);
    inFlight++;
    u.requests++;
    try {
      const { json, headers } = await callResponses({ ...callOpts(), key, body: buildRequest(req) });
      rate = { ...parseRateHeaders(headers), at: new Date(now()).toISOString() };
      const r = parseResponse(json);
      u.ok++;
      u.inputTokens += r.usage.inputTokens;
      u.outputTokens += r.usage.outputTokens;
      u.lastOkAt = new Date(now()).toISOString();
      await saveUsage();
      const out = { id: r.id, model: r.model || req.model, text: r.text, truncated: r.truncated, usage: r.usage, images: req.images.length };
      if (req.purpose === 'snapshot-review') {
        const review = parseReview(r.text);
        out.purpose = req.purpose;
        out.review = review;
        if (!review) out.parseError = true;
      }
      return out;
    } catch (e) {
      u.errors++;
      if (e instanceof MuseError) {
        u.lastError = { code: e.code, message: redact(e.message, key).slice(0, 200), at: new Date(now()).toISOString() };
        await saveUsage();
        if (e.code === 'E_MUSE_KEY') await audit('muse-key-rejected', {}); // 401 持续出现可能是密钥泄露或被撤销
        throw new MuseError(e.code, redact(e.message, key), e.status);
      }
      await saveUsage();
      throw e;
    } finally {
      inFlight--;
    }
  }

  return { status, bind, setEnabled, unbind, ask, paths: P };
}

// ---------- 命令行（运维用：在设备上用真密钥验证连通，密钥不用贴到聊天里）----------
//   MODEL_API_KEY=… node scripts/muse.mjs ping
//   MODEL_API_KEY=… node scripts/muse.mjs ask "你好" [--image 抓图.jpg] [--model muse-spark-1.3]
// 密钥也可以用 --key-file <文件>（文件里就是密钥）。输出只有回答文字和用量，不打印密钥。
export async function cli(argv, env = process.env, out = (s) => process.stdout.write(s + '\n')) {
  const [cmd, ...rest] = argv;
  const flag = (n) => {
    const i = rest.indexOf('--' + n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!['ping', 'ask'].includes(cmd)) {
    out('用法：muse.mjs ping | ask "<问题>" [--image <文件>] [--model <名>] [--key-file <文件>]\n密钥：环境变量 MODEL_API_KEY，或 --key-file');
    return 2;
  }
  const keyFile = flag('key-file');
  const key = parseApiKey(keyFile ? await readFile(keyFile, 'utf8') : env.MODEL_API_KEY);
  const model = parseModel(flag('model'));
  const imgFile = flag('image');
  const images = imgFile ? parseImages([(await readFile(imgFile)).toString('base64')]) : [];
  const prompt = cmd === 'ping' ? 'Reply with the single word: ok' : rest.find((x, i) => !x.startsWith('--') && !String(rest[i - 1] || '').startsWith('--')) || '';
  if (!prompt) throw bad('ask 后面要跟问题');
  const { json } = await callResponses({ key, baseUrl: env.MUSE_BASE_URL || DEFAULT_BASE_URL, body: buildRequest({ model, prompt, images, maxOutputTokens: cmd === 'ping' ? 16 : 1024 }) });
  const r = parseResponse(json);
  out(r.text);
  out(`[${r.model || model}] tokens in/out: ${r.usage.inputTokens}/${r.usage.outputTokens}${r.truncated ? '（回答被截断）' : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof MuseError ? `${e.code}: ${e.message}` : String(e.message || e));
      process.exit(1);
    },
  );
}
