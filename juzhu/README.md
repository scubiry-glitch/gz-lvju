# 新居住频道 · 数据层

## 快速开始

```bash
# 1. 确保源目录存在
#    /Users/scubiry/Downloads/东博项目/新居住专区

# 2. 扫描入库 + 复制图片 + 导出 JSON
python3 juzhu/seed_from_folder.py

# 3. 启动预览（静态 JSON 或 API）
python3 -m http.server 8765
# 或
python3 juzhu/server.py
```

## 产出物

| 文件 | 说明 |
|------|------|
| `juzhu.db` | SQLite（本地，gitignore） |
| `data.json` | 前端静态数据源（可提交） |
| `assets/juzhu/sy/` | 图片资源（本地，gitignore） |

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
