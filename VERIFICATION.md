# 居住服务平台原型 · 验收快照

**验收时间**：2026-07-12
**验收范围**：四业务线（保租房 / 新居住 / 旅居 / 家政）+ 共享总线 + SQLite 数据层 + 地域切换 + 近期 ②③④⑤ 改动
**验收方式**：`python3 -m http.server 8903` 逐页 `curl` 校验 HTTP 200（静态可达性）；后端依赖页面单列说明。
**说明**：本报告只登记「实际检查到」的结论，不做「全绿」承诺。

---

## 1. 页面规模（对仓库实测）

| 维度 | 数量 | 命令 |
|---|---:|---|
| HTML 总计 | 176 | `find . -name '*.html' \| wc -l` |
| `screens/*.html` | 109 | `ls screens/*.html \| wc -l` |
| 根目录 `*.html` | 67 | `ls *.html \| wc -l` |
| 其中 `lvju-app-*` | 33 | |
| 其中 `juzhu-*` | 12 | |
| 其中 `jiazheng-*` | 9 | |
| 其中 `lvju-*`（非 app） | 6 | |
| 其中 `baozufang-*`（含 V1/V2/V3） | 4 | |

`screens/` 前缀分布：P 34 · G 14 · S 9 · B 7 · F 6 · D 6 · C 5 · V 3 · T 3 · M 3 + 若干无前缀 C 端页。

---

## 2. 入口页可达性（HTTP 200，实测）

`python3 -m http.server 8903` 下 `curl -o /dev/null -w "%{http_code}"`：

| 页面 | HTTP |
|---|:-:|
| `index.html` | 200 |
| `overview.html` | 200 |
| `baozufang-channel-overview.html` | 200 |
| `baozufang-overview-v1-basic.html` | 200 |
| `baozufang-overview-v2-standard.html` | 200 |
| `baozufang-overview-v3-full.html` | 200 |
| `index2.html` | 200 |
| `lvju-app-home.html` | 200 |
| `lvju-overview.html` | 200 |
| `jiazheng-landing-cleaning.html` | 200 |
| `screens/g-whitelist-review.html`（②新建） | 200 |
| `screens/b-occupancy.html`（③家政工单池） | 200 |
| `screens/g-complaint.html`（③家政差评→投诉） | 200 |
| `screens/gov-admin.html` | 200 |
| `screens/p-console.html` | 200 |
| `screens/d-org-standard.html` | 200 |

**结论**：以上 16 个代表性入口页 **16/16 = 200**。

> 注：这些页面的静态 HTML 可达；`juzhu-*` / `jiazheng-*` / 家政下单闭环的**数据内容**需 `python3 juzhu/server.py`（端口 8765）才能拉到 SQLite 数据，静态服务器下命中 `/api/juzhu/...` 返回 404（预期）。

---

## 3. 业务线覆盖

| 业务线 | 主入口 | 状态 |
|---|---|:-:|
| 保租房四端 + P 中台 | `baozufang-channel-overview.html` / `screens/*` | ✅ 静态可达 |
| 新居住 juzhu | `index.html` / `juzhu-admin.html` | ✅ 静态可达（数据需后端） |
| 旅居 App（33 页） | `lvju-app-home.html` | ✅ 静态可达 |
| 家政（9 落地页 + 下单闭环） | `jiazheng-landing-*.html` / `juzhu-jiazheng-*.html` | ✅ 静态可达（闭环需后端 API） |

---

## 4. 共享总线 / 数据层架构（实测存在）

| 组件 | 文件 | 校验 |
|---|---|:-:|
| 导航单一数据源 | `screens/_nav.js` | ✅ 存在（SERIES G/B/F/P/S/C） |
| 移动 chrome | `screens/_navmobile.js` | ✅ |
| 地域配置 | `screens/_region.js` | ✅ `PRESETS`: `js`(默认)/`gx`/`sy_zj`/`gz_zj` |
| 报修工单总线 | `screens/_orderbus.js` | ✅ `localStorage bzf_orders` |
| 家政 REST 总线 | `screens/_jzapi.js` | ✅ 走 SQLite（`/api/juzhu/jiazheng/*` + `/api/juzhu/jz/*`） |
| SQLite 数据层 | `juzhu/server.py` + `juzhu/juzhu.db` | ✅ `server.py` 端口 8765；`juzhu.db` 存在（98KB） |

**三层数据边界**（④）：`jiazheng-data.js`（目录 mock/兜底）/ `_jzapi.js`（SQLite 订单总线）/ `_orderbus.js`（localStorage 报修）三条并行、不重叠 —— 已在 `README.md` 与 `CLAUDE.md` 规则 8/9 记录。

---

## 5. 近期改动验证（②③④⑤）

| 项 | 内容 | 验证结果 |
|---|---|:-:|
| ② | `screens/g-whitelist-review.html`（白名单审核 hub）新建 + 注册进 `_nav.js` | ✅ 文件存在（15KB）；`_nav.js` G 系列含 `whitelist-review` 项；HTTP 200 |
| ② | 12/13 原「待建」stub 实为已建 | ✅ 13 个页面全部存在且体量真实（10–27KB，非空 stub） |
| ③ | 家政 API 扩到 B 端 `b-occupancy.html`（工单池）+ G 端 `g-complaint.html`（差评→监管投诉，只读监管） | ✅ 两文件存在（18.9KB / 12.6KB）；HTTP 200；未新增 localStorage key（SQLite 单一源） |
| ④ | 数据源边界文档化；6 张散图移入 `assets/_scratch/`；删 `lvju-rating-standard.html.bak` | ✅ `assets/_scratch/` 存在含 6 图；`_jzapi.js` 头注已写边界 |
| ⑤ | `_region.js` 支持 `js/gx/sy_zj/gz_zj`；`relabelStr()` 属性改名 | ✅ 四预设在 `PRESETS`；`relabelStr` 见于 `_region.js` |

> 修正：任务描述中提到的预设 `gz_wl` 实际代码中为 **`gz_zj`**（贵州·旅居），README/本报告以代码为准。

---

## 6. 图片 / 附件链接校验

| 引用 | 存在 |
|---|:-:|
| `20260605_192600.png`（README 图谱） | ✅ 仓库根，1.5MB |
| `20260605_223100.png` | ✅ 仓库根 |
| `PRD-保租房专用频道-V1.0.md` | ✅ |
| `江苏租赁行业标准_V25.docx` | ✅ |
| `mq0pq2pl-_好房子_标准提案-.xlsx` | ✅ |

README 引用的两张图谱 PNG 仍在仓库根（④ 未搬动它们），链接有效。

---

## 7. 未在本轮验证的项（诚实标注）

- 未逐页 curl 全部 176 页，仅抽验 16 个代表性入口页。
- 未启动 `juzhu/server.py` 做端到端 API/下单闭环联调，仅确认静态 HTML 可达 + 数据层文件与端口存在；后端依赖页面的**数据渲染**未在本次跑通。
- 未做浏览器渲染/交互回归，仅做 HTTP 状态码级别的可达性检查。

---

**验收结论**：抽验的 16 个入口页 HTTP 200 全通过；四业务线与共享总线 / SQLite 数据层 / 地域四预设 / ②③④⑤ 改动均在仓库中核实存在。文档（`README.md` / 本文件）已与代码现状对齐，消除旧「28 页保租房」口径的 doc↔code 漂移。后端依赖页面的运行时数据需 `python3 juzhu/server.py` 另行联调。
