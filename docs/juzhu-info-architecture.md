# 新居住频道 · 信息结构

基于东博项目 `新居住专区` 文件夹梳理，城市为 **沈阳**。

## 源数据目录结构

```
新居住专区/
├── 保租房专区/
│   └── {行政区}/                    ← 二级入口（方案 C 拼贴网格）
│       ├── {区名}.jpeg              ← 区封面
│       └── {项目/门店}/             ← 三级：项目列表
│           ├── 店封面.jpg
│           └── {户型文件夹}/        ← 四级：房源/户型
│               └── *.jpg            ← 实景图
└── 卖旧买新专区/
    └── {项目}/                      ← 直达项目（无区级）
        ├── 项目 封面.jpg
        └── {面积}/                  ← 户型
            └── *.jpg
```

**保租房** 9 个行政区（其中 3 个标注「暂无项目」：于洪、沈北、铁西）。  
**卖旧买新** 2 个项目：中德人才社区、逸居锦城。

## 页面信息架构（方案 C）

| 层级 | 保租房 | 卖旧买新 |
|------|--------|----------|
| L1 频道 Tab | 拼贴区网格 | 杂志 spread 列表 |
| L2 | 行政区（数字：项目数/可租/均价） | 项目卡片（Featured + 列表） |
| L3 | 项目/门店列表 | 户型列表 |
| L4 | 户型详情 + 图集 | 户型详情 + 图集 |

## SQLite 表

见 `juzhu/schema.sql`：

- `cities` → `districts` → `projects` → `units` → `photos`
- `projects.channel`: `bzf` | `trade`
- 卖旧买新项目的 `district_id` 为 NULL

## 数据管线

```bash
# 1. 从 Downloads 扫描入库 + 复制封面到 assets/juzhu/sy/
python3 juzhu/seed_from_folder.py

# 2. 静态预览（读 juzhu/data.json）
python3 -m http.server 8765

# 3. 或带 API 的服务
python3 juzhu/server.py
```

API 端点：

- `GET /api/juzhu/stats`
- `GET /api/juzhu/districts`
- `GET /api/juzhu/districts/{slug}/projects`
- `GET /api/juzhu/projects/{slug}/units`
- `GET /api/juzhu/trade`

## 前端页面

| 文件 | 职责 |
|------|------|
| `juzhu-channel-v3-grid.html` | 频道首页（方案 C，读 data.json） |
| `juzhu-bzf-list.html` | 区级 → 项目列表 |
| `juzhu-bzf-project.html` | 项目 → 户型列表 |
| `juzhu-unit-detail.html` | 户型详情 + 轮播 |
