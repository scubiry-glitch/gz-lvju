#!/usr/bin/env node
/**
 * scripts/img_url_mode_regression.cjs —— S1 双写回归（纯函数，**不需要数据库、不需要起服务**）
 *
 * 覆盖：
 *   1) IMG_URL_MODE 三档语义（local 强制回退本地 / dual 缺省 / s3 存量路径改写）
 *   2) normalizeImageRef 归一化（URL / data: / s3:// / assets 路径 / 裸 key / 空值）
 *   3) legacyKeyOf / legacyUrlOf 迁移 key 映射（与 docs/s3-migration-plan.md §3.2 一致）
 *   4) isValidImageRef 封面判定（脏值不算）
 *   5) sourceUrlAllowed 镜像域名白名单（S1-7）
 *   6) img_thumbs 读侧投影：s3 模式把本地路径改写为 S3 URL（含缩略图候选）
 *
 * 用法：node scripts/img_url_mode_regression.cjs
 * 退出码：0 全通过 / 1 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');

for (const f of ['juzhu/.env.local', '.env', 'runtime.env']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim().replace(/^export /, '');
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail == null ? '' : ' → ' + detail}`);
  if (!cond) failed++;
}
const eq = (name, got, want) => check(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 每次都重新 require，保证读到最新的 env（img_storage 是同步读 env，无需清缓存；保险起见清掉）
function freshModules() {
  for (const m of ['./img_storage.cjs', './img_thumbs.cjs']) {
    delete require.cache[require.resolve('../' + m.replace('./', ''))];
  }
  const store = require('../img_storage.cjs');
  const thumbs = require('../img_thumbs.cjs');
  return { store, thumbs };
}

const LOCAL = 'assets/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg';
const S3_URL = 'https://file.ljcdn.com/test/lvju/housing/project/1611/2026/09/abc.jpg';

(async () => {
  console.log('=== S1 双写回归：IMG_URL_MODE / 图片引用归一化 ===\n');
  const origMode = process.env.IMG_URL_MODE;

  // ── 1) local 模式：最强回滚（强制本地，S3 配置齐全也不用） ──
  process.env.IMG_URL_MODE = 'local';
  {
    const { store } = freshModules();
    eq('local 模式：storageMode 强制 local', store.storageMode(), 'local');
    eq('local 模式：本地路径原样保留', store.normalizeImageRef(LOCAL), LOCAL);
    eq('local 模式：s3:// 仍转 URL（显式意图）', store.normalizeImageRef('s3://lvju/x/y.jpg'),
      'https://file.ljcdn.com/test/lvju/x/y.jpg');
    eq('local 模式：已 URL 原样', store.normalizeImageRef(S3_URL), S3_URL);
  }

  // ── 2) dual（缺省）：新上传走 S3，存量路径不改写 ──
  delete process.env.IMG_URL_MODE;
  {
    const { store } = freshModules();
    eq('缺省模式 = dual', store.urlMode(), 'dual');
    eq('dual 模式：storageMode = s3（已配置）', store.storageMode(), 's3');
    eq('dual 模式：本地路径原样保留（迁移由 S2 负责）', store.normalizeImageRef(LOCAL), LOCAL);
    eq('dual 模式：裸 key → 公网 URL', store.normalizeImageRef('lvju/housing/a.jpg'),
      'https://file.ljcdn.com/test/lvju/housing/a.jpg');
    eq('dual 模式：带前导斜杠的本地路径原样', store.normalizeImageRef('/' + LOCAL), '/' + LOCAL);
    eq('null 透传', store.normalizeImageRef(null), null);
    eq('空串透传', store.normalizeImageRef('   '), '   ');
    eq('data: 透传', store.normalizeImageRef('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  }

  // ── 3) s3 模式：存量本地路径改写为迁移后的 S3 URL（切读灰度） ──
  process.env.IMG_URL_MODE = 's3';
  {
    const { store, thumbs } = freshModules();
    eq('s3 模式：本地路径 → 迁移后 URL', store.normalizeImageRef(LOCAL),
      'https://file.ljcdn.com/test/lvju/legacy/juzhu/sy/projects/bzf/%E5%92%8C%E5%B9%B3%E5%8C%BA/CCB%E5%BB%BA%E8%9E%8D%E5%AE%B6%E5%9B%AD%E4%B8%AD%E5%8D%8E%E8%B7%AF%E5%BA%97.jpg');
    eq('迁移 key 规则（去 assets/ 挂 S3_MIGRATE_PREFIX）', store.legacyKeyOf(LOCAL),
      'lvju/legacy/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg');
    // 关键一致性：S2 迁移上传到 publicUrl(legacyKeyOf(path))，切读时读侧改写也走同一函数
    // → 两者必须逐字相等，否则切读必然 404
    eq('一致性：迁移目标 URL === 读侧改写 URL', store.legacyUrlOf(LOCAL), store.normalizeImageRef(LOCAL));
    eq('带前导斜杠同样处理', store.legacyKeyOf('/' + LOCAL), store.legacyKeyOf(LOCAL));
    eq('S3_MIGRATE_PREFIX 可覆盖', (() => {
      process.env.S3_MIGRATE_PREFIX = 'other/prefix';
      const s2 = freshModules().store;
      const got = s2.legacyKeyOf(LOCAL);
      delete process.env.S3_MIGRATE_PREFIX;
      return got;
    })(), 'other/prefix/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg');

    // 读侧投影（img_thumbs）：本地路径应被改写为 S3 URL（缩略图候选为异步 HEAD，首次返回原 URL 的 S3 形态）
    const projected = thumbs.mapThumbsDeep({ projects: [{ cover_image: LOCAL }] }, 640);
    const got = projected.projects[0].cover_image;
    check('读侧投影：s3 模式本地路径被改写为公网 URL',
      /^https:\/\/file\.ljcdn\.com\/test\/lvju\/legacy\//.test(got), got);

    const projectedDual = (() => {
      process.env.IMG_URL_MODE = 'dual';
      const t2 = freshModules().thumbs;
      const out = t2.mapThumbsDeep({ projects: [{ cover_image: LOCAL }] }, 640).projects[0].cover_image;
      return out;
    })();
    check('读侧投影：dual 模式不改写（仍为本地路径，交由本地缩略图逻辑）',
      projectedDual === LOCAL || /\.t640\.webp$/.test(projectedDual), projectedDual);
  }

  // ── 4) isValidImageRef（上架闸） ──
  delete process.env.IMG_URL_MODE;
  {
    const { store } = freshModules();
    check('URL 有效', store.isValidImageRef(S3_URL));
    check('本地路径有效', store.isValidImageRef(LOCAL));
    check('带前导斜杠本地路径有效', store.isValidImageRef('/' + LOCAL));
    check('s3:// 有效', store.isValidImageRef('s3://lvju/a.jpg'));
    check('脏值 todo 无效', !store.isValidImageRef('todo'));
    check('脏值 - 无效', !store.isValidImageRef('-'));
    check('空值无效', !store.isValidImageRef('') && !store.isValidImageRef(null));
  }

  // ── 5) source_url 白名单（S1-7） ──
  {
    const s3mod = freshModules().store;
    delete process.env.S3_SOURCE_URL_ALLOWLIST;
    check('未配置白名单 → 不限制', s3mod.sourceUrlAllowed('https://any.example.com/a.jpg'));
    process.env.S3_SOURCE_URL_ALLOWLIST = 'ljcdn.com, vendor.example.com';
    const s2 = freshModules().store;
    check('白名单命中（子域）', s2.sourceUrlAllowed('https://img.ljcdn.com/a.jpg'));
    check('白名单命中（精确）', s2.sourceUrlAllowed('https://vendor.example.com/a.jpg'));
    check('白名单未命中 → 拒绝', !s2.sourceUrlAllowed('https://evil.example.net/a.jpg'));
    check('非法 URL → 拒绝', !s2.sourceUrlAllowed('not-a-url'));
    delete process.env.S3_SOURCE_URL_ALLOWLIST;
  }

  if (origMode == null) delete process.env.IMG_URL_MODE; else process.env.IMG_URL_MODE = origMode;

  console.log(`\n${failed === 0 ? 'S1 双写回归全部通过 ✅' : failed + ' 项失败 ❌'}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('回归异常:', e && e.stack || e);
  process.exit(2);
});
