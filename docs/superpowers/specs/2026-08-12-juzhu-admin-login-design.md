# 新居住内容编辑后台 · 登录门禁

## 目标

打开 `juzhu-admin.html` 必须先通过服务端密码校验；未登录只显示登录框。

## 决策

| 项 | 选择 |
|---|---|
| 校验位置 | 服务端（`juzhu/server.py`） |
| 密码配置 | 环境变量 `JUZHU_ADMIN_PASSWORD`，默认 `dongbo2026` |
| 门禁范围 | **仅页面门禁**；`/api/juzhu/admin/*` 业务接口仍用 `JUZHU_API_KEY` |
| 会话 | 无状态 HMAC token，本地 `localStorage` 保留 **30 天** |
| 非目标 | 多用户、角色、改密、用 token 替代 API Key |

## API

### `POST /api/juzhu/admin/auth/login`

- **鉴权**：无需 API Key  
- **Body**：`{ "password": "..." }`  
- **成功 200**：`{ "token": "<signed>", "expires_at": "<ISO8601>" }`  
- **失败 401**：`{ "error": "unauthorized", "message": "密码错误" }`

### `GET /api/juzhu/admin/auth/check`

- **鉴权**：`Authorization: Bearer <token>`（页面登录 token，不是 API Key）  
- **成功 200**：`{ "ok": true, "expires_at": "..." }`  
- **失败 401**：token 缺失/无效/过期

## Token

- 格式：`{exp_unix}.{hmac_sha256_hex}`  
- 签名密钥：由 `JUZHU_ADMIN_PASSWORD` 派生（改密码则旧 token 全部失效）  
- TTL：`30 * 24 * 3600` 秒  

## 前端

- 全屏登录遮罩；校验通过后再跑现有 `loadCities` 等初始化  
- `localStorage` 键：`JUZHU_ADMIN_TOKEN`  
- 顶栏「退出」：清 token 并重新显示登录框  
- 业务请求继续带 `X-API-Key`（`JUZHU_API_KEY` / 默认 `dev-juzhu-key`）

## 与 API Key 的关系

- `JUZHU_API_KEY`：机器调写接口用的密钥（服务端环境变量或默认值；浏览器 `localStorage`）  
- `JUZHU_ADMIN_PASSWORD`：人进编辑后台的登录密码  
- 二者独立，互不替代  
