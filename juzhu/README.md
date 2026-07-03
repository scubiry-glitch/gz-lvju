# 新居住频道 · 数据层

## 快速开始

```bash
# 1. 确保源目录存在
#    /Users/scubiry/Downloads/东博项目/新居住专区

# 2. 扫描入库 + 复制图片 + 导出 JSON
python3 juzhu/seed_from_folder.py

# 3. 启动服务（含编辑后台 API，推荐）
python3 juzhu/server.py
# 前台 http://localhost:8765/juzhu-channel-v3-grid.html
# 后台 http://localhost:8765/juzhu-admin.html
```

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

- `juzhu-channel-v3-grid.html` — 频道首页（方案 C）
- `juzhu-bzf-list.html` — 区级项目列表
- `juzhu-bzf-project.html` — 项目户型列表
- `juzhu-unit-detail.html` — 户型详情
- `juzhu-admin.html` — **内容编辑后台**（需 `python3 juzhu/server.py`）

## 编辑后台

| 能力 | 说明 |
|------|------|
| 项目 | 改名称、地址、标签、封面路径、起价/起租、排序 |
| 房源 | 改名称、面积、户型、月租/总价、排序；新增/删除 |
| 同步 | 每次保存自动写 SQLite + 重导 `data.json` |

API：`/api/juzhu/admin/projects`、`/units/{id}`、`POST /export`
