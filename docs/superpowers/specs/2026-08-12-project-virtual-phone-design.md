# 项目维度虚拟号拨号 · 设计说明

> 日期：2026-08-12  
> 状态：已审阅通过并实现  
> 范围：保租房（`bzf`）+ 卖旧买新（`trade`）  
> 相关规范：`docs/tp-sign-and-call.md`、`CLAUDE.md` 规则 10

---

## 1. 目标

- 电话挂在**项目**维度，两频道共用字段。
- **后台录入真实号码**；**用户拨号只拨虚拟号（400）**。
- 虚拟号**不缓存**：每次用户确认拨打时，服务端实时请求话务 `/bundling/alloc`。
- **真实号不进入 `data.json`**，也不下发到公开前台静态资源。

## 2. 非目标

- 不改家政工单电话链路。
- 不在项目列表 / 项目页增加拨号入口（仅户型详情页 CTA）。
- 本期不删除城市级 `booking_phone`、户型 `keeper.phone` 字段（保留以免大迁移）；**户型详情拨号链路不再使用它们**。
- 前端不持有 `TP_APP_ID` / `TP_APP_KEY`，不直连话务。

## 3. 用户确认结论

| 项 | 结论 |
|----|------|
| 拨号入口 | **A**：仅 `juzhu-unit-detail.html` 底部「预约咨询」及同页已有拨号 CTA（管家电话图标、租金弹层咨询）统一走项目虚拟号 |
| `data.json` | **不带**项目真实号 |

## 4. 数据模型

`projects` 表新增：

| 列 | 类型 | 说明 |
|----|------|------|
| `contact_phone` | TEXT NULL | 项目联系真实号（11–13 位数字，非 400）；后台可读写 |

迁移：`juzhu/db.py` 对缺列做 `ALTER TABLE`（与现有 `booking_phone` 迁移风格一致）。

导出 / 静态 `data.json`：

- `export` 路径**省略** `contact_phone`（或显式 `null` 且永不写入真实值）。
- 管理端读项目详情 API **可返回** `contact_phone`（需管理鉴权，与现有 admin API 一致）。

## 5. API

### 5.1 管理端（已有项目 CRUD 扩展）

- `POST/PUT /api/juzhu/admin/projects`：请求体可含 `contact_phone`（真实号）。
- `GET /api/juzhu/admin/projects/:id`：响应含 `contact_phone`。
- 校验：空允许（表示未配置）；非空则校验为 11–13 位纯数字且不以 `400` 开头。

### 5.2 C 端虚拟号（新建，公开只读）

```http
GET /api/juzhu/projects/{id}/virtual-phone
```

也支持 slug（与现有项目查询风格对齐，二选一或均支持）：

```http
GET /api/juzhu/projects/by-slug/{slug}/virtual-phone?city=...
```

行为：

1. 按 id/slug 查项目；不存在 → 404。
2. `contact_phone` 为空 → 400 / 业务错误「未配置联系电话」。
3. 每次请求：用环境变量 `TP_BASE` / `TP_APP_ID` / `TP_APP_KEY` 调 `/bundling/alloc`（**不传 `port`**），**不做结果缓存**。
4. 成功响应（示例）：

```json
{
  "virtual_phone": "4008891279-0355",
  "display": "400 889 1279 转 0355",
  "tel": "tel:4008891279,0355"
}
```

- `virtual_phone`：话务原文。
- `display`：便于 UI 展示（可选，前端也可本地格式化）。
- `tel`：供 `location.href` / `<a href>` 使用；分机用逗号（多数手机拨号盘支持）。
- **绝不返回** `contact_phone` / 真实号。

5. TP 失败：502 或业务 errno 透出脱敏错误信息；前端 toast「暂时无法接通，请稍后重试」。
6. 未配置 TP 环境变量：开发态可返回明确错误；禁止回退成真实号。

## 6. 后台 UI（`juzhu-admin.html`）

- 项目新建 / 编辑表单增加字段：「联系电话（真实号）」。
- hint：用户端将实时换绑为 400 虚拟号；勿填 400；勿写入对外文案。
- 城市「预约电话」Tab：标注为**已降级 / 详情拨号不再使用**（可保留编辑，避免误删数据）。

## 7. 前台拨号 UX（`juzhu-unit-detail.html`）

统一走「隐私提示 → 实时取号 → 展示并拨打」：

1. 用户点击「预约咨询」/ 管家电话 / 租金弹层咨询。
2. 弹出既有隐私保护确认。
3. 确认后：`fetch` 虚拟号 API（`cache: 'no-store'`，且页面侧不写 localStorage/sessionStorage）。
4. 成功：可短时展示「正在接通 400…」或直接 `location.href = tel`；展示文案用返回的 `display`/`virtual_phone`。
5. 失败 / 未配置：alert 或 toast，不发起 `tel:`。

号码解析优先级（详情页）：

1. 所属项目的服务端虚拟号（唯一来源）
2. 无 → 提示后台录入项目电话  
（不再回落城市 `booking_phone` / `keeper.phone`）

## 8. 服务端模块与环境

建议新增 `juzhu/tp_client.py`（从 `scripts/tp_bundling_alloc.py` 抽签名与 `call_alloc`），供 `server.py` 调用；密钥只读环境变量。

### 8.1 话务 Base URL（与 `docs/tp-sign-and-call.md` 对齐）

| 环境 | `TP_BASE` | 网络 | 说明 |
|------|-----------|------|------|
| 测试 | `http://tp-test.lianjia.com` | 外网可访问 | 联调、验收；**本地默认值** |
| 线上 | `http://i.tp.lianjia.com` | **内网**，外网不可直连 | 正式流量；调用方须部署在可访问内网的服务 |

配置项（值进环境变量 / 密钥系统，**禁止写进前端或提交明文密钥**）：

| 变量 | 含义 |
|------|------|
| `TP_BASE` | 上表二选一；未设时默认测试 `http://tp-test.lianjia.com` |
| `TP_APP_ID` | 话务业务标识 |
| `TP_APP_KEY` | 对应密钥，仅服务端 |

路径固定：`{TP_BASE}/bundling/alloc`（本业务**不传 `port`**）。

日志：可记 `project_id`、`errno`、`ts`、当前 `TP_BASE` 主机名；禁止打完整 `app_key` 与含 key 的待签串；真实号可打脱敏（如 `138****8000`）。

## 9. 验收标准

- [ ] 后台可为 bzf / trade 项目分别保存真实号，刷新后仍在。
- [ ] `data.json` / 公开项目列表·详情 JSON **不含** `contact_phone` 真实值。
- [ ] 户型详情连续两次拨号均命中服务端 TP（或两次独立请求）；前端与服务端均无虚拟号缓存。
- [ ] 响应与页面 DOM 中看不到真实号。
- [ ] 未配号 / TP 失败时有明确提示且不拨真实号。
- [ ] 静态页检索无 `TP_APP_KEY` / 话务 Base 直调。

## 10. 风险与回退

| 风险 | 缓解 |
|------|------|
| 本机外网调不通线上 `http://i.tp.lianjia.com` | 默认 `TP_BASE=http://tp-test.lianjia.com`；上线改环境变量为内网 Base，服务须部署在内网 |
| 系统 HTTP 代理导致超时 | 与联调脚本一致：请求强制无代理 |
| 旧前端仍用城市号 | 改详情页拨号路径后即切断；城市号仅作遗留字段 |

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-12 | 初稿：入口 A、data.json 不带真实号、实时 TP、后台项目真实号 |
| 2026-08-12 | 补全测试/线上 `TP_BASE` 完整 URL |
