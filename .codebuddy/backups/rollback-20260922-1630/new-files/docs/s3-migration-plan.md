# 房源图片迁移 S3 实施计划（含可执行任务清单）

> **状态**：已评审决策，**待执行**（2026-09-22 评审通过）
> **范围**：把房源图片的写入/存储/读取从本地 `assets/` 统一改为贝壳 ODS/S3（`/api/juzhu/housing/*` 与 admin 后台全链路）
> **前置阅读**：[`docs/s3-image-storage.md`](s3-image-storage.md)（S3 接入口径、实测结论、验证方法）
> **约定**：实施须遵守 [`CLAUDE.md`](../CLAUDE.md) 规则 21（图片存储单一出口）

---

## 0. 决策记录（2026-09-22 确认）

| # | 决策点 | 结论 | 对方案的影响 |
|---|---|---|---|
| 1 | 后台 `/admin/upload` 契约 | **补 multipart + `scope` 兼容**（保留前端调用方式） | S0-1 必做；不采纳「后台前端改 JSON」方案 |
| 2 | S3 对象可读性 | **保持 `public-read`**（C 端直读） | `S3_EXTRA_HEADERS={"x-amz-acl":"public-read"}` 保持；不引入签名 URL / 代理层 |
| 3 | 存量迁移范围 | **只迁 `photos` + `cover_image` 引用的图** | 页面自带素材（`assets/lvju` 硬编码示例图）**不迁**；迁移量 1673 → 约 900–1000 张（以扫描结果为准） |
| 4 | 图片重编码 | **允许** sharp 统一转 JPEG | PNG 透明通道会丢失，可接受；`IMG_NORMALIZE=1` 保持缺省 |
| 5 | 存量缩略图 | **先不生成**（不补 `.t240/.t640.webp`，不加 `photos.thumb_*` 列） | 迁移后本地缩略图体系失效 → C 端首批请求走原图，§4-H4 列为**已知可接受退化** |

**由决策 5 衍生的一个明确边界（需知晓，勿误解）**：本决策只约束**存量图**。**新上传**仍按现有实现生成并上传两档缩略图（`img_storage.uploadImage` 缺省 `make_thumbs:true`），因为它们同时进 S3、成本低且能让新图首屏更快。若希望"新旧完全一致（都不生成）"，把上传入参 `make_thumbs:false` 即可，属 S4 可选项（S4-5）。

---

## 1. 现状地图（速查）

### 1.1 图片字段（11 处，7 张表 + 1 个 KV）

| 表 / 键 | 字段 | 现状语义 | 读取方 |
|---|---|---|---|
| `photos` | `file_path` / `source_path` | 相对路径，**不带前导斜杠**（种子实测 585 条全为 `assets/juzhu/sy/...`） | catalog、`projects/:id`、admin 图集 |
| `photos` | `entity_type` / `entity_id` / `is_cover` / `sort_order` | 多态 `project`/`unit`/`district`/`spot`；封面互斥 | 同上 |
| `projects` | `cover_image` | 相对路径 | catalog、详情、**订单接口、webhook** |
| `units` | `cover_image` | 相对路径（由 `syncUnitCover` 从 `photos` 回写） | 详情、units 列表 |
| `districts` | `cover_image` | 相对路径 | catalog、juzhu 首页 |
| `cities` | `hero_bg_image` | 相对路径 | C 端首页 hero |
| `spots` | `cover_image` / `photos`(JSON 图集) | 相对路径 / 路径数组 | 笔记页、玩法列表、项目周边 |
| `routes` | `cover_image` | 相对路径（可空 = 回落首站封面） | 路线列表/详情 |
| `settings` | `topic_*.cover_image`（KV JSON） | 相对路径 | topics 接口、search/topic 页 |

类型均 `VARCHAR(500)` 或 `TEXT`；S3 URL 约 75 字符 → **无需扩列**。

### 1.2 写入接口（12 条）

| 接口 | 图片行为 | 备注 |
|---|---|---|
| `POST /api/juzhu/admin/photos/upload` | 新增（S3，JSON base64/source_url） | 本轮新增能力 |
| `POST /api/juzhu/admin/upload` | **契约冲突**：前端按 Python 版 multipart + `scope` 调用，期望 `{file_path}` | **S0-1 修复** |
| `POST /api/juzhu/admin/units/:id/photos` | JSON `file_path` 透传；multipart 直接 503 | **S0-2 修复** |
| `PUT /api/juzhu/admin/photos/:id` | 改 `file_path` / `sort_order` / `is_cover`（仅 unit） | S1-3 归一化入参 |
| `DELETE /api/juzhu/admin/photos/:id` | **只删库行，不删对象** | S1-5 补删对象 |
| `POST|PUT /api/juzhu/admin/projects` | `cover_image` 直写 | S1-1 收口 |
| `POST|PUT|DELETE /api/juzhu/admin/units*` | `cover_image` + `syncUnitCover` | S1-1 收口 |
| admin `districts`/`spots`/`routes`/`topics`/`city` | 各自 `cover_image` | S1-1 收口 |
| `POST /api/juzhu/housing/vendor/photos/add` | `file_path` 透传（≤500） | S1-3 归一化 |
| `POST /api/juzhu/housing/vendor/photos/upload` | 新增（S3） | — |
| vendor `projects/create|update`、`units/create|update` | `cover_image` 直写 | S1-1 收口 |
| 种子脚本 5 个（`housing_seed` / `demo-listings` / `lvju-stay-seed` / `spots-seed` / `routes-seed` / `find-topic-seed`） | 直写本地相对路径 | S2-3 迁移后同步改口径 |

`scope` 契约（源 `juzhu/server.py:2424-2500`）：`project_cover` / `project_cover_new` / `unit_cover` / `unit_gallery` / `unit_photo` / `unit_keeper` / `city_hero`；响应 `{ok:true, file_path:'assets/...'}`；`city_hero` 额外回写 `cities.hero_bg_image`。

### 1.3 读取与展示：3 套互不统一的约定

| 套系 | 代表文件 | 写法 | S3 绝对 URL |
|---|---|---|---|
| A. C 端 lvju（36 页） | `lvju-app-detail/minsu/routes/spots/topic/search` | `url(' + esc(cover_image) + ')` | ✅ 可用 |
| B. juzhu 频道 | `index.html`、`juzhu-bzf-*.html`、`juzhu-unit-detail.html` | 经 `JUZHU.thumbUrl()`（`juzhu/app.js:391-404`） | ⚠ 原样返回（不坏图，无缩略图） |
| C. 运营后台 | `juzhu-admin.html`(9) / `juzhu-admin-unit.html`(8) / `screens/p-rating-detail.html`(1) | `url('/'+p.replace(/^\//,''))` | ❌ **必然坏图**（18 处） |

后端缩略图改写集中在 7 处 `imgThumbs.mapThumbsDeep(..., 640)`：`app.js:4391`（catalog）、`4483`（项目详情周边）、`4523`/`4533`（routes）、`4555`/`4594`（spots）、`4617`（projects/:id）。

### 1.4 存储与缩略图现状

- `assets/` **417MB / 1673 张**（`assets/juzhu` 406MB、`assets/lvju` 5.8MB），由 `app.js` 静态服务直出。
- `img_thumbs.cjs`：`.t240.webp` / `.t640.webp` 同目录约定，现存 414 个；启动全量扫描 + 每小时增量（`app.js:7123`）。
- 另有一套历史缩略图 `assets/juzhu/sy/thumbs/**`（411 个），对应 `juzhu/app.js` 的 `thumbUrl()` 目录式约定 —— **两套并存**，决策 5 后均不再新增。

---

## 2. 改动范围清单

### 2.1 后端

| # | 模块 | 改动 |
|---|---|---|
| B1 | `img_storage.cjs` | 保持「唯一写入口」；补 `scope` 语义映射（`scope` → `entityType/entityId/prefix`） |
| B2 | `app.js` `/admin/upload` | 补 **multipart 解析 + `scope` 分支**，响应同时给 `{ok, file_path, upload}` |
| B3 | `app.js` `/admin/units/:id/photos` | 支持 multipart（或保留 JSON 双协议） |
| B4 | 8 个写图片分支 | 全部改为「先上传 → 存 URL」，禁止直写路径 |
| B5 | `app.js` `syncUnitCover` / `insertPhotoRow` | 写 URL；封面同步补齐 `district`/`spot` 两类实体 |
| B6 | `DELETE /admin/photos/:id` | 增加同步删对象（`S3_DELETE_ON_PHOTO_DELETE`） |
| B7 | `publishEligibility`（app.js:765、vendor_api.cjs:437） | `cover_image` 判定改为「可解析为 URL / 本地路径」 |
| B8 | vendor 订单接口 + webhook 载荷 | `project_cover` 语义由路径变 URL（**对外契约**，需公告） |

### 2.2 数据字段

- **不改表结构**；`file_path` / `cover_image` 语义由「相对路径」变为「绝对 URL」。
- 本轮**不加** `photos.thumb_240/640`、不加 `photos.storage`（决策 5）。
- 迁移期新增**回滚列**（可空，幂等 ALTER）：`photos.legacy_file_path`、`projects.legacy_cover_image`、`units.legacy_cover_image`、`districts.legacy_cover_image`、`spots.legacy_cover_image`、`routes.legacy_cover_image`、`cities.legacy_hero_bg_image`（→ S2-4）。

### 2.3 前端

| # | 位置 | 处数 | 改动 |
|---|---|---|---|
| F1 | `juzhu-admin.html` | 9 | 引入 `imgUrl(p)`：`http(s)` 直用 / `/assets` 原样 / 裸 key 拼 file-endpoint |
| F2 | `juzhu-admin-unit.html` | 8 | 同上 |
| F3 | `screens/p-rating-detail.html` | 1 | 同上 |
| F4 | `juzhu/app.js` `thumbUrl()` | 1 函数 | 绝对 URL 原样返回（当前行为已安全），显式化 + 注释 |
| F5 | `juzhu-admin*.html` `uploadForm` | 2 函数 | 适配 S0-1 的新响应（保留 `res.file_path` 兼容读取） |

### 2.4 配置项

| 配置 | 作用 | 缺省 |
|---|---|---|
| `IMG_URL_MODE` | **灰度/回滚主开关**：`local` / `dual` / `s3` | `local` |
| `S3_MIGRATE_PREFIX` | 存量迁移 key 前缀 | `lvju/legacy` |
| `S3_DELETE_ON_PHOTO_DELETE` | 删图同步删对象 | `0` |
| `S3_SOURCE_URL_ALLOWLIST` | `source_url` 镜像域名白名单（防 SSRF） | 空（不限制） |
| `IMG_NORMALIZE` | 归一化开关（决策 4 = 开） | `1` |

### 2.5 文档

`screens/property-intake-api.html`、`api_doc.md` §5.9、`CLAUDE.md` 规则 17/21、`docs/s3-image-storage.md`、商家接入指引（`搬家商家接入指引.md` 中涉及图片路径的段落）。

---

## 3. 迁移设计

### 3.1 迁移范围（决策 3）

**扫描并迁移以下引用（去重后逐个上传）：**

```
photos.file_path                                  （全部 entity_type）
projects.cover_image
units.cover_image
districts.cover_image
cities.hero_bg_image
spots.cover_image + spots.photos(JSON 数组)
routes.cover_image
settings['topic_*'].cover_image
```

> `spots.photos` 图集属于"封面同源"内容（笔记页把封面与图集拼成一个轮播），若不一并迁移会出现**本地/S3 混链**，故默认纳入。如你希望严格只迁"封面"，在 S2-1 加 `--no-spot-gallery` 即可。

**明确不迁移**：页面里硬编码的示例素材（`assets/lvju/xijiang-night.jpg` 等 6+4+3+2+1 处）、`screens/shots/*.jpg`（文档截图）、`exports/*.pdf`、`assets/_scratch/**`。

### 3.2 key 映射规则

```
本地：assets/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg
S3  ：lvju/legacy/juzhu/sy/projects/bzf/和平区/CCB建融家园中华路店.jpg
                └─ 去掉 assets/ 前缀，挂到 S3_MIGRATE_PREFIX 下（原路径天然唯一）
对外：https://file.ljcdn.com/test/<S3_KEY_PREFIX>/legacy/...
```

- 中文路径**保持原样**（对象 key 支持 UTF-8；若网关有问题则回退为 `md5(原名)+原扩展名`，需在 S2-1 加 `--ascii-key`）。
- **新上传**仍用现有规则 `lvju/housing/<entity>/<id>/<yyyy>/<MM>/<uuid>.<ext>`（与存量 key 并存，互不干扰）。

### 3.3 路径归一化（脚本必须处理）

- 库内值以**不带前导斜杠**为主（种子实测 585/585），但历史 Python 写入路径与人工录入可能带 `/` → 统一 `lstrip('/')` 后再匹配。
- 已是 `http(s)://` 的值 → **跳过**（幂等：重跑不会重复迁移）。
- 找不到本地文件的引用 → 记入 `missing` 清单，**不改库**，输出报告待人工确认。

### 3.4 迁移脚本规格（S2-1）

`scripts/s3-migrate-images.cjs`

| 能力 | 要求 |
|---|---|
| 模式 | `--dry-run`（默认） / `--apply`；`--limit=N` 分批；`--only=photos,projects,...` |
| 幂等 | 已迁移（URL 或 legacy 列已填）跳过；重复执行结果一致 |
| 断点 | 进度落 `scripts/__fixtures__/s3-migrate-progress.json`，中断可续跑 |
| 节流 | 并发 ≤4、每张间隔可配（`--concurrency` / `--rps`），避免压垮网关 |
| 回滚列 | `--apply` 时先把原值写入 `legacy_*` 列，再写新 URL |
| 报告 | 输出 `migrated / skipped / missing / failed` 计数 + `scripts/s3-migrate-report-<ts>.json` |
| 凭证 | 只读环境变量（`MYSQL_*` / `S3_*`），禁止写入仓库 |

### 3.5 校验方法（S2-2）

`scripts/s3-verify-images.cjs`

1. **抽样可访问性**：随机 N 张（缺省 100）HEAD 公网 URL → 200。
2. **字节数一致**：与本地文件比对（注意重编码会改变字节数 → 改为「非空 + Content-Type 为图片类型」）。
3. **引用完整性**：所有被引用值均为 `public_url` 前缀（无 `assets/` 残留，`--allow-local` 可豁免白名单）。
4. **封面归属**：`projects.cover_image` 必须命中该项目的 `photos` 之一（或为独立 URL）。
5. **反查孤儿**：S3 上 `lvju/legacy/**` 的对象数 vs 引用数（差异 = 孤儿，输出清单）。

---

## 4. 风险评估与缓解

| ID | 风险 | 等级 | 缓解 / 决策后变化 |
|---|---|---|---|
| H1 | `/admin/upload` 契约冲突（前端 multipart+scope vs 现状 JSON/415） | **高** | S0-1 修复；**当前后台图片上传本就不可用**，属"顺手修复" |
| H2 | 前端 18 处 `'/'+path` 拼接待改，否则后台/评级页全白 | **高** | S0-3 机械替换 + 统一 `imgUrl()` |
| H3 | 存量迁移顺序错误导致大面积坏图 | **高** | 严格按 §5 阶段推进；S2 先迁文件后改库，且**不删本地** |
| H3b | 重编码丢 PNG 透明（决策 4 已接受） | 低 | 已知可接受；如需保留可临时 `IMG_NORMALIZE=0` |
| H4 | 缩略图体系失效，C 端首屏加载原图 | 中 | **决策 5 已接受**；新上传仍生成缩略图；后续可用 S4-5/§8 增强 |
| H5 | `public-read` = 拿到 URL 即可读 | 中 | **决策 2 已确认**；房源图为公开素材，风险可接受；禁删为唯一防护点（`S3_DELETE_ON_PHOTO_DELETE=0`） |
| H6 | 删除图片产生 S3 孤儿对象 | 中 | S1-5 + S4-2 孤儿扫描 + 生命周期规则 |
| H7 | 无回滚手段 | **高** | S2-4 `legacy_*` 列 + `IMG_URL_MODE=local` 一键切回 + 迁移期不删 `assets/` |
| H8 | 商家契约变更（`project_cover` 语义） | 中 | S1-6 公告 + 保留"路径形态也能渲染"的兼容说明 |
| H9 | `source_url` 镜像 SSRF | 中 | `S3_SOURCE_URL_ALLOWLIST`（S1-7） |
| H10 | 回归测试断言的是纯文件名（`test_housing_catalog.js:59-62`） | 低 | 迁移后同步更新测试夹具 |
| H11 | 迁移脚本压垮网关 | 中 | 并发 ≤4 + 限速 + 分批 `--limit` |
| H12 | 中文 key 兼容性未知 | 中 | S2-1 先跑 `--dry-run` + 单条 `--apply --limit=1` 验证；备选 `--ascii-key` |

---

## 5. 可执行任务清单

### 执行记录

| 阶段 | 状态 | 完成时间 | 回归命令 |
|---|---|---|---|
| **S0 契约修复** | ✅ **已完成**（S0-1…S0-5） | 2026-09-22 | `npm run test:admin-upload`（13 项 PASS / 1 项 SKIP-DB） |
| **S1 双写** | ✅ **已完成**（S1-1…S1-7；S1-8 为环境灰度动作） | 2026-09-22 | `npm run test:img-mode`（30 项 PASS，纯函数无需 DB） |
| **S2 存量迁移** | 🟡 **工具已就绪**（S2-1…S2-4 完成，S2-5/S2-6 待库环境执行） | 2026-09-22 | `npm run s3:migrate -- --selftest=3`（无需 DB，2 项 PASS） |
| S3 切读 | ⬜ 待执行 | — | — |
| S4 收尾 | ⬜ 待执行 | — | — |

**S0 交付要点**：`app.js` 新增 `readRawBody()`（二进制安全）+ `parseMultipart()`（分隔符须带 `\r\n` 前缀，避免图片字节误切）+ `handleAdminMultipartUpload()`（7 种 `scope`，按需建连）；`/admin/upload` 支持 multipart 并保留 JSON 分支；`/admin/units/:id/photos` 支持 multipart 直传落库；前端 `juzhu-admin.html`(9)、`juzhu-admin-unit.html`(8)、`screens/p-rating-detail.html`(1) 共 18 处改为 `imgUrl()/cssUrl()` 归一。
**已知未验证项**：`scope ∈ {project_cover, unit_cover, unit_gallery, unit_keeper, unit_photo, city_hero}` 需数据库校验，本机 MySQL 不可达 → 留待有库环境跑 `npm run test:admin-upload -- --password=***`。

### S0 · 契约修复（不涉 S3，可先行独立上线）

| ID | 任务 | 改动文件 | 验收标准 | 回滚 |
|---|---|---|---|---|
| S0-1 | `/api/juzhu/admin/upload` 补 **multipart + `scope`**（7 种 scope），响应 `{ok, message, file_path, upload}` | `app.js`（`/admin/upload` 路由）、`img_storage.cjs` | 后台 7 个上传入口逐个手测 200 且 `file_path` 可渲染；`scope=city_hero` 回写 `cities.hero_bg_image` | `IMG_URL_MODE=local` 不影响；纯 revert |
| S0-2 | `/api/juzhu/admin/units/:id/photos` 支持 multipart | `app.js` | 户型图集"上传"按钮可用（返回 `{file_path}`） | revert |
| S0-3 | 前端 `imgUrl(p)` 助手 + **18 处**替换 | `juzhu-admin.html`(9)、`juzhu-admin-unit.html`(8)、`screens/p-rating-detail.html`(1) | 本地路径与 `http(s)` URL 都能正确显示（构造两种值各测一次） | revert |
| S0-4 | `juzhu-admin*.html` 适配新响应（兼容读 `file_path`） | 同上 2 文件 | 上传后预览立即出图 | revert |
| S0-5 | 回归：`node scripts/s3_api_e2e.cjs` + 7 种 scope 手测清单 | — | 全绿 | — |

> S0 完成后，**现状（本地存储）功能即已修复并可用**，不依赖 S3 切换。

### S1 · 双写（新图走 S3，读路径不变）

| ID | 任务 | 改动文件 | 验收标准 | 回滚 |
|---|---|---|---|---|
| S1-1 | 写图片分支统一收口到 `normImg()`（存 URL） | `app.js`(14 处)、`vendor_api.cjs`(6 处) | 新上传/新项目/新户型/districts/spots(含图集)/routes/topics 的图片字段全为可直用值 | 关 `IMG_URL_MODE` |
| S1-2 | 新增 `IMG_URL_MODE=local\|dual\|s3` 开关并接入读写路径 | `img_storage.cjs`、`img_thumbs.cjs` | 三档语义各 4 项断言通过；`local` 时 `storageMode()` 强制本地 | 改 env |
| S1-3 | `PUT /admin/photos/:id`、vendor `photos/add` 入参归一化（`s3://` / 裸 key / URL / 本地路径） | 同上 | 四种入参都落成可直用值 | revert |
| S1-4 | `publishEligibility` 封面判定改为 `isValidImageRef` | `app.js`、`vendor_api.cjs` | 本地/S3 封面都能过闸；`todo`/`-` 之类脏值仍拒 | revert |
| S1-5 | `S3_DELETE_ON_PHOTO_DELETE`（缺省 0）+ 删图删对象（含缩略图） | `app.js` DELETE 路由 + `deleteImageObject()` | 开时对象被删并返回 `object_deleted`；关时行为不变 | 改 env |
| S1-6 | 商家文档口径：图片字段为公网 URL + 三种上传方式 | `screens/property-intake-api.html` | 数据字典与新增 callout 明确 URL 语义、兼容旧路径 | revert |
| S1-7 | `S3_SOURCE_URL_ALLOWLIST`（防 SSRF） | `img_storage.cjs` | 白名单外 `source_url` 返回 400（含子域匹配） | 改 env |
| S1-8 | 灰度：仅 `rental` 频道新图走 S3 一周 | 环境动作 | 无 404/坏图告警 | 改 env |

**S1 交付要点**：`img_storage.cjs` 新增 `urlMode()/migratePrefix()/legacyKeyOf()/legacyUrlOf()/normalizeImageRef()/isValidImageRef()/sourceUrlAllowed()`，并把 `storageMode()` 改为服从 `IMG_URL_MODE=local`（最强回滚）；`img_thumbs.cjs` 读侧投影接入 `resolveForRead`（`s3` 模式把存量本地路径改写为 S3 URL，**无需改库即可灰度验证**）；`app.js`/`vendor_api.cjs` 共 20 处写入统一走 `normImg()`；删图可按开关同步清理对象（含 `.t240/.t640.webp`）。新增配置：`IMG_URL_MODE`、`S3_MIGRATE_PREFIX`、`S3_DELETE_ON_PHOTO_DELETE`、`S3_SOURCE_URL_ALLOWLIST`、`IMG_NORMALIZE`。

### S2 执行手册（在有库环境按序执行）

```bash
# 0) 先证明「迁移上传目标」与「切读改写」逐字一致（无需数据库，含真实上传+公网读回+清理）
npm run s3:migrate -- --selftest=3

# 1) 预演：只读，输出待迁清单（按表分类 / 本地缺失文件 / 总体积），不写任何东西
npm run s3:migrate

# 2) 小批实跑（20 条）：上传 + 写库（同时把原值写入 legacy_*）
npm run s3:migrate -- --apply --limit=20
npm run s3:verify -- --sample=20 --allow-local     # 迁移中允许仍有本地路径

# 3) 全量（建议分 3 批，每批后校验）
npm run s3:migrate -- --apply --limit=300
npm run s3:migrate -- --apply --limit=300
npm run s3:migrate -- --apply

# 4) 严格校验（不允许残留本地路径）
npm run s3:verify -- --sample=300
```

**注意事项**
- `--apply` 会写库，但**只对「文件上传成功」的引用改库**；上传失败会中止且不改库（可重跑续传）。
- 上传进度落 `scripts/__fixtures__/s3-migrate-progress.json`，支持断点续跑；重复执行幂等。
- 迁移**不生成缩略图**（决策 5）；存量图只传原图，`makeThumbs` 仅用于新上传。
- 迁移**不删除** `assets/` 任何文件 —— 回滚依赖它们（S4-3 才议删除）。
- 自检/迁移使用**确定性 key**（`legacyKeyOf`），与 `IMG_URL_MODE=s3` 读侧改写严格同源；自检额外用 `__selftest__/` 隔离前缀，绝不触碰生产对象。

**三档模式实测**（`S3_KEY_PREFIX=lvju`）：
```
dual （缺省）: assets/juzhu/sy/city/hero.jpg  → 原样    | storageMode=s3
s3           : assets/juzhu/sy/city/hero.jpg  → https://file.ljcdn.com/test/lvju/legacy/juzhu/sy/city/hero.jpg
local        : assets/juzhu/sy/city/hero.jpg  → 原样    | storageMode=local（强制本地）
```

### S2 · 存量迁移

| ID | 任务 | 改动文件 | 验收标准 | 回滚 |
|---|---|---|---|---|
| S2-1 | `scripts/s3-migrate-images.cjs`（dry-run/幂等/断点/节流/报告） | 新增脚本 | `--dry-run` 输出待迁清单（含 total/missing）；`--limit=1 --apply` 单条成功 | 无副作用（dry-run） |
| S2-2 | `scripts/s3-verify-images.cjs`（5 项校验，见 §3.5） | 新增脚本 | 抽样 100 张全 200；无 `assets/` 残留引用 | — |
| S2-3 | 种子脚本口径同步（新数据走 `normImg`；`dual` 下 no-op） | `housing_seed.cjs`(5 点)、`scripts/spots-seed.cjs`(封面+图集)、`scripts/lvju-stay-seed.cjs`(封面) | 重跑种子在 `s3` 模式产出 URL | revert |
| S2-4 | 回滚列 `legacy_*`（幂等 ALTER，走 `extraCols`） | `app.js` `extraCols` | 列存在且迁移前值已备份 | drop column（可选） |
| S2-5 | 分批执行迁移（建议 3 批：`--limit=300`） | — | 每批后跑 S2-2；报告存档 | 用 `legacy_*` 回写 |
| S2-6 | 迁移报告评审（migrated/missing/failed） | `scripts/s3-migrate-report-*.json` | `missing` 逐条有人认领 | — |

### S3 · 切读（`IMG_URL_MODE=s3`）

| ID | 任务 | 验收标准 | 回滚 |
|---|---|---|---|
| S3-1 | 切 `IMG_URL_MODE=s3`（先切 1 台/1 城市） | 灰度集 C 端坏图数为 0 | 改 env 回 `dual` |
| S3-2 | 监控：`/api/juzhu/img` 5xx 率、file 域 403/404 率、首屏耗时 | 指标在阈值内 | — |
| S3-3 | 全量切读，观察 1–2 周 | 无回滚触发 | 改 env 回 `local` |

### S4 · 收尾

| ID | 任务 | 备注 |
|---|---|---|
| S4-1 | S3 生命周期规则（孤儿清理/归档） | 需 ODS 侧支持 |
| S4-2 | `scripts/s3-orphan-scan.cjs`（对象 vs 引用差集） | 建议每周跑 |
| S4-3 | 删除本地 `assets/`（**仅在双跑 2 周无回滚后**） | 需先备份 |
| S4-4 | 文档收口（更新 `docs/s3-image-storage.md` §5 集成表） | — |
| S4-5 | （可选）统一新旧缩略图策略：`make_thumbs:false` 或补 `photos.thumb_*` + 存量回填 | 决策 5 的后续增强 |

---

## 6. 回滚手册

| 阶段 | 回滚动作 | 数据影响 |
|---|---|---|
| S0 | `git revert` 对应 commit | 无 |
| S1 | `IMG_URL_MODE=local` + 重启 | 新上传的 S3 URL 仍可读，不影响展示 |
| S2（迁移中/后） | ① `UPDATE ... SET cover_image=legacy_cover_image`（7 张表）② `photos.file_path=legacy_file_path` ③ `IMG_URL_MODE=local` | 因**未删本地文件**，可完整回退 |
| S3 | `IMG_URL_MODE=dual` 或 `local` + 重启 | 秒级生效 |
| S4-3 之后 | **不可回滚**（本地文件已删） | 必须先备份到冷存储 |

---

## 7. 验收指标

| 指标 | 目标 |
|---|---|
| C 端坏图率（`img` 加载失败 / 总图片请求） | 0 |
| 图片接口 5xx 率 | ≤ 0.1% |
| `/api/juzhu/img` 代理请求量 | 趋近 0（生产走 CDN 直读） |
| 首屏图片总字节 | 不高于改造前（依赖新图缩略图；存量图为已知退化项） |
| 商家回调失败（webhook） | 无新增失败 |

---

## 8. 未决 / 后续增强

1. **存量缩略图**（决策 5 缓做）：回填 `.t240/.t640.webp` + `photos.thumb_*` 列，去掉 `remoteThumb` 的 HEAD 探测。
2. **`spots.photos` 是否纳入迁移**：本文默认纳入（避免混链），如要严格按"只迁封面"需显式 `--no-spot-gallery`。
3. **中文 key 兼容性**：若 ODS 网关对 UTF-8 key 有问题，启用 `--ascii-key`（`md5(原名)+ext`）。
4. **私有读 + 签名 URL**：若后续要求不公开，需加签名层（与决策 2 冲突，属重新评审项）。
5. **虚拟主机寻址**：`S3_ADDRESSING=virtual` 待网关放开（见 `docs/s3-image-storage.md` §7）。

---

## 附：任务总览

```
S0 契约修复 ──► S1 双写(灰度 rental 1 周) ──► S2 存量迁移(3 批) ──► S3 切读(观察 1-2 周) ──► S4 收尾
 5 项            8 项                          6 项                3 项                  6 项
 可独立上线      可一键回滚                    可完整回滚          秒级回滚              不可逆(需备份)
```

**合计 28 项**（S0-1…S0-5 / S1-1…S1-8 / S2-1…S2-6 / S3-1…S3-3 / S4-1…S4-6）。
