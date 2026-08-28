# 打包说明 · 前端 / 后端发行版本分离

> 本说明是**发行（release）**的单一约定。核心原则一句话：
> **前端服务和后端服务是两个不同的 git 仓库，分别发行；图片等资产不进后端包。**

---

## 1. 两个发行 git 地址

| 发行物 | remote 名 | git 地址 | 说明 |
|---|---|---|:-:|
| **后端发行** | `lianjia-no-assets` | `git@git.lianjia.com:btg-01/sy2-no-assets-20260812.git` | 无资产，仅运行时 + 数据 + 前端静态页 |
| **前端发行** | `lianjia` | `git@git.lianjia.com:btg-01/sy2-full.git` | 全量，含图片资产 / 设计稿 / PDF |

> 另一个 remote `origin`（`github.com:scubiry-glitch/gz-lvju.git`）为历史 GitHub 镜像，不参与发行。

**每次发版前先对齐分支**（见 §4），再按 §3 打包，最后按各自 remote 推送。

---

## 2. 后端发行包（`dist/sy2-backend-<VER>.zip`）

由根目录脚本 [`package_backend.sh`](../package_backend.sh) 生成。

**包含：**

| 类别 | 内容 |
|---|---|
| Node 运行时 | `app.js`、`scf_bootstrap`、`package.json`、`package-lock.json`、`moma_build.sh` / `moma_build_local.sh` / `moma_deploy.js` |
| 后端业务 CJS | `*.cjs`（`jz_seed` / `housing_seed` / `vendor_api` / `hmac_auth` / `gr_orders` / `channel_brand` / `housing_cities` / `migrate_to_mysql` / `juzhu_import` / `prelaunch_cleanup` / `vendor_config`） |
| Python 联调层 | `juzhu/*.py`（`server.py` 等，线上不用、仅本地联调/单测） |
| 后端数据 | `juzhu/data*.json`、`juzhu/cities.json`、`juzhu/*.sql`（schema） |
| 前端静态页 | 根目录 `*.html` / `*.css`、`jiazheng-data.js` / `jsbridgesdk.js` / `jz-datepick.js`、`screens/`（`app.js` 用仓库根做静态根，页面随后端一起发） |
| 依赖 | `vendor/lianjia-jsbridge3-1.1.6.tgz`、`node_modules/`（自包含，部署免 `npm install`） |
| 文档 | `docs/`（deploy / 联调 / 话务规范） |
| 环境模板 | `.env.example`、`juzhu/.env.example`、`juzhu/config.ini.example` |

**排除（图片资产等一律不进包）：**

| 排除项 | 说明 |
|---|---|
| `assets/`（~404MB） | 全部图片资产（juzhu/lvju/scratch 图片） |
| 根目录 `*.png` | 四方共建图谱等大图 |
| `exports/`（~15MB） | PDF 导出件 |
| `*.doc` / `*.docx` / `*.xlsx` | office 标准依据文档 |
| `guizhou-map.json` / `shenyang-map.json` | 地图 geojson（演示地图页数据） |
| `.env` / `.env.local` / `*.env` / `config.ini` | 密钥，仅保留 `.example` 模板 |
| `*.db` / `*.sqlite*` / `*_dump.*` | 本地库与 dump |
| 根目录 `*.md` 文档 | `README` / `CLAUDE` / `api_doc` / 联调手册 / PRD |
| `__pycache__` / `*.pyc` / `.DS_Store` / `node_modules/.cache` `.bin` | 产物 |

---

## 3. 打包步骤

### 3.1 后端发行

```bash
# 在仓库根执行；VER 缺省为当天日期，可显式指定（如 1.2.0）
./package_backend.sh 20260824

# 产物：dist/sy2-backend-20260824.zip
```

校验产物不含资产：

```bash
unzip -l dist/sy2-backend-20260824.zip | grep -iE '\.(png|jpg|jpeg|svg|webp|pdf|docx?|xlsx)' && echo "有资产泄漏!" || echo "OK 无资产"
```

### 3.2 前端发行

前端是**全量静态站**（含图片资产），走 `sy2-full` 仓库，无需 zip——直接推送整个工作树到 `lianjia` 即可（资产本来就该在前端发行里）。

---

## 4. 发版前：对齐 git 分支

> ⚠️ 本地是 partial clone，且部分对象缺失（`git status` 报 `bad tree object HEAD`）。
> **联网环境先补对象 + 对齐，再打包**。

```bash
# 1) 补全缺失对象（partial clone 的 promisor 数据被删后，需重新拉取）
git fetch --all

# 2) 对齐本地分支（示例：cursor 落后 master 时）
git checkout cursor
git merge master            # 或 git rebase master

# 3) 推送后端发行（无资产仓库）
git push lianjia-no-assets cursor:master   # 后端以 master 为发行基线

# 4) 推送前端发行（全量仓库）
git push lianjia master
```

> 分支角色：`cursor` 为日常开发分支，`master` 为发行基线。推送目标按上表对应 remote，切勿把前端推去 `no-assets`、把后端推去 `full`。

---

## 5. 版本号约定

- 后端包文件名：`sy2-backend-<VER>.zip`；`VER` 默认 `YYYYMMDD`，正式版建议用语义化 `x.y.z`。
- 前端发行不产 zip，以 git tag 记版本（如 `frontend-v1.2.0`）。

---

## 6. 铁律

1. **资产永进后端包**：图片 / PDF / office / 地图 / dump / 密钥，一个都不许进 `sy2-backend-*.zip`。
2. **密钥只进运行时**：`.env*` 仅保留 `.example` 模板，真实密钥走平台环境变量注入（见 `docs/deploy.md`）。
3. **前后端分离**：后端推 `lianjia-no-assets`，前端推 `lianjia`，不要交叉。
4. **改脚本要同步本说明**：排除清单变动时，`package_backend.sh` 与本文档同一提交更新。
