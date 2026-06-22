#!/usr/bin/env node
// 江苏保租房 · D 系列 PDF 导出脚本
// 使用 playwright-core（agent-browser 已附带），输出 A3 横版以容纳宽栅格。
// 用法： node exports/gen-pdfs.mjs

import playwrightCore from '/root/.nvm/versions/node/v22.22.0/lib/node_modules/agent-browser/node_modules/playwright-core/index.js';
const { chromium } = playwrightCore;
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PAGES = [
  { src: 'screens/d-master-blueprint.html',          out: '01-总图谱.pdf',                   title: '总图谱' },
  { src: 'screens/d-people-standard.html',           out: '02-人的标准·服务者认证体系.pdf',  title: '人的标准' },
  { src: 'screens/d-property-standard.html',         out: '03-房的标准·好房子四维度.pdf',    title: '房的标准' },
  { src: 'screens/d-org-standard.html',              out: '04-机构的标准·五类机构生态.pdf',  title: '机构的标准' },
  { src: 'baozufang-channel-overview.html',          out: '05-三档总对比.pdf',               title: '三档总对比' },
  { src: 'baozufang-overview-v1-basic.html',         out: '06-阶段一·展示型.pdf',            title: '阶段一·展示型' },
  { src: 'baozufang-overview-v2-standard.html',      out: '07-阶段二·标准体系.pdf',          title: '阶段二·标准体系' },
  { src: 'baozufang-overview-v3-full.html',          out: '08-阶段三·交易闭环.pdf',          title: '阶段三·交易闭环' },
];

// 导出时注入的样式：隐藏侧栏与已实现标注 / 紧凑排版 / 保留背景色 / 避免卡片腰斩
const PRINT_CSS = `
  /* 隐藏共享侧栏 / 底部 tab，主区拉满 */
  #side-nav, .nv-side, #tab-bar, .nv-tabbar { display: none !important; }
  body.nv-with-side { display: block !important; grid-template-columns: none !important; }
  .main-wrap { padding: 8px 14px !important; max-width: none !important; }

  /* 隐藏"已实现页面"标注块（impl-aligned） + 页内 quick-jump 跳转条 + 顶部 ecosystem 跳转 */
  .impl-aligned, .impl-banner, .impl-pill, .impl-card,
  .quick-jump, .nv-overview-link { display: none !important; }

  /* 保留背景/渐变色 */
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

  /* —— 紧凑化 —— */
  body { font-size: 11.5px !important; line-height: 1.4 !important; }
  .doc-header { padding: 10px 14px !important; margin-bottom: 10px !important; }
  .doc-header h1 { font-size: 19px !important; margin-bottom: 4px !important; }
  .doc-header .sub { font-size: 12px !important; }
  .section { padding: 10px 14px !important; margin-bottom: 10px !important; border-radius: 10px !important; }
  .section-title { font-size: 13px !important; margin-bottom: 8px !important; padding-bottom: 6px !important; }
  .row-1 { gap: 10px !important; margin-bottom: 10px !important; }
  .pain-list, .four-grid, .cap-grid, .phase-grid, .flow, .value-grid, .longterm,
  .quad-grid, .standard-grid, .matrix-grid {
    gap: 8px !important;
  }
  .pain-card, .party-card, .value-card, .phase-card, .lt-card, .cap-card, .flow-node {
    padding: 9px !important; border-radius: 8px !important;
  }
  .goal-box { padding: 12px !important; }
  .goal-box .t { font-size: 16px !important; }
  h2, h3 { margin-top: 6px !important; margin-bottom: 6px !important; }

  /* 减少卡片被分页腰斩 */
  .section, .pain-card, .party-card, .value-card, .phase-card, .lt-card,
  .cap-card, .flow-node, .quad-card, .matrix-row {
    break-inside: avoid; page-break-inside: avoid;
  }
  .section-title { break-after: avoid; page-break-after: avoid; }
`;

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    deviceScaleFactor: 1,
  });

  for (const p of PAGES) {
    const srcPath = path.join(ROOT, p.src);
    const outPath = path.join(__dirname, p.out);
    const url = pathToFileURL(srcPath).href;

    process.stdout.write(`→ ${p.title}  ${p.src}\n`);

    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: PRINT_CSS });
    // 等待字体/图标稳定
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(300);

    await page.pdf({
      path: outPath,
      format: 'A3',
      landscape: true,
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '10mm', right: '10mm', bottom: '12mm', left: '10mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8px; color:#94a3b8; width:100%; padding:0 12mm; display:flex; justify-content:space-between;">
        <span>江苏省住房运营基础设施合作计划 · ${p.title}</span>
        <span></span>
      </div>`,
      footerTemplate: `<div style="font-size:8px; color:#94a3b8; width:100%; padding:0 12mm; display:flex; justify-content:space-between;">
        <span>${p.src}</span>
        <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
    });

    await page.close();
    process.stdout.write(`   ✓ ${p.out}\n`);
  }

  await ctx.close();
  await browser.close();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
