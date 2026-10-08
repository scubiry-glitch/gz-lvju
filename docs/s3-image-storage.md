# 房源图片对象存储（贝壳 ODS / S3 兼容）接入说明

> 规范来源：贝壳 S3 接入文档 <http://wiki.lianjia.com/pages/viewpage.action?pageId=480002458>（内网需 SSO，代码按 **AWS S3 兼容 + 实测校准** 实现，配置项可切换以对齐文档口径）。
> 实现：`s3_client.cjs`（协议/签名）、`img_storage.cjs`（业务层）、`img_thumbs.cjs`（缩略图改写）、`app.js`（HTTP 入口）、`vendor_api.cjs`（商家开放接口）。
> 自检脚本：`node scripts/s3_smoke.cjs`（`npm run s3:smoke`）。

---

## 1. 实测结论（2026-09-21，测试环境）

| 项 | 结论 |
|---|---|
| endpoint | `https://ods.lianjia.com`（可达，`server: Lianjia`） |
| file-endpoint | `https://file.ljcdn.com` |
| bucket | `test` |
| **签名版本** | **V4（AWS4-HMAC-SHA256）已跑通**（按接入规范采用，缺省）；V2 亦可作为兼容开关保留 |
| region | V4 必需参数，但**本环境不参与校验**（`us-east-1` / `cn-north-1` / `ods` / 任意值均通过）；取标准默认 `us-east-1` |
| 寻址（API） | **path-style 可用**：`https://ods.lianjia.com/test/<key>`<br>**virtual-style 本网络不可达**：`test.ods.lianjia.com` 可解析（30.128.0.170，与 `ods.lianjia.com` 的 30.128.0.24 不同）但 80 空响应、443 握手 `SSL_ERROR_SYSCALL` → 暂用 path，开关已就绪 |
| **读图 URL** | **必须带 bucket**：`https://file.ljcdn.com/test/<key>` ✅<br>不带 bucket → `403 {"code":"CommandNotMatch","message":"指令不匹配: 未申请对应服务: bucket: <首段>"}` ❌ |
| key 前缀 | 按接入规范使用 `lvju/`（配置项 `S3_KEY_PREFIX`） |
| 额外请求头 | 规范要求携带；`{"x-amz-acl":"public-read"}` 实测被接受（PUT 200 + 回读一致），参与签名 |
| 写能力 | `PUT` / `GET` / `HEAD` / `DELETE` 均正常；`PUT` 返回 `ETag` |
| 列桶 | `GET /test/` → `403 AccessDenied`（业务账号无 ListBucket，属正常，勿用于探测） |
| 预签名 | V4 / V2 query 预签名 PUT 均投递成功（可用于前端直传） |
| 大对象 | 分片上传（`?uploads` / `?partNumber=&uploadId=`）已实现，>16MB 自动切换 |

> 对应配置：`S3_SIGN_VERSION=v4`、`S3_REGION=us-east-1`、`S3_ADDRESSING=path`、`S3_FILE_STYLE=bucket`、`S3_KEY_PREFIX=lvju`、`S3_EXTRA_HEADERS={"x-amz-acl":"public-read"}`。

### 1.1 V4 实现要点（排查记录，改动勿回退）

首次接 V4 时全部 `403 AccessDenied`，一度误判为「服务端不支持 V4」。根因是**客户端签名实现违反 SigV4 规范**，修好后即通过：

1. **`host` 必须参与签名**（缺了必然 403）；
2. **canonical URI 必须是 URL 实际路径**：virtual 寻址是 `/<key>`，path 寻址是 `/<bucket>/<key>`（早期两者混用，path 风格下会签错）；
3. `content-length` **不签**（由运行时按 body 生成，签了会与实际发送值不一致）；
4. 诊断手段：`PUT` 返回 200 但 `ETag = d41d8cd98f00b204e9800998ecf8427e`（空串 MD5）＝ 客户端没发 body；
5. 探测 region/寻址请用**对象级 PUT 探针**（`scripts/s3_region_probe.cjs`），不要用桶级 `HEAD/GET`（无 ListBucket 权限会 403，误导判断）。

---

## 2. 配置

写入 **仓库根 `.env`**（app.js 运行时读取，已 gitignore）或平台环境变量；脚本侧读 `juzhu/.env.local`。模板见 `juzhu/.env.example`。

| 变量 | 说明 | 测试环境值 |
|---|---|---|
| `S3_ACCESS_KEY` | 访问密钥 | 平台下发（`LV56…`） |
| `S3_SECRET_KEY` | 密钥（等同密码，禁止进前端/仓库） | 平台下发 |
| `S3_ENDPOINT` | ODS API 域 | `https://ods.lianjia.com` |
| `S3_FILE_ENDPOINT` | 文件/读图域 | `https://file.ljcdn.com` |
| `S3_BUCKET` | 桶名 | `test` |
| `S3_SIGN_VERSION` | `v4`（缺省，规范要求）/ `v2`（兼容保留） | `v4` |
| `S3_REGION` | V4 必填（本环境不校验，填标准值即可） | `us-east-1` |
| `S3_ADDRESSING` | `path`（缺省，实测可用）/ `virtual`（本网络端口不通） | `path` |
| `S3_FILE_STYLE` | `bucket`（缺省，读图带桶名）/ `path` | `bucket` |
| `S3_KEY_PREFIX` | key 前缀（规范使用 `lvju`） | `lvju` |
| `S3_EXTRA_HEADERS` | 额外请求头 JSON（参与签名） | `{"x-amz-acl":"public-read"}` |
| `S3_MAX_BYTES` | 单图上限 | `12582912`（12MB） |
| `S3_THUMB_REWRITE` | C 端是否改写为 `.t240/.t640.webp` | `1` |
| `S3_TIMEOUT_MS` | 单请求超时 | `20000` |

**未配置时自动回落本地 `assets/uploads/`**，业务不中断（响应里带 `storage:'local'` 与 `warned` 原因）。

---

## 3. 上传

### 3.1 后台/平台侧（admin 域，权限点 `house.write`）

```bash
# base64 / data_url / source_url 三选一；可直接带归属实体并落 photos 表
curl -X POST http://127.0.0.1:8766/api/juzhu/admin/photos/upload \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"source_url":"https://vendor-cdn.example.com/a.jpg","project_id":1611,"is_cover":true}'
```

- 请求体：`base64` | `data_url` | `source_url`（远程镜像）＋ `filename` / `content_type`
- 归属：`unit_id` / `project_id` / `spot_id` / `district_id`，或 `entity_type`+`entity_id`
- `save:false` = 只上传不落库；`is_cover:true` = 置封面（同时回写 `projects.cover_image`）
- `make_thumbs:false` = 不生成缩略图
- 兼容别名：`POST /api/juzhu/admin/upload`（同 handler，历史提示引用过该路径）
- **multipart 通道**（前端历史调用方式）：`Content-Type: multipart/form-data` + `file` 字段 + `scope`，支持 7 种 scope（对齐 `juzhu/server.py:2424`）：`project_cover` / `project_cover_new` / `unit_cover` / `unit_gallery` / `unit_photo` / `unit_keeper` / `city_hero`。响应仍含 `file_path`（前端零改动）。
  - `unit_photo` 换图：若既有引用已是对象存储，则**复用同一 key 覆盖**（零孤儿对象、零改库）；否则上传后 `UPDATE photos.file_path` 并同步 `units.cover_image`
  - `city_hero` 回写 `cities.hero_bg_image`；`project_cover` / `unit_*` 会校验归属实体存在（不存在 → 404）
- 返回：`{ ok, upload:{storage,url,key,thumb_240,thumb_640,bytes,content_type}, photo, elapsed_ms }`；multipart 额外含 `scope` / `entity_type` / `entity_id` / `file_path` / `saved`

**新增房源图片专用入口**：`POST /api/juzhu/admin/units/{id}/photos`（权限 `house.write` / `unit.photo.add`）

```bash
# ① multipart 直传（批量时前端并发上限 3）
curl -X POST http://127.0.0.1:8766/api/juzhu/admin/units/3101/photos \
  -H "Authorization: Bearer <token>" -F 'file=@a.jpg'

# ② 引用入库（形态归一 + 可选镜像）
curl -X POST .../api/juzhu/admin/units/3101/photos \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"file_path":"lvju/housing/unit/3101/2026/09/xxx.jpg","is_cover":true}'
```
返回 `201 { ok, storage, file_path, thumb_240, thumb_640, upload, photo }`。

### 3.2 前端直传（预签名，大图/批量推荐）

```bash
# 1) 取预签名 PUT URL
curl -X POST .../api/juzhu/admin/photos/presign -d '{"project_id":1611,"ext":"jpg"}'
# → { url, key, public_url, content_type, expires, method:'PUT', version:'v2' }

# 2) 前端直接 PUT（需带 Content-Type），无需经过服务端
# 3) 把 public_url 交给 /photos/add 或 /photos/upload?save=false 落库
```

### 3.3 商家开放接口（HMAC，`/api/juzhu/housing/vendor/*`）

```bash
POST /api/juzhu/housing/vendor/photos/upload
{ "vendor_id":153, "project_id":1611, "unit_id":3101, "source_url":"https://...", "is_cover":true, "timestamp":..., "sign":"..." }
```

- 与既有 `photos/add` 并列；owner 校验（非本商家房源 → 404 不泄露存在性）
- 返回 `{ code:0, storage, file_path, thumb_240, thumb_640, photo }`
- 上架前置闸不变：仍要求 **≥8 张照片 + 有封面**（`MIN_PUBLISH_PHOTOS`）
- **商家通道全部为 JSON**（无 multipart）；新增房源 `projects/create` 与 `photos/add` 的 `cover_image` / `file_path` 同样经 `ingestRef` 收口（第三方 URL 是否镜像由 `IMG_INGEST` 决定，镜像需过 `S3_SOURCE_URL_ALLOWLIST`）

### 3.4 对象 key 规则

```
< S3_KEY_PREFIX >/housing/<entityType>/<entityId>/<yyyy>/<MM>/<uuid32>.<ext>
例：test 桶 → lvju/housing/project/1611/2026/09/19f6d22af9364447afaa7d65d5e18942.jpg
读图 URL       → https://file.ljcdn.com/test/lvju/housing/project/1611/2026/09/19f6d2….jpg
缩略图（同目录）→ <同名>.t240.webp / .t640.webp
```

处理链：格式白名单（jpg/jpeg/png/webp）→ 体积上限 → **sharp 归一化**（自动纠正方向、限宽 2560、统一输出 JPEG、webp 保持原样、已是达标 JPEG 不重编码）→ 上传原图 + 两档 WebP 缩略图。`Content-Type` 与实际编码始终一致。

---

## 4. 读取

| 方式 | 说明 |
|---|---|
| **公网直读（推荐）** | `https://file.ljcdn.com/test/<key>`，由 CDN/文件域直出，服务端零流量 |
| **代理读取** | `GET /api/juzhu/img?p=<本地路径\|s3://key\|裸key\|URL>`（公网可读，`Cache-Control: 86400`，**不依赖数据库**）；未配置 S3 时同样可读本地 `assets/` |
| 服务端二次处理 | `img_storage.readImage(p)` → Buffer（迁移/水印/审核用） |

### 缩略图（与本地同约定）

- 上传时同时写入 `.t240.webp` / `.t640.webp`，**上传即通过**，C 端首次渲染就命中。
- `img_thumbs.mapThumbsDeep()` / `thumbOf()` 对 S3/CDN 直链做改写：先 HEAD 校验存在（进程内缓存 6h），命中才改写，**不会产生 404**（与本地「本次回退、下次命中」一致）。
- 关闭：`S3_THUMB_REWRITE=0`。

---

## 5. 与现有系统的集成（零 schema 变更）

| 集成点 | 做法 |
|---|---|
| `photos.file_path` / `*.cover_image` | 仍存「可直接放进 `<img src>` 的字符串」：本地 `/assets/...` 原样，S3 存 `https://file.ljcdn.com/test/<key>`。**历史数据零迁移** |
| 兼容入参 | `file_path` / `cover_image` 也接受 `s3://<key>` 与本域裸 key，写入时统一归一化为本域公网 URL（`img_storage.normalizeImageRef`） |
| `img_thumbs.cjs` | 本地逻辑不变，新增 S3 分支；无 sharp/无 S3 时自动退化 |
| 静态服务 | 不改；`assets/` 继续由 `isPublicStatic` 提供，S3 图片走 file 域或 `/api/juzhu/img` |
| 商家上架闸 | 不变（8 图 + 封面 + 评级通过）；封面判定改用 `isValidImageRef`，`-`/`todo` 等脏值不再算封面 |
| 权限/审计 | 新路由已登记 `perm_registry.ROUTES`：`photos/upload`、`admin/upload`、`photos/presign` = `house.write`；`storage/status` = `admin.read`。写操作自动落 `audit_log` |
| 打包 | `package_backend.sh` 用 `*.cjs` 通配，新模块自动进包；**注意 `assets/` 不入包** → 生产必须配 S3（见 §5.2） |
| 自检 | `npm run s3:smoke`（连通性 + 签名探测 + 上传/读回/缩略图/预签名/清理） |
| 环境探测 | `npm run s3:probe`（region × 寻址 × 签名版本矩阵，定位 403 根因；支持 `--regions=` / `--addressings=` / `--versions=`） |
| 运维 | `GET /api/juzhu/admin/storage/status?probe=1` 返回模式、bucket、签名版本、采样 URL、**新增开关回显**（`img_url_mode` / `write_mode` / `img_ingest` / `img_normalize` / `fail_on_unconfigured` / `migrate_prefix` / `source_url_allowlist` / `sharp`） |

### 5.1 写入收口：`ingestRef` / `normalizeImageRef`

所有图片写入点（`新增房源` / `新增房源图片` / 通用上传 / 封面更新 / 商家开放接口）统一经 `img_storage.ingestRef()`：

| 入参形态 | 归一化结果 | 是否触网 |
|---|---|---|
| 本地路径（带/不带前导 `/`，必须 `assets/` 下且无 `..`） | `/assets/...` | 否 |
| 本域对象存储 URL / `s3://<key>` / 本域裸 key | `https://<file-endpoint>/<bucket>/<key>` | 否 |
| `data:` / `blob:` | 原样（内联） | 否 |
| 第三方 `http(s)://` | **`IMG_INGEST=keep`（缺省）原样保留**；`mirror` 时镜像进对象存储（须过白名单 + SSRF 拦截） | 仅 mirror 时 |
| 脏值（空 / `-` / `todo` / 未知串 / 含 `..` 的路径） | **拒绝**（400，不再静默入库） | 否 |

**错误语义**（不再出现「所有异常统一包装成 DB 查询失败」）：`415` 媒体类型不支持 · `413` 请求体超限 · `400` 引用非法/字段缺失 · `404` 归属实体不存在 · `502` 上游/S3 失败 · `500` 落库失败。落库失败时会**补偿删除**刚上传的对象（`compensateUpload`），避免孤儿对象（若 `photos` 行未落而对象保留，上架闸会因「图片数不足」卡死）。

### 5.2 生产必须 fail-closed

后端发行包 **不含 `assets/`**（`package_backend.sh:8`），且 SCF/容器无持久盘 —— 「S3 未配置自动回落本地」在生产等于**写下不可服务、随实例销毁的文件**。故生产应设 `S3_FAIL_ON_UNCONFIGURED=1`：S3 缺失时直接 5xx，而不是静默降级。

### 5.3 灰度与回滚（改环境变量即可，无需发版）

| 开关 | 取值 | 语义 |
|---|---|---|
| `IMG_URL_MODE` | `local` | **最强回滚**：即使 S3 配齐也不写 S3，读侧不改写 → 等价改造前 |
| | `dual`（缺省） | 新上传走 S3；读侧不改写存量本地路径 |
| | `s3` | 新上传走 S3 + **读侧**（`img_thumbs.thumbOf/mapThumbsDeep` → `resolveForRead`）把 `assets/...` 改写为 `S3_MIGRATE_PREFIX` 下的公网 URL → 不改库即可灰度验证切读 |
| `IMG_INGEST` | `keep`（缺省）/ `mirror` | 第三方 URL 原样保留 / 镜像进对象存储 |
| `IMG_NORMALIZE` | `1`（缺省）/ `0` | `0` = 跳过 sharp 重编码（保 PNG 透明） |
| `S3_FAIL_ON_UNCONFIGURED` | `0`（缺省）/ `1` | 生产建议 `1` |
| `S3_MIGRATE_PREFIX` | 缺省 `<S3_KEY_PREFIX>/legacy` | 存量迁移 key 前缀（**必须确定性**，见下） |
| `S3_SOURCE_URL_ALLOWLIST` | 逗号分隔域名 | 镜像来源白名单（含子域；留空 = 不限制） |
| `S3_DELETE_ON_PHOTO_DELETE` | `0`（缺省）/ `1` | 删 `photos` 行时是否同步删对象（缺省关，防误删不可恢复） |

**回滚口径（重要）**：写侧回滚 ≠ 引用回滚。库内一旦写过 S3 绝对 URL，回滚到改造前代码后老前端 `url('/'+p)` 会拼成 `/https://…` 必坏图 ⇒ 固定为「**保留 S3 引用 + 只回滚写侧行为**」，因此**前端 `imgUrl()` 兼容属 P0，必须先上**（`juzhu-admin.html` / `juzhu-admin-unit.html` / `screens/p-rating-detail.html`）。

### 5.4 勿回退的实现约束

1. **存量迁移 key 必须用 `legacyKeyOf()` 的确定性 key**，不能走 `keyFor()`（uuid 随机）→ 否则与读侧改写不一致，切读必然 404。
2. `deleteObjectByRef()` **拒绝对外部 URL 反解 key**（否则 `https://other-cdn/x.jpg` 会被当成 `<bucket>/x.jpg` 删除，可能误删同名对象）；本地引用直接跳过。
3. `readBody()` 是 utf8 拼串，**不能**用于 multipart/二进制；上传必须走 `readRawBody()`（二进制安全 + 硬上限）。multipart 分隔符必须匹配 `\r\n--<boundary>`（带前导 CRLF），否则图片字节里偶然出现的 `--<boundary>` 会被误切。
4. `insertPhotoRow()` 必须事务 + 归属行锁（`SELECT … FOR UPDATE`）：否则并发「设为封面」/批量上传会丢封面唯一性与 `sort_order` 唯一性。
5. 本地路径必须过穿越校验（`assets/` 前缀 + 无 `..`/反斜杠/控制字符；`readImage` 再校验解析后仍在仓库根内）。

---

## 6. 故障排查

| 现象 | 原因 / 处置 |
|---|---|
| `403 AccessDenied`（PUT，V4） | ① **签名串缺 `host`**（SigV4 强制）② canonical URI 用了 `/key` 但实际是 path 寻址（应为 `/bucket/key`）③ region 与服务端不一致 ④ 密钥错误 → 跑 `s3:smoke`；仍不行跑 `s3_region_probe.cjs` 扫 region/寻址 |
| `fetch failed`（virtual 寻址） | `<bucket>.ods.lianjia.com` 域名可解析但端口不通 → 改 `S3_ADDRESSING=path`（当前缺省） |
| 读图 `403 CommandNotMatch … bucket: xxx` | 读图 URL 少了桶名 → `S3_FILE_STYLE=bucket` |
| 读图 404 | key 拼错 / 对象未上传；用 `storage/status` 的 `sample_public_url` 对照 |
| `PUT` 返回 200 但对象 0 字节 | 客户端未真正发送 body（诊断法：看 `ETag` 是否 `d41d8cd9…`＝空串 MD5） |
| 上传成功但无缩略图 | 未安装 `sharp`（可选依赖）→ `npm install` |
| 桶级 `HEAD/GET` 403 | 无 ListBucket 权限，属正常；探测请用对象级 PUT 探针（脚本已如此实现） |
| `400 file_path 非法` | 引用既非本地路径、也非本域 key/URL → 新逻辑**拒绝脏值**；`-` / `todo` / 含 `..` 的路径会被拒 |
| `415 需要 multipart/form-data` | 走了 `/admin/units/:id/photos` 的 multipart 分支但请求不是 multipart；JSON 分支请带 `Content-Type: application/json` |
| `413 请求体超过上限` | 单请求 > 16MB（`MULTIPART_MAX_BYTES`）；批量请拆分或走 `/photos/presign` 直传 |
| 上传后 C 端 404（切读后） | 存量对象未迁移却把 `IMG_URL_MODE` 切到 `s3` → 先跑迁移/存在性校验，或回 `dual` |
| 生产「上传成功但图片打不开」 | 后端包不含 `assets/`，回落本地 = 写进不可服务路径 → 生产设 `S3_FAIL_ON_UNCONFIGURED=1` 并确认 S3 配置 |

---

## 7. 接入规范对齐状态

内网文档（pageId=480002458）需 SSO，工具无法直连；以下按需求方转述的规范口径逐条落地并实测：

| # | 规范要求 | 落地 | 状态 |
|---|---|---|---|
| 1 | 使用 **V4** 签名 | `S3_SIGN_VERSION=v4`（缺省），修好 host/canonical URI 后实测通过 | ✅ |
| 2 | 使用**虚拟主机寻址** | 代码已支持 `S3_ADDRESSING=virtual`；但 `test.ods.lianjia.com` 本网络端口不通（80 空响应 / 443 握手重置）→ **暂用 path**，网关放开后改环境变量即可，无需改码 | ⚠ 待网络放开 |
| 3 | 读图 URL **含 bucket** | `S3_FILE_STYLE=bucket` → `https://file.ljcdn.com/test/<key>`，实测 200 | ✅ |
| 4 | key 前缀 **`/lvju`** | `S3_KEY_PREFIX=lvju` → key 形如 `lvju/housing/project/…` | ✅ |
| 5 | 需携带**额外请求头** | `S3_EXTRA_HEADERS={"x-amz-acl":"public-read"}`（参与签名），实测 PUT 200 + 回读一致 | ✅ |

**待确认（第 2 项）**：若规范强依赖虚拟主机寻址，需要网络/网关侧放开 `*.ods.lianjia.com` 的 80/443（或提供可达的虚拟主机域名），改 `S3_ADDRESSING=virtual` 后跑 `npm run s3:smoke` 即可验证；其余 4 项均已按规范生效。

> 若文档还有其它约定（专用签名、回调、图片处理参数、生命周期规则），把文档内容贴出来即可按此适配。

---

## 8. 安全

- `S3_SECRET_KEY` 只从运行时环境变量 / 根 `.env` / `juzhu/.env.local` 读取，**禁止写入源码、前端、文档**；静态服务已拦截 `.env*` / `runtime.env` / `*.cjs`。
- 生产建议：平台环境变量注入 + 独立 bucket/前缀（`S3_KEY_PREFIX`）+ 定期轮换密钥。
- 图片本身不含 PII；`contact_phone` 仍只在 `projects` 表，不出接口。
- **SSRF**：`IMG_INGEST=mirror` 拉取第三方 URL 前，先过域名白名单（`S3_SOURCE_URL_ALLOWLIST`，含子域）与内网/回环/链路本地地址拦截（`isBlockedHost`：`127.` / `10.` / `172.16-31.` / `192.168.` / `169.254.` / `localhost` / `*.internal` / IPv6 一律拒），并保留 20s 超时。⚠ 当前为字面量层面的拦截；**DNS 解析后的私网地址需由出网侧策略兜底**（如需强保证，应改为解析后校验 IP 或使用固定出口代理）。
- **路径穿越**：本地引用必须是 `assets/` 前缀且无 `..`/反斜杠/控制字符；`readImage` 解析后仍校验落在仓库根内。
- **脏值/危险协议**：`javascript:` / `data:text/html` 之类不再能通过 `file_path` 入库（写入前拒绝）。
- **删除**：`deleteObjectByRef` 只对本域引用生效，外部 URL 一律跳过（防误删同名对象）；`S3_DELETE_ON_PHOTO_DELETE` 缺省关闭（删对象不可恢复）。

---

## 9. 验证分层（排障时先定位在哪一层）

| 层 | 脚本 | 覆盖 | 依赖 | 挂了说明什么 |
|---|---|---|---|---|
| L1 纯函数 | `npm run test:img-ingest` | 开关语义 / 形态归一化 / 迁移 key 确定性 / 切读接线 / SSRF·白名单 / 路径穿越 / 删除防护 | 无（不触网、不连库） | 收口逻辑被改坏 |
| L2 解析与契约 | `npm run test:admin-upload` | multipart 解析（二进制保真、`\r\n--boundary` 边界、超限、缺边界）、`scope` 归属、入口契约静态断言 | 无 | multipart/入口契约被改坏 |
| L3 协议层 | `npm run s3:smoke` | 签名探测 / 上传 / 读回字节一致 / Content-Type / 缩略图 / 公网 / 预签名 / 清理 | 仅 S3 配置（无需 DB / 服务） | **存储或签名配置问题**，不要怀疑业务代码 |
| L3' 环境矩阵 | `npm run s3:probe` | region × 寻址 × 签名版本矩阵（403 根因定位） | 同上 | 同上 |
| L4 HTTP 集成 | `node scripts/admin_upload_e2e.cjs --base=…` | 探针 → 登录 → `storage/status` → multipart 上传（`project_cover_new`）→ 新增房源图片落库 → 公网读取 → 负例 404 → 外部 URL 保留 → 清理 | DB + 管理员账号 | **HTTP 集成问题**（鉴权/路由/落库） |

判定口径：L1/L2 红 = 代码问题；L1/L3 绿但 L4 红 = DB/鉴权/路由问题；L4 绿但浏览器看不到图 = 读图域名或 bucket 读权限问题。

> 冷启动注意：本机/测试环境首启 `ensureSchema`（含种子与 DDL）可能耗时数十秒到数分钟，期间**所有在 `ensureSchema()` 之后的路由都会等待**（`GET /api/juzhu/img?p=` 在它之前，仍可秒回，可用来判断「服务已起但 schema 未就绪」）。
