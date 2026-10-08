# 新增房源 / 新增房源图片 两接口接入 S3 上传 —— 改造范围、风险与实施方案

> 基线：`feature-gz-yex` @ `167b78d 新增S3相关功能改动`（阶段一 S3 接入已合入：`s3_client.cjs` / `img_storage.cjs` / `img_thumbs.cjs` S3 分支 / `app.js` 4 条图片路由 / `vendor_api.cjs` `photos/upload`）。
> 相关文档：`docs/s3-image-storage.md`（接入与排障口径）、`CLAUDE.md` 规则 21（图片单一出口）。
> 本文只做**评估 + 方案**，不含代码改动。

---

## 0. 口径确认（先对齐"两个接口"指什么）

同一句"新增房源 / 新增房源图片"在本仓库存在两套命名，**改造机制 90% 相同、差异集中在入参与鉴权**。本文以 **admin 侧**为主，附录 A 给出商家开放接口变体的差异。

| 说法 | 主口径（admin，本文主体） | 同源变体（vendor，附录 A） | 关键依据 |
|---|---|---|---|
| 新增房源 | `POST /api/juzhu/admin/projects/{id}/units` | `POST /api/juzhu/housing/vendor/projects/create` | `api_doc.md:80` 明写"项目下新增房源"；`juzhu-admin.html:1915` 按钮 `+ 新增房源` → `app.js:3526` |
| 新增房源图片 | `POST /api/juzhu/admin/units/{id}/photos` | `POST /api/juzhu/housing/vendor/photos/add` | `perm_registry.cjs:104` act = `unit.photo.add`；`juzhu-admin.html:614` `uploadUnitPhotos()` → `app.js:3665` |

> 若需求方实际指的是「新建项目 `POST /admin/projects`」而非「新增户型」，其图片字段（`cover_image`）的改造点与本文**完全一致**（见 §2.1 表末两行），仅多一个 `projects` 落库位置。
> **口径未确认前不要施工**——回滚口径、灰度开关名都依赖这个定义（见 C.1）。

---

## 1. 现状：调用链路与数据流

### 1.1 链路 A · 新增房源（`POST /api/juzhu/admin/projects/:id/units`）

```
juzhu-admin.html:2343 addUnit()
  → POST /projects/{id}/units  { name, sort_order }        ← 注意：当前前端根本不传图片
    → app.js:7038  apiReq → handleApiDirect()
      → app.js:2150 assertAdminAuthorized()  （会话/API Key）
      → app.js:2151 assertApiAuthorized()
      → perm_registry.cjs:101  house.write / unit.create      （审计落 audit_log）
      → app.js:3526-3562  handler
          INSERT units(..., cover_image) ← body.cover_image 原样入库（:3549）
          syncProjectUnitCount(pid)
          → 201 { ok, unit }
```

- **图片相关入参只有一个 `cover_image` 字符串**，服务端不做任何解析、校验、上传；`null` 直接入库。
- 前端"上传封面"走的是**另一条链路**：`juzhu-admin-unit.html:426` 把文件 multipart POST 到 `/admin/upload`（`scope=unit_cover`），拿到 `file_path` 后回填输入框，再随 `saveBasic` 提交。

### 1.2 链路 B · 新增房源图片（`POST /api/juzhu/admin/units/:id/photos`）

```
① 批量上传（当前 100% 失败）
   juzhu-admin.html:614 uploadUnitPhotos(unitId, files)   ← 串行 promise 链
     → multipart/form-data  POST /units/{id}/photos
       → app.js:3668-3673  content-type 命中 multipart ⇒ 直接 503
         "Serverless 环境不支持直接上传图片到本机文件系统"

② 填路径新增（可用）
   juzhu-admin.html:2223 .ph_add  → JSON { file_path }
     → app.js:3665-3707
        file_path 原样 INSERT photos（:3693-3696）
        syncUnitCover(uid)（:3699 → app.js:2060，回写 units.cover_image）

③ 换图（当前 100% 失败）
   juzhu-admin.html:2192 .ph_replace → /admin/upload (scope=unit_photo, multipart)
     → app.js:3771-3776  multipart ⇒ 415（JSON-only 分支）
```

### 1.3 已就绪的 S3 能力（阶段一，可直接复用）

| 层 | 位置 | 能力 |
|---|---|---|
| 协议 | `s3_client.cjs` | V4/V2 签名、path/virtual 寻址、`putObject`/`uploadLarge`（>16MB 分片）/`getObjectBuffer`/`headObject`/`deleteObject`/`copyObject`/`presign`/`publicUrl`/`detectSignVersion` |
| 业务 | `img_storage.cjs:235-316` `uploadImage()` | 归一化（sharp，限宽 2560 + 统一 JPEG，webp 原样）→ 原图 + `.t240/.t640.webp` → **S3 失败自动回落本地** |
| 业务 | `img_storage.cjs:320-335` `readImage()` | 本地 fs / S3 GET 统一读取（`GET /api/juzhu/img?p=` 代理，`:2196-2212`） |
| 业务 | `img_storage.cjs:343-351` `migrateLocalToS3()` | 单个本地文件→S3（**用随机 key，不适合做读侧可预测的存量迁移**，见 §3.2） |
| 已接 S3 的写入口 | `app.js:3771-3809`（`/admin/photos/upload`、`/admin/upload`）、`vendor_api.cjs:792-856`（`vendor/photos/upload`） | 入参 `base64` / `data_url` / `source_url`，`save=false` 只上传不落库 |
| 直传 | `app.js:3812-3831`（`/admin/photos/presign`） | 预签名 PUT，前端直传 CDN，服务端零中转 |
| 读侧改写 | `img_thumbs.cjs:29-32,88-118` | S3/CDN 直链按 `.t<size>.webp` 改写，先 HEAD 校验（进程内缓存 6h），**绝不产生 404**；`S3_THUMB_REWRITE=0` 可关 |
| 自检 | `scripts/s3_smoke.cjs` / `s3_region_probe.cjs`（`npm run s3:smoke|probe`） | 协议层连通/签名/上传读回/预签名/清理 |

### 1.4 关键事实（施工前必须知道，逐条有代码依据）

1. **`readBody()` 是 UTF-8 拼串**（`app.js:1931-1945`），**不能用于 multipart/二进制**（会毁图片字节）。需新增二进制安全的 `readRawBody`。
2. **`mapThumbsDeep` 只作用于 C 端接口**（`app.js:4387/4479/4519/4551/4590/4613`），**admin 接口返回原值** → admin 前端必须自己兼容绝对 URL。
3. **admin 前端 18 处 `url('/'+p.replace(/^\//,''))` 遇到 S3 绝对 URL 必坏图**：`juzhu-admin.html`(9) / `juzhu-admin-unit.html`(8) / `screens/p-rating-detail.html`(1)。这是**读侧 P0**，不是可选项。
4. **生产后端发行包排除 `assets/`**（`package_backend.sh:8,29-57`）⇒ 后端容器内不存在 `assets/` 原图；`img_storage` 的"未配置 S3 自动回落本地"在生产**写下的文件既可能随容器销毁、也可能不被前端静态托管服务到**。⇒ 生产必须 **fail-closed**（S3 未配置直接报错），而不是 fail-open。
5. `photos.file_path` 库内以**不带前导斜杠**的相对路径为主（`assets/juzhu/sy/...`），而前端拼 `url('/'+p)`。任何归一化必须 `lstrip('/')` 后再决定形态。
6. 缩略图**两套约定并存**：`img_thumbs` 的 `.t240/.t640.webp`（414 个）+ 历史目录式 `assets/juzhu/sy/thumbs/**`（411 个）。新链路只产前者。
7. `publishEligibility`（`app.js:758-766`、`vendor_api.cjs`）上架闸：**≥8 张图 + 有封面 + 评级 passed**。改造后"图在哪"不影响闸，但**闸统计的是 `photos` 行数**——若镜像失败只存了 URL 而没落 `photos` 行，闸会卡死。**上传成功但落库失败必须回滚对象或明确报错**。
8. `POST /admin/projects/:id/units` 无事务包裹 `units` + `syncProjectUnitCount`，且 vendor `projects/create` 带 `units` **部分成功不回滚**（已知债，见 2026-09-17 记忆）→ 引入"先上传后落库"后**孤儿对象**概率上升。

---

## 2. 改造范围

### 2.1 改动点清单（按文件）

| # | 文件 | 位置 | 改动性质 | 优先级 |
|---|---|---|---|---|
| 1 | `img_storage.cjs` | 新增 `normalizeImageRef()` / `ingestRef()` / `urlMode()` | 新增纯函数（收口） | **P0** |
| 2 | `img_storage.cjs` | `uploadImage()` 增加 `key` 复用参数（幂等重试）、fail-closed 开关 | 改 | **P0** |
| 3 | `app.js` | 新增 `readRawBody(req,maxBytes)` + `parseMultipart(buf,ct)` + `pickImageMultipart()` | 新增工具 | **P0** |
| 4 | `app.js:3665-3707` | `/admin/units/:id/photos`：multipart 直传 → `uploadImage` → 落 `photos` | **改（当前 503）** | **P0** |
| 5 | `app.js:3526-3562` | `/admin/projects/:id/units`：`cover_image` 经 `ingestRef()` | 改 | **P1** |
| 6 | `app.js:3771-3809` | `/admin/upload`（`/admin/photos/upload`）：补 multipart + `scope` 语义，保留 JSON 分支 | 改（当前 multipart 415） | **P0** |
| 7 | `app.js:3345-3428` / `3430-3498` | `POST/PUT /admin/projects` 的 `cover_image` 走 `ingestRef()` | 改 | **P1** |
| 8 | `app.js:3709-3741` | `PUT /admin/photos/:id` 的 `file_path` 走 `ingestRef()`（并处理换图后的孤儿对象） | 改 | **P1** |
| 9 | `app.js:2117-2144` | `insertPhotoRow()`：封面互斥 + `cover_image` 同步放同一事务、加行锁 | 改（并发正确性） | **P1** |
| 10 | `juzhu-admin.html` | 9 处 `url('/'+p…)` → 内联 `imgUrl()`；`uploadUnitPhotos` 改并发上限 | 改 | **P0** |
| 11 | `juzhu-admin-unit.html` | 8 处同上 | 改 | **P0** |
| 12 | `screens/p-rating-detail.html` | 1 处同上 | 改 | **P1** |
| 13 | `perm_registry.cjs` | 若新增路由（如批量上传）→ 必须同步登记 ROUTES | 改 | **P1** |
| 14 | `juzhu/.env.example` + 根 `.env` 说明 | 新增 `IMG_URL_MODE` / `IMG_INGEST` / `S3_SOURCE_URL_ALLOWLIST` / `IMG_NORMALIZE` / `S3_FAIL_ON_UNCONFIGURED` / `S3_DELETE_ON_PHOTO_DELETE` | 改 | **P0** |
| 15 | `docs/s3-image-storage.md` / `CLAUDE.md` 规则 21 | 补双入口口径、开关说明 | 改 | P2 |
| 16 | `package.json` + `scripts/` | 新增 `test:img-ingest`、`test:admin-upload`、`s3_api_e2e.cjs` | 新增 | **P0** |

**不做**（明确排除，防范围蔓延）：`photos.file_path` 的 schema 变更（新增 `thumb_*` 列）、存量 `assets/` 二进制批量迁移、商家开放接口的 `source_url` 强制镜像、前端改成"必须预签名直传"。

### 2.2 目标设计（推荐方案）

**核心：所有图片引用都经过同一个纯函数收口。**

```
入参（任意形态） ──► ingestRef() ──► 受管引用（本地 /assets/... | S3 绝对 URL）
                       │
                       ├─ 形态归一化：lstrip('/') → 判定 kind(local | s3 | external)
                       ├─ local  : 统一为 /assets/...        （存量零改动，dual 下 no-op）
                       ├─ s3     : s3://key / 裸 key / 任意本域 URL → publicUrl(key)
                       └─ external(第三方 http) ──┬─ IMG_INGEST=keep   → 原样保留（缺省，零行为变化）
                                                  ├─ IMG_INGEST=mirror → 白名单内 uploadImage({sourceUrl}) 镜像进 S3
                                                  └─ IMG_INGEST=binary → 仅对 base64/data_url/multipart 生效
```

```js
// img_storage.cjs 新增（签名草案，纯函数优先，便于单测）
function urlMode()            // 'local' | 'dual'(缺省) | 's3'  ← 灰度/回滚主开关
function migratePrefix()      // 缺省 `<S3_KEY_PREFIX>/legacy`
function legacyKeyOf(ref)     // assets/juzhu/sy/x.jpg → lvju/legacy/juzhu/sy/x.jpg  （确定性）
function legacyUrlOf(ref)     // 上述 key 的公网 URL
function normalizeImageRef(p)// 只做形态归一化：返回 { ok, ref, kind, changed, warn }
function resolveForRead(p)    // urlMode=s3 时把 assets/... 改写为 legacyUrlOf(p)
function isValidImageRef(p)   // 排除 'todo'/'-'/空 等脏值（上架封面判定用）
async function ingestRef(p, opts) // normalizeImageRef + 可选 mirror/binary 上传，统一异常语义
```

**契约兼容策略（三个不变）**

| 项 | 约定 |
|---|---|
| 响应形状 | `新增房源` 仍 `201 { ok, unit }`；`新增房源图片` 仍 `201 { ok, photo }`，**新增可选字段** `upload:{storage,url,thumb_240,thumb_640,bytes,warned}` |
| 入参字段 | `cover_image` / `file_path` **语义不变**（仍是可直接进 `<img src>` 的字符串）；新增可选 `upload`（`true` 显式要求上传）、`filename`、`content_type`、`make_thumbs` |
| 存量读写 | `IMG_URL_MODE=dual`（缺省）：**读侧不改写**，存量本地引用原样返回 → 与改造前逐字节等价 |

**多部分解析要点（踩坑，写进实现约束）**

- 分隔符匹配必须是 `\r\n--<boundary>`（带前导 CRLF），否则**图片字节中偶然出现的 `--boundary` 会被误切**。
- 必须按 `Buffer` 处理（`indexOf(Buffer.from(...))`），禁止 `toString('utf8')` 后再切。
- 体积上限：单 part ≤ `S3_MAX_BYTES`（12MB）、总请求 ≤ 4×上限、part 数 ≤ 32；超限直接 413 而不是 OOM。
- `scope` 语义保留（`project_cover / project_cover_new / unit_cover / unit_gallery / unit_photo / unit_keeper / city_hero`），响应保留 `{ ok, file_path, scope }` → **前端零改动**。

---

## 3. 当前存储方式与迁移策略

### 3.1 现状

| 维度 | 现状 |
|---|---|
| 存储位置 | 本地磁盘 `assets/`（417MB / 1673 张，`assets/juzhu` 占 406MB）；新图阶段一起可落 S3 |
| 库内引用 | `photos.file_path`、`projects/units/districts/spots/routes.cover_image`、`cities.hero_bg_image`、`spots.photos`(JSON 数组)、`settings['topic_*']` —— 全部是**字符串**，无 schema 变更 |
| 读取路径 | C 端：file 域 CDN 直读（S3）或 `/api/juzhu/img` 代理；admin：**原值返回，由前端拼 `/`** |
| 缩略图 | 上传时同目录写 `.t240/.t640.webp`；历史另有 `thumbs/` 目录式约定 |

### 3.2 迁移策略（分三档，按需启用）

| 档 | 动作 | 是否本次必做 | 回滚代价 |
|---|---|---|---|
| **M0 语义迁移** | `IMG_URL_MODE=s3` 时**读侧改写**存量 `assets/...` → `legacyUrlOf()`；对象由后台脚本按**确定性 key** 上传。不改库 | 建议（灰度用） | 改环境变量即回滚 |
| **M1 引用迁移** | 脚本采集 7 类列 + 图集 → 上传 → **改库**（先写 `legacy_*` 备份列，再写新 URL）。缺省 dry-run，`--apply` 才动手；失败**中止且不改库** | 可延后 | 需 `legacy_*` 列回填 |
| **M2 清理** | 确认稳定 N 周后删除 `legacy_*` 列与 `assets/` 原图 | **明确排除** | — |

**迁移三条硬约束（勿回退）**

1. **必须用确定性 key**（`legacyKeyOf()`），不能走 `keyFor()`（uuid 随机）—— 否则与读侧改写不一致，切读必然 404。
2. 自检上传走独立隔离前缀（如 `__selftest__/`），否则会"覆盖后删除"已存在对象造成数据丢失。
3. 迁移期**禁止删除 `assets/` 任何文件**（读侧回滚依赖）；迁移不生成缩略图（缩略图缺失时 `img_thumbs` 回退原图，不产生 404）。

---

## 4. S3 接入涉及的模块

| 模块 | 具体改动 | 依赖 |
|---|---|---|
| **文件服务** | 复用 `img_storage.uploadImage()`；新增 `ingestRef()` / `legacyKeyOf()` / `normalizeImageRef()` / `resolveForRead()`；`uploadImage` 增加「显式 key 复用」（幂等重试）与「fail-closed」开关 | `s3_client.cjs` |
| **配置** | 新增 `IMG_URL_MODE`、`IMG_INGEST`、`S3_SOURCE_URL_ALLOWLIST`、`IMG_NORMALIZE`、`S3_FAIL_ON_UNCONFIGURED`、`S3_DELETE_ON_PHOTO_DELETE`、`S3_MIGRATE_PREFIX`；全部写入 `juzhu/.env.example`，并在 `GET /admin/storage/status` 回显 | 环境变量注入 |
| **鉴权** | **`/admin/units/:id/photos` 已在 ROUTES**（`perm_registry.cjs:104` `house.write / unit.photo.add`）→ 无需新增；若新增批量上传路由**必须同步登记 ROUTES**（规则 21）。商家通道走 HMAC（`app.js:2217`），**JSON only** | `perm_registry.cjs` |
| **异常处理** | 统一错误语义：`415` 不支持的媒体类型 / `413` 超限 / `400` 格式非法 / `502` 上游/S3 失败 / `500` 落库失败。**禁止**再出现"外层 catch 统一包装成 `DB 查询失败`"（`app.js:6777` 已知问题，会掩盖真实原因） | `app.js` |
| **前端** | 18 处 `url('/'+p)` → `imgUrl()`（绝对 URL / `data:` / 根路径原样，其余补 `/`）；批量上传并发上限 3；单图失败不阻断整批 | 3 个 HTML |
| **静态服务** | 不改（`assets/` 仍由 `isPublicStatic` 提供） | — |
| **打包** | `*.cjs` 通配已覆盖，无需改；**注意 `assets/` 不入包**（§1.4-4） | `package_backend.sh` |
| **可观测** | `[img]` 前缀结构化日志（`storage/mode/entity/bytes/elapsed_ms/fallback`）+ 回落计数；`storage/status` 已回显 config | — |

---

## 5. 新旧兼容与灰度切换

### 5.1 开关矩阵

| 开关 | 取值 | 语义 | 缺省 |
|---|---|---|---|
| `IMG_URL_MODE` | `local` | **最强回滚**：即使 S3 配齐也不写 S3，读侧不改写 → 等价改造前 | `dual` |
| | `dual` | 新上传走 S3；**读侧不改写**存量本地路径 | |
| | `s3` | 新上传走 S3 + 读侧把 `assets/...` 改写为 `legacyUrlOf()` → **不改库即可灰度验证切读** | |
| `IMG_INGEST` | `keep` | 第三方 URL 原样保留（零行为变化） | `keep` |
| | `mirror` | 白名单内第三方 URL 镜像进 S3 | |
| `IMG_NORMALIZE` | `0/1` | 是否允许 sharp 重编码（**0 = 保 PNG 透明**） | `1` |
| `S3_FAIL_ON_UNCONFIGURED` | `0/1` | 1 = 生产未配置 S3 直接 5xx，不静默落本地 | 生产建议 `1` |
| `S3_DELETE_ON_PHOTO_DELETE` | `0/1` | 删 `photos` 行时同步删对象 | `0`（防误删不可恢复） |

### 5.2 灰度步骤（每步有独立回滚点）

| 步 | 动作 | 观测指标 | 放行条件 |
|---|---|---|---|
| G0 | 上 **P0 读侧兼容**（前端 `imgUrl()`）+ `IMG_URL_MODE=local` | admin 页面图片正常率 | 本地/存量引用渲染无回归 |
| G1 | `IMG_INGEST=keep` 打开两个接口的**形态归一化**（不镜像、不上传） | 接口 4xx/5xx 比例 | 与旧版响应 diff 仅"前导斜杠/形态"差异 |
| G2 | `IMG_URL_MODE=dual` 打开**新上传写 S3**（先内测 1 个 project） | S3 写入成功率、回落本地次数、P95 耗时 | 成功率 ≥99.5%、回落 0、P95 ≤3s/图 |
| G3 | 批量（8~20 图）压测 + 并发同 project 上传 | `sort_order` 冲突率、封面互斥正确性 | 无重复 sort_order、封面唯一 |
| G4 | `IMG_INGEST=mirror` + 白名单开商家镜像 | 镜像成功率/耗时/失败告警 | 失败可回落且不阻断 |
| G5 | 需要时 `IMG_URL_MODE=s3` 灰度切读（先 1 城市/1 频道） | 404 率、CDN 命中率 | 404 = 0 连续 24h |
| G6 | 全量 | — | — |

**回滚**：任一步出问题 → 改 `IMG_URL_MODE=local`（G2-G4）或回 `dual`（G5）→ **不需要发版、不需要改库**。

---

## 6. 回滚预案

### 6.1 三层回滚

| 层 | 手段 | 生效时间 | 前提 |
|---|---|---|---|
| **L1 开关** | `IMG_URL_MODE=local`（写侧停 S3）/ `IMG_INGEST=keep`（停镜像）/ `S3_THUMB_REWRITE=0`（停缩略图改写）/ `S3_DELETE_ON_PHOTO_DELETE=0` | 分钟级（重启或热读 env） | 开关已实现并回显在 `storage/status` |
| **L2 代码** | `git revert <本次commit>` | 一次发版 | **零 schema 变更** ⇒ 可干净回滚 |
| **L3 数据** | 仅在做过 M1 引用迁移时需要：`photos.legacy_file_path` → `file_path`、`projects/units/...legacy_cover_image` → `cover_image`、`spots.legacy_photos`、`settings['topic_<slug>_legacy']` 回填 | 分钟级（SQL） | 迁移脚本**必须**先写 `legacy_*` 再写新值 |

### 6.2 关键回滚风险（**易被忽略**）

> **写侧回滚 ≠ 引用回滚。** 一旦 G2 之后产生过 S3 引用（库内已有 `https://file.ljcdn.com/...`），**回滚到改造前代码后，老代码会把绝对 URL 当成"本地相对路径"处理，admin 前端 `url('/'+p)` 会拼成 `/https://…` 必坏图**。
>
> 因此回滚口径固定为：**「保留 S3 引用 + 只回滚写侧行为」**，而不是把引用改回本地。
> 该口径成立的前提是 **§2.1 的第 10/11 项（前端 `imgUrl()`）必须先上**——它使前端对新老两种引用都安全，是**回滚友好性的前置条件**，属 P0 而非可选项。
> 对象侧无需清理：S3 对象保留不影响旧逻辑；仅需保证 `S3_DELETE_ON_PHOTO_DELETE=0`（避免回滚后误删）。

---

## 7. 风险清单

| # | 类别 | 风险 | 等级 | 缓解 |
|---|---|---|---|---|
| R1 | 一致性 | **生产后端包不含 `assets/`（`package_backend.sh:8`）** → "S3 未配置回落本地"在生产写下的文件不可服务且随容器销毁 = **静默丢图** | 🔴 高 | 生产 `S3_FAIL_ON_UNCONFIGURED=1`（fail-closed）；启动自检告警；把"回落本地"限制在非生产 |
| R2 | 兼容 | admin 前端 18 处 `url('/'+p)` 遇绝对 URL 坏图 | 🔴 高 | P0 先上 `imgUrl()`（同时是回滚前置，§6.2） |
| R3 | 一致性 | `cover_image` 与 `photos.is_cover` 双写不原子（`app.js:2128-2141`、`syncUnitCover`）→ 并发"设为封面"互相覆盖 | 🔴 高 | 同事务 + `SELECT … FOR UPDATE` 锁 project/unit 行；或改为以 `photos.is_cover` 为唯一事实源、`cover_image` 派生 |
| R4 | 并发 | `sort_order = MAX+1` 在并发批量上传下产生重复（无唯一约束，`:3684-3688`、`:2122-2127`） | 🟠 中 | 行锁内取号，或 `INSERT … SELECT COALESCE(MAX(sort_order)+1,0)` 单语句 |
| R5 | 性能 | 单图 = 1×PUT + 2×PUT(缩略图) 三次外网 RTT；`uploadUnitPhotos` 目前**串行**（`juzhu-admin.html:614-624`）→ 20 图可能 >20s，触发网关超时 | 🟠 中 | 并发上限 3；批量接口限图数；优先引导 `/photos/presign` 前端直传；`make_thumbs=false` 可选 |
| R6 | 可用性 | 无重试 + `S3_TIMEOUT_MS=20000` → 抖动即回落本地，产生"同批一半 S3 一半本地"混合引用 | 🟠 中 | 有限重试（≤2），重试必须**复用同一 key**（否则产生重复对象） |
| R7 | 数据一致性 | `photos` 行落库失败但对象已上传 → 孤儿对象；`projects/create` 带 `units` 无事务（已知债）→ 项目回滚后图成孤儿 | 🟠 中 | 失败补偿删除（`deleteObject`）；或落库成功后才算成功、失败返回对象 URL 供重试；对账脚本（注意业务账号**无 ListBucket**，只能按库反查） |
| R8 | 安全 | `source_url` 镜像 → SSRF（内网 IP、`169.254.169.254`、`file://`、重定向跳内网）、超大响应体 | 🔴 高 | 仅 `http(s)`；域名白名单（`S3_SOURCE_URL_ALLOWLIST`，含子域）；DNS 解析后禁私网网段；`redirect: 'manual'`；响应体积上限；超时 |
| R9 | 安全 | `file_path` 直接入库 → 前端 `url()` 渲染，`javascript:`/`data:text/html` 可 XSS | 🟠 中 | 入库前校验：仅允许 `/assets/`、本域 S3 URL、白名单域 http(s)；长度 ≤500（现有） |
| R10 | 安全/容量 | multipart 无上限 → OOM | 🟠 中 | `readRawBody` 硬上限 + 边读边计数即断；413 返回 |
| R11 | 成本 | 存储 3×（原图 + 2 档缩略图）；CDN 出网流量；`IMG_NORMALIZE` 后 JPEG 重编码带来的一次性 CPU（sharp 在 Node 主进程会阻塞，长图集需注意） | 🟠 中 | 缩略图可关；`sharp` 放 worker 或限制并发；与 ODS 侧确认生命周期/计费口径 |
| R12 | 依赖 | `sharp` 为可选依赖，缺失则跳过归一化与缩略图（静默退化） | 🟡 低 | 启动日志 + `storage/status` 回显 `sharp` 可用性 |
| R13 | 一致性 | `IMG_URL_MODE=s3` 时读侧改写**未迁移**的引用 → 404 | 🟠 中 | 切读前跑引用完整性校验；`normalizeImageRef` 对未迁移引用可探测存在性（HEAD）后决定是否改写 |
| R14 | 运维 | 业务账号无 `ListBucket` → 无法枚举/清理孤儿对象 | 🟡 低 | 以库为事实源做反查；必要时用带权限账号单独跑清理 |
| R15 | 审计 | 上传走 `house.write` 已自动落 `audit_log`；但商家 HMAC 通道无权限点校验（仅 owner 校验） | 🟡 低 | 保持现状（与既有口径一致），在文档中明确 |

---

## 8. 改动点优先级与依赖

```
P0（可独立先上，互不阻塞）                    依赖
├─ A1 img_storage: urlMode/normalizeImageRef/legacyKeyOf/isValidImageRef   —
├─ A2 app.js: readRawBody + parseMultipart + pickImageMultipart            —
├─ A3 app.js: /admin/units/:id/photos 支持 multipart 直传（修 503）        A2 → A1
├─ A4 app.js: /admin/upload 补 multipart + scope（修 415）                 A2 → A1
├─ A5 前端 imgUrl()（3 文件 18 处）                                        — ← 回滚前置
└─ A6 配置项 + .env.example + storage/status 回显                          —

P1（依赖 A1/A3/A4 落地）                     依赖
├─ B1 units/projects create·update 的 cover_image 经 ingestRef            A1
├─ B2 PUT /admin/photos/:id 的 file_path 经 ingestRef（换图孤儿处理）       A1, A3
├─ B3 insertPhotoRow 事务化 + 行锁（R3/R4）                                A3
├─ B4 失败补偿删除 + 有限重试（R6/R7）                                     A3
└─ B5 perm_registry 新增路由登记（若有）                                   —

P2（灰度阶段）
├─ C1 IMG_INGEST=mirror + SSRF 防护（R8）                                  B1
├─ C2 存量确定性迁移脚本（dry-run 缺省）+ legacy_* 列                     B3
└─ C3 IMG_URL_MODE=s3 切读 + 引用完整性校验（R13）                         C2
```

**关键路径**：`A2 → A3/A4 → B3 → C2 → C3`。**A5（前端）必须早于 G2 灰度**，否则回滚口径不成立。

---

## 9. 测试范围

| 层 | 内容 | 方式 |
|---|---|---|
| 单元（纯函数，无需 DB/S3） | `normalizeImageRef`：本地带/不带前导斜杠、`s3://key`、裸 key、本域 URL（path/bucket 两种读图域）、第三方 URL、脏值（`''`/`'-'`/`'todo'`/超长）、`legacyKeyOf` 确定性、`resolveForRead` 三种 mode | `npm run test:img-mode`（新增） |
| 单元 | `parseMultipart`：单 part / 多 part / 边界字节里出现 `--boundary` / CRLF 变体 / 无 filename / 乱序字段 / 超限截断 | `npm run test:admin-upload`（新增，13+ 用例） |
| 契约回归 | `/admin/upload` 7 种 scope：JSON(base64/data_url/source_url) 与 multipart 双通道；响应 `file_path` 字段名不变 | 同上（DB 依赖项 SKIP） |
| 协议层 | 签名探测 / 上传 / 读回字节一致 / Content-Type / 缩略图 / 预签名 / 清理 | `npm run s3:smoke` |
| region/寻址矩阵 | 403 根因定位 | `npm run s3:probe` |
| HTTP 集成 | 服务探针 → 登录 → `storage/status` → 上传（`save=false`）→ 代理读取 → 公网读取 → 预签名直传 → 清理；`--project=<id>` 验落库 | `scripts/s3_api_e2e.cjs`（新增，`npm run s3:e2e`） |
| 业务 E2E | 新增房源 → 新增图片（multipart 8 张）→ 上架闸通过 → C 端可见（≤15s 缓存）→ 下架；商家 HMAC 全链路 | `scripts/housing_vendor_hmac_regression.cjs` + 新增 admin 版 |
| 并发 | 同 unit 并发 10 图：`sort_order` 唯一、封面唯一、无重复行 | 新增压测脚本 |
| 降级 | 断开 S3（错误 key）：`S3_FAIL_ON_UNCONFIGURED=1` 应 5xx；`=0` 应回落并带 `warned` | 手工 + 脚本 |
| 前端兼容 | 本地 `/assets/x.jpg`、`assets/x.jpg`、S3 绝对 URL、`data:`、第三方 URL 五种引用渲染 | admin 页面手工 + 截图 |
| 既有回归 | `test_housing_catalog.js` / `test_index_boot.js` / `test_static_guard.js` / `scripts/perm_gate_regression.cjs` | 全绿门槛 |

---

## 10. 上线验证标准（DoD）

**功能**
1. `新增房源图片` 三个入口（批量 multipart / 填路径 JSON / 换图）**全部可用**，均返回 201 且 `photo.file_path` 可直接进 `<img src>`。
2. `新增房源`（含 `cover_image`）落库值**形态归一**：本地统一 `/assets/...`（`lstrip('/')` 后再补），S3 统一 `https://<file-endpoint>/<bucket>/<key>`。
3. 8 张图 + 封面 → 上架闸 `publishEligibility` 通过；C 端列表/详情能看到图（缩略图改写命中，无 404）。
4. admin 页面（列表/详情/户型页/评级页）在图引用为 S3 绝对 URL 时**渲染正常**。

**非功能**
5. 单图上传 P95 ≤ 3s（≤2MB，含 2 档缩略图）；批量 8 图 P95 ≤ 20s 或明确引导预签名直传。
6. S3 写入成功率 ≥ 99.5%；回落本地次数 = **0**；孤儿对象数 = 0（对账脚本核对）。
7. `GET /admin/storage/status` 回显全部新增开关与 `sharp` 可用性；`probe=1` 通过。
8. 日志中 `[img]` 结构化字段完整（`mode/storage/entity/bytes/elapsed_ms/fallback`），**不再出现被统一包装成"DB 查询失败"的错误**。

**回滚验证（必须演练）**
9. `IMG_URL_MODE=local` 后：新上传落本地、已有 S3 引用仍可正常渲染（前端 `imgUrl()` 生效）；`curl /api/juzhu/img?p=<s3 key>` 仍 200。
10. `git revert` 本次提交后服务可启动，且**不改库**即可恢复既有功能。

**监控告警**
11. 告警项：S3 PUT 失败率 > 1%、回落本地计数 > 0、`/api/juzhu/img` 502 率 > 0.5%、单图耗时 P99 > 10s、`sort_order`/封面唯一性校验异常。

---

## 附录 A · 商家开放接口变体的差异

| 维度 | admin（主口径） | vendor（`housing/vendor/*`） |
|---|---|---|
| 新增房源 | `POST /api/juzhu/admin/projects/{id}/units` | `POST /api/juzhu/housing/vendor/projects/create`（`vendor_api.cjs:549-604`） |
| 新增房源图片 | `POST /api/juzhu/admin/units/{id}/photos` | `POST /api/juzhu/housing/vendor/photos/add`（`vendor_api.cjs:749-773`） |
| 鉴权 | 账号中心 Bearer / API Key + `perm_registry` (`house.write`) | HMAC-SHA256 三件套（`app.js:2217-2230` → `vendorApi.handleRequest`），无权限点，仅 owner 校验（非本商家统一 404 防探测） |
| 传输格式 | JSON **+ multipart（新增）** | **仅 JSON**（`readBody`，`app.js:2219`）→ 不涉及 multipart 改造 |
| 图片入参 | `file_path`（图片）/ `cover_image`（房源） | `file_path`（图片，`:753`）/ `cover_image`（房源，`:589`、`units[].cover_image`） |
| 到 S3 的路径 | `uploadImage({buffer})` 或 `({sourceUrl})` | 同左，但**外部商家 URL 是主场景** → `IMG_INGEST=mirror` 的价值主要在这里 |
| 已有先例 | `/admin/photos/upload`（JSON only） | `/housing/vendor/photos/upload`（`vendor_api.cjs:792-856`，已 S3 化）→ **`photos/add` 应收敛到与它同一条实现路径**，避免两套逻辑 |
| 独有风险 | multipart 解析、OOM、XSS-worthy `file_path` | 无 multipart；但**外部 URL 不可控**（SSRF R8 / 图片体积 / 超时），且商家是第三方 → 建议 `mirror` 缺省**关闭**、白名单显式开启 |
| 附加已知债 | — | `projects/create` 带 `units` **无事务、部分成功不回滚**（2026-09-17 记忆）→ 引入上传后孤儿对象概率上升（R7） |

**统一实现建议**：把"入参 → 受管引用"的逻辑**只写一次**（`img_storage.ingestRef`），admin 与 vendor 两侧仅做各自的鉴权/归属校验与落库，避免像阶段一那样出现 `photos/upload` 与 `photos/add` 两套语义。

---

## 附录 B · 待需求方拍板（施工前必须确认）

| # | 待决项 | 影响 | 建议 |
|---|---|---|---|
| C.1 | "两个接口"究竟是 admin 口径还是 vendor 口径（或两者都要） | 决定改造面与回滚口径 | 两者都要，按 P0→P1 分两批 |
| C.2 | 生产后端包不含 `assets/` 时，"S3 未配置回落本地"是否还有意义 | R1 处置方式 | 生产 `fail-closed`，非生产保留回落 |
| C.3 | 是否允许 sharp 重编码（PNG 透明会丢） | `IMG_NORMALIZE` 缺省值 | 允许（`=1`） |
| C.4 | 是否允许第三方 URL 直接入库（不镜像） | `IMG_INGEST` 缺省值；影响对象存储完整性与排查 | 保留 `keep`（不强制镜像），商家侧按白名单开 `mirror` |
| C.5 | 换图/删图是否同步删旧对象 | 不可恢复删除风险 | 缺省**不删**（`S3_DELETE_ON_PHOTO_DELETE=0`），先观察 |
| C.6 | 存量是否迁（M1）与迁移窗口 | 是否需要 `legacy_*` 列与切读灰度 | 先做 M0 语义迁移验证，M1 延后 |
| C.7 | 单请求图数上限与是否强制预签名直传 | 性能与网关超时 | 批量 ≤20 图；>20 强制预签名 |
| C.8 | 是否需要 `Idempotency-Key`（会引入唯一索引 = 打破零 schema） | R7 缓解力度 | 先不加，用"复用同 key 重试 + 库内 (entity, file_path) 判重"替代 |
