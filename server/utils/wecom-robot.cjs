'use strict';

/**
 * server/utils/wecom-robot.cjs
 * ---------------------------------------------------------------------------
 * 企业微信机器人工具类：向企微群机器人发送 markdown / text 消息。
 *
 * 约定：所有消息**必须以环境信息【xxx】开头**，避免生产/测试消息混淆。
 *   默认标签：生产 → 【生产】；其它 → 【测试】。
 *   可用 options.envTag 或环境变量 WECOM_ROBOT_ENV_TAG 覆盖（如【预发】）。
 *
 * 长消息自动分段/截断：
 *   - 企微 markdown 正文上限 4096 字节、text 上限 2048 字节（UTF-8 字节数，非字符数）。
 *   - 超出上限时自动按 UTF-8 字符边界切分，优先在换行处断开，尽量不破坏 markdown。
 *   - 每段都会单独带上【环境】前缀；多段时追加 (i/n) 序号。
 *   - 段数超过 maxParts（默认 10）时，仅保留前 maxParts 段并在末段追加"已截断"提示，
 *     防止刷屏与触发企微频率限制（20 条/分钟）。
 *
 * 频控与并发（企微机器人官方限制）：
 *   - 每个 webhook（每个群）≤ 20 条/分钟：进程内滑动窗口限流，超出排队等待；
 *   - 同一 webhook 相同请求 body 不允许 ≥2 个并发：按 body 串行；
 *   - 单 webhook ≤ 10000 条/分钟：20 条/分钟更严格，已覆盖；
 *   - 向所有群广播 ≤ 20 条/分钟：本工具为单 webhook，按 1 执行。
 *   - 注意：限流为进程内；多进程（pm2 多 worker）共享同一 webhook 时，
 *     需改用 Redis 等集中式限流才能严格满足 20 条/分钟。
 *
 * 用法：
 *   const { sendMarkdown } = require('./utils/wecom-robot.cjs');
 *   await sendMarkdown('**分账成功**\n> 订单 BKG2026xxxx');   // 超长会自动分段发送
 *
 *   const { createWeComRobot } = require('./utils/wecom-robot.cjs');
 *   const robot = createWeComRobot({ webhookUrl: 'https://...', envTag: '预发' });
 *   await robot.sendMarkdown('内容', { maxParts: 5 });
 *
 * Webhook 可用环境变量 WECOM_ROBOT_WEBHOOK 覆盖，缺省使用下方默认地址。
 * ---------------------------------------------------------------------------
 */

// 企微群机器人 webhook（可用 WECOM_ROBOT_WEBHOOK 覆盖）
const DEFAULT_WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=3cf33190-bc91-4f41-b438-761d148f42bb';

// 企微官方上限（字节，UTF-8）
const MAX_MARKDOWN_BYTES = 4096;
const MAX_TEXT_BYTES = 2048;
// 默认最多分几段（避免刷屏 + 触发 20 条/分钟 频率限制）
const DEFAULT_MAX_PARTS = 10;
const TRUNCATE_NOTICE = '\n…(内容过长，已截断)';

function normalizeEnv(env) {
  const value = String(env || '').trim().toLowerCase();
  return value === 'prod' || value === 'production' ? 'prod' : 'test';
}

/** 环境标签（含中文括号），如【生产】/【测试】 */
function envTagOf(env) {
  return normalizeEnv(env) === 'prod' ? '【生产】' : '【测试】';
}

/** 判断文本是否已以【...】开头，避免重复添加环境前缀 */
function hasEnvPrefix(text) {
  return /^【[^】]*】/.test(String(text || '').trimStart());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 频控与并发控制（企微机器人官方限制） ─────────────────────────────
// 1) 每个 webhook（每个群）≤ 20 条/分钟；
// 2) 向所有群广播 ≤ 20 条/分钟（本工具为单 webhook，按 1 执行）；
// 3) 每个 webhook 调用接口 ≤ 10000 条/分钟（20 更严格，已覆盖）；
// 4) 同一 webhook 相同 body 不允许 ≥2 个并发请求（按 body 串行）。
// 说明：限流为进程内实现；多进程（pm2 多 worker）共享同一 webhook 时，
//       需改用 Redis 等集中式限流才能严格满足 20 条/分钟。
const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;
const DEFAULT_RATE_WINDOW_MS = 60000;

// key = webhookUrl → { timestamps:number[], chain:Promise }
const _rateState = new Map();
// key = webhookUrl + '\0' + bodyString → Promise（相同 body 串行）
const _bodyLocks = new Map();

function resolveRateLimit(options = {}) {
  if (options.rateLimit === false || process.env.WECOM_RATE_LIMIT_DISABLED === '1') {
    return { disabled: true };
  }
  const limit = Number(options.rateLimitPerMinute || process.env.WECOM_RATE_LIMIT_PER_MINUTE || DEFAULT_RATE_LIMIT_PER_MINUTE);
  const windowMs = Number(options.rateWindowMs || process.env.WECOM_RATE_WINDOW_MS || DEFAULT_RATE_WINDOW_MS);
  return {
    disabled: false,
    limit: limit > 0 ? Math.floor(limit) : DEFAULT_RATE_LIMIT_PER_MINUTE,
    windowMs: windowMs > 0 ? windowMs : DEFAULT_RATE_WINDOW_MS,
  };
}

// 在 webhook 维度串行地申请发送名额；超出 limit/window 则排队等待下一窗口
function acquireSlot(key, cfg) {
  let st = _rateState.get(key);
  if (!st) { st = { timestamps: [], chain: Promise.resolve() }; _rateState.set(key, st); }
  const run = st.chain.catch(() => {}).then(async () => {
    for (;;) {
      const now = Date.now();
      while (st.timestamps.length && now - st.timestamps[0] >= cfg.windowMs) st.timestamps.shift();
      if (st.timestamps.length < cfg.limit) {
        st.timestamps.push(now);
        return;
      }
      await sleep(Math.max(1, st.timestamps[0] + cfg.windowMs - now));
    }
  });
  st.chain = run.catch(() => {});
  return run;
}

// 相同 body 串行（保证同一 webhook 相同 body 无并发请求）
function withBodyLock(key, fn) {
  const prev = _bodyLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  _bodyLocks.set(key, tail);
  tail.then(() => { if (_bodyLocks.get(key) === tail) _bodyLocks.delete(key); });
  return run;
}

/** 清空进程内限流状态（仅测试用） */
function resetRateLimiters() {
  _rateState.clear();
  _bodyLocks.clear();
}

/**
 * 按 UTF-8 字节数切分文本（不会切断多字节字符）。
 * 每个分片 ≤ maxBytes；优先在换行处断开，且所有分片按序拼接 === 原文（不丢字符）。
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
function splitByBytes(text, maxBytes) {
  const src = text == null ? '' : String(text);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 1;
  const parts = [];
  let buf = '';
  let bytes = 0;

  // 冲掉当前缓冲：尽量在最后一个换行处切（含换行，保证拼接可还原）
  const flush = () => {
    if (!buf) return;
    const cut = buf.lastIndexOf('\n');
    if (cut >= 0) {
      parts.push(buf.slice(0, cut + 1));
      buf = buf.slice(cut + 1);
    } else {
      parts.push(buf);
      buf = '';
    }
    bytes = Buffer.byteLength(buf, 'utf8');
  };

  for (const ch of src) { // for...of 按码点迭代，天然 UTF-8 安全
    const chBytes = Buffer.byteLength(ch, 'utf8');
    while (bytes + chBytes > limit && buf) flush();
    buf += ch;
    bytes += chBytes;
    if (bytes >= limit) flush();
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [''];
}

/**
 * 将任意长度内容切分为多条符合企微字节上限的消息，每条均以【环境】开头。
 *
 * 环境标签一致性：若原文本身以【xxx】开头，则提取该标签并统一用于**所有**分段，
 * 避免同一逻辑消息的不同分段出现不一致的环境标签；否则统一使用 envTag。
 *
 * @param {string} content
 * @param {object} [options]
 * @param {string} [options.envTag='【测试】'] 环境标签（已含中文括号）
 * @param {number} [options.limit=4096] 单条消息字节上限
 * @param {number} [options.maxParts=10] 最多分段数，超出则截断
 * @param {boolean} [options.raw=false] true 时不补环境前缀（仅调试用）
 * @returns {string[]}
 */
function buildMessages(content, options = {}) {
  const raw = options.raw === true;
  const envTag = options.envTag || envTagOf(options.env);
  const limit = Number(options.limit) > 0 ? Number(options.limit) : MAX_MARKDOWN_BYTES;
  const maxParts = Number(options.maxParts) > 0 ? Number(options.maxParts) : DEFAULT_MAX_PARTS;
  const src = content == null ? '' : String(content);

  // 原文已有的【...】前缀：提取出来，统一作为所有分段的环境标签
  const lead = raw ? null : src.match(/^(【[^】]*】)/);
  const tag = raw ? '' : (lead ? lead[1] : envTag);
  const body = lead ? src.slice(lead[1].length) : src;

  // 预留：环境标签（需补时）+ 分段序号（" (99/99)"）+ 换行
  const reserve = (raw ? 0 : Buffer.byteLength(tag, 'utf8')) + 16;
  const budget = Math.max(1, limit - reserve);

  let parts = splitByBytes(body, budget);
  let truncated = false;
  if (parts.length > maxParts) {
    parts = parts.slice(0, maxParts);
    truncated = true;
  }
  if (truncated) {
    const lastBudget = Math.max(1, budget - Buffer.byteLength(TRUNCATE_NOTICE, 'utf8'));
    const last = splitByBytes(parts[parts.length - 1] || '', lastBudget)[0] || '';
    parts[parts.length - 1] = last + TRUNCATE_NOTICE;
  }

  const total = parts.length;
  // 单段且原文自带标签：原样返回，避免多插换行破坏原格式
  if (total === 1 && lead) return [src];

  return parts.map((part, i) => {
    const idx = total > 1 ? `(${i + 1}/${total})` : '';
    if (raw) return idx ? `${idx}\n${part}` : part;
    return `${tag}${idx ? ' ' + idx : ''}\n${part}`;
  });
}

class WeComRobot {
  /**
   * @param {object} [options]
   * @param {string} [options.webhookUrl] 机器人 webhook 地址（默认读 WECOM_ROBOT_WEBHOOK，再回退内置地址）
   * @param {string} [options.env]        运行环境，默认读 JUZHU_ENV / NODE_ENV
   * @param {string} [options.envTag]     环境标签覆盖（如 '预发' → 【预发】），默认读 WECOM_ROBOT_ENV_TAG
   * @param {number} [options.timeoutMs]  请求超时，默认读 WECOM_ROBOT_TIMEOUT_MS 或 8000
   * @param {number} [options.maxParts]   最多分段数，默认读 WECOM_ROBOT_MAX_PARTS 或 10
   * @param {number} [options.intervalMs] 多段发送间隔，默认读 WECOM_ROBOT_INTERVAL_MS 或 50
   * @param {number} [options.rateLimitPerMinute] 每个 webhook 每分钟最多发送条数，默认读 WECOM_RATE_LIMIT_PER_MINUTE 或 20
   * @param {number} [options.rateWindowMs] 限流窗口（毫秒），默认读 WECOM_RATE_WINDOW_MS 或 60000
   * @param {boolean} [options.rateLimit=false] 传 false 关闭限流（测试用），或 WECOM_RATE_LIMIT_DISABLED=1
   */
  constructor(options = {}) {
    this.webhookUrl = options.webhookUrl || process.env.WECOM_ROBOT_WEBHOOK || DEFAULT_WEBHOOK;
    this.env = normalizeEnv(options.env || process.env.JUZHU_ENV || process.env.NODE_ENV);
    const tag = options.envTag || process.env.WECOM_ROBOT_ENV_TAG;
    this.envTag = tag ? `【${String(tag).replace(/[【】]/g, '')}】` : envTagOf(this.env);
    this.timeoutMs = Number(options.timeoutMs || process.env.WECOM_ROBOT_TIMEOUT_MS || 8000);
    this.maxParts = Number(options.maxParts || process.env.WECOM_ROBOT_MAX_PARTS || DEFAULT_MAX_PARTS);
    this.intervalMs = Number(options.intervalMs || process.env.WECOM_ROBOT_INTERVAL_MS || 50);
    this.rateLimit = options.rateLimit;
    this.rateLimitPerMinute = options.rateLimitPerMinute;
    this.rateWindowMs = options.rateWindowMs;
  }

  /** 为一则消息补齐环境前缀（已带【...】开头则原样返回） */
  withPrefix(content) {
    const text = String(content == null ? '' : content);
    if (hasEnvPrefix(text)) return text;
    return `${this.envTag}\n${text}`;
  }

  /**
   * 发送 markdown 消息（超长自动分段，每段带环境前缀与 (i/n) 序号）。
   * @param {string} content markdown 正文（无需自己加环境标签）
   * @param {object} [options] maxBytes / maxParts / timeoutMs / intervalMs；raw=true 时不补环境前缀
   * @returns {Promise<object|object[]>} 单段返回企微结果对象；多段返回结果数组
   */
  async sendMarkdown(content, options = {}) {
    const messages = buildMessages(content, {
      raw: options.raw === true,
      envTag: this.envTag,
      limit: Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_MARKDOWN_BYTES,
      maxParts: Number(options.maxParts) > 0 ? Number(options.maxParts) : this.maxParts,
    });
    return this._sendEach('markdown', messages, options);
  }

  /**
   * 发送纯文本消息（超长自动分段，每段带环境前缀与 (i/n) 序号）。
   * @param {string} content 文本正文
   * @param {object} [options] 可带 mentioned_list / mentioned_mobile_list（仅挂到最后一段，避免重复 @）
   * @returns {Promise<object|object[]>}
   */
  async sendText(content, options = {}) {
    const messages = buildMessages(content, {
      raw: options.raw === true,
      envTag: this.envTag,
      limit: Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_TEXT_BYTES,
      maxParts: Number(options.maxParts) > 0 ? Number(options.maxParts) : this.maxParts,
    });
    return this._sendEach('text', messages, options, (i) => {
      // @ 只挂在最后一段，避免多段时重复提醒
      if (i !== messages.length - 1) return {};
      const extra = {};
      if (Array.isArray(options.mentioned_list) && options.mentioned_list.length) {
        extra.mentioned_list = options.mentioned_list;
      }
      if (Array.isArray(options.mentioned_mobile_list) && options.mentioned_mobile_list.length) {
        extra.mentioned_mobile_list = options.mentioned_mobile_list;
      }
      return extra;
    });
  }

  /** 顺序发送多条消息，段间隔 intervalMs，返回单条或数组 */
  async _sendEach(msgtype, messages, options = {}, extraOf) {
    const intervalMs = Number(options.intervalMs != null ? options.intervalMs : this.intervalMs) || 0;
    const results = [];
    for (let i = 0; i < messages.length; i++) {
      if (i > 0 && intervalMs > 0) await sleep(intervalMs);
      const extra = typeof extraOf === 'function' ? extraOf(i) : {};
      const body = msgtype === 'markdown'
        ? { msgtype: 'markdown', markdown: { content: messages[i] } }
        : { msgtype: 'text', text: Object.assign({ content: messages[i] }, extra) };
      results.push(await this.send(body, options));
    }
    return results.length === 1 ? results[0] : results;
  }

  /**
   * 发送（带频控 + 相同 body 串行）：
   *   - 每个 webhook ≤ rateLimitPerMinute 条/分钟，超出排队等待下一窗口；
   *   - 同一 webhook 相同 body 串行，避免 ≥2 个并发请求。
   * @param {object} body 企微消息体（msgtype + 对应内容）
   * @param {object} [options] 可覆盖 rateLimit / rateLimitPerMinute / rateWindowMs / timeoutMs
   * @returns {Promise<{errcode:number,errmsg:string}>}
   */
  async send(body, options = {}) {
    const bodyString = JSON.stringify(body);
    const cfg = resolveRateLimit({
      rateLimit: options.rateLimit !== undefined ? options.rateLimit : this.rateLimit,
      rateLimitPerMinute: options.rateLimitPerMinute || this.rateLimitPerMinute,
      rateWindowMs: options.rateWindowMs || this.rateWindowMs,
    });
    if (cfg.disabled) return this._post(bodyString, options);
    const lockKey = `${this.webhookUrl}\u0000${bodyString}`;
    return withBodyLock(lockKey, async () => {
      await acquireSlot(this.webhookUrl, cfg);
      return this._post(bodyString, options);
    });
  }

  /**
   * 单次 HTTP POST（不含频控/同 body 串行）。
   * @param {string} bodyString 已序列化的请求体
   * @param {object} [options]
   * @returns {Promise<{errcode:number,errmsg:string}>}
   */
  async _post(bodyString, options = {}) {
    const timeoutMs = Number(options.timeoutMs || this.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text = '';
    try {
      res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyString,
        signal: controller.signal,
      });
      text = await res.text().catch(() => '');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(`[wecom-robot] 发送超时（${timeoutMs}ms）`);
      }
      throw new Error(`[wecom-robot] 发送失败: ${(e && e.message) || e}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    let data = {};
    try { data = JSON.parse(text || '{}'); } catch (_) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      throw new Error(`[wecom-robot] HTTP ${res.status}: ${(data && data.errmsg) || text}`);
    }
    if (data && data.errcode !== 0) {
      throw new Error(`[wecom-robot] 企微返回错误 errcode=${data.errcode}: ${data.errmsg || text}`);
    }
    return data;
  }
}

/** 工厂方法 */
function createWeComRobot(options) {
  return new WeComRobot(options);
}

// 默认实例（按当前 JUZHU_ENV 自动选择环境标签）
const defaultRobot = new WeComRobot();

/** 便捷函数：用默认实例发送 markdown */
function sendMarkdown(content, options) {
  return defaultRobot.sendMarkdown(content, options);
}

/** 便捷函数：用默认实例发送文本 */
function sendText(content, options) {
  return defaultRobot.sendText(content, options);
}

module.exports = {
  WeComRobot,
  createWeComRobot,
  weComRobot: defaultRobot,
  sendMarkdown,
  sendText,
  splitByBytes,
  buildMessages,
  resolveRateLimit,
  acquireSlot,
  withBodyLock,
  resetRateLimiters,
  normalizeEnv,
  envTagOf,
  hasEnvPrefix,
  DEFAULT_WEBHOOK,
  MAX_MARKDOWN_BYTES,
  MAX_TEXT_BYTES,
  DEFAULT_MAX_PARTS,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  DEFAULT_RATE_WINDOW_MS,
  TRUNCATE_NOTICE,
};
