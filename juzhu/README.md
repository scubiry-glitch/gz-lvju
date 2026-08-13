# 新居住频道 · 数据层

## 快速开始

```bash
# 1. 确保源目录存在
#    /Users/scubiry/Downloads/东博项目/新居住专区

# 2. 扫描入库 + 复制图片 + 导出 JSON
python3 juzhu/seed_from_folder.py

# 3. （可选）话务虚拟号密钥
cp juzhu/.env.example juzhu/.env.local   # 填入 TP_APP_ID / TP_APP_KEY
# TP_BASE 默认测试 http://tp-test.lianjia.com；线上改为 http://i.tp.lianjia.com

# 4. 启动服务（含编辑后台 API，推荐；自动加载 .env.local）
python3 juzhu/server.py
# 前台 http://localhost:8765/index.html
# 后台 http://localhost:8765/juzhu-admin.html
```

## 静态安全（必读）

`server.py` 以仓库根为静态根，但会拦截敏感路径：`.env*`、`*.py`、`*.db`/`*.sqlite`、`*.sql`、`*.ini`、`config.ini`、`api_doc.md`、`hmac_secret.key`、`package.json`、`README.md`、根目录 `app.js` / `scf_bootstrap` / `moma_*` 等；`/juzhu/` 仅白名单 `app.js` / `cities.json` / `data.json` / `data-*.json`；禁止目录列表。

线上入口是 Node `app.js`（SCF）+ 可选 Python API：`app.js` 的 `isPublicStatic` 与上述口径一致。部署包内的运行时 `.env` **仅供进程读取**，不得通过 HTTP 访问。

生产务必：

```bash
export JUZHU_ENV=production
export JUZHU_API_KEY='<生产密钥>'
export JUZHU_ADMIN_PASSWORD='<生产密码>'
```

微信 URL Link：`cp juzhu/config.ini.example juzhu/config.ini`（已 gitignore，勿提交真实 token）。

## 产出物

| 文件 | 说明 |
|------|------|
| `juzhu.db` | SQLite（本地，gitignore） |
| `data.json` | 前端静态数据源（可提交） |
| `assets/juzhu/sy/` | 图片资源（随仓库同步） |

## 信息结构

见 `docs/juzhu-info-architecture.md`

```
保租房：区 → 项目 → 户型 → 图集
卖旧买新：项目 → 户型 → 图集
```

## 页面

- `index.html` — 频道首页（方案 C）
- `juzhu-bzf-list.html` — 区级项目列表
- `juzhu-bzf-project.html` — 项目户型列表
- `juzhu-unit-detail.html` — 户型详情
- `juzhu-admin.html` — **内容编辑后台**（需 `python3 juzhu/server.py`）

## 编辑后台

| 能力 | 说明 |
|------|------|
| 项目 | 改名称、地址、标签、封面路径、起价/起租、排序；**新建 / 删除** |
| 房源 | 改名称、面积、户型、月租/总价、排序；新增/删除 |
| 同步 | 每次保存自动写 SQLite + 重导 `data.json` |

## 好房子评级复核（连 p-rating-review）

| 步骤 | 页面 / API |
|------|------------|
| 1 运营自评 | `juzhu-admin.html` → 保租项目 → **好房子评级** 卡片 → 保存自评 |
| 2 提交复核 | 同页 **提交复核** → `POST /api/juzhu/admin/projects/{id}/rating/submit` |
| 3 中台队列 | `screens/p-rating-review.html` 顶部「新居住保租房」表 ← `GET /api/juzhu/ratings?status=pending` |
| 4 复核详情 | `screens/p-rating-detail.html?id=SY-BZF-00008` → 通过/驳回 → `POST /api/juzhu/admin/ratings/{code}/review` |
| 5 前台展示 | `juzhu-unit-detail.html` 仅 `rating_status=passed` 时展示库内正式星级 |

编号规则：`SY-BZF-` + 项目 id 五位补零（如项目 8 → `SY-BZF-00008`）。

API：`/api/juzhu/admin/projects`、`/units/{id}`、`POST /export`、`/api/juzhu/ratings`
