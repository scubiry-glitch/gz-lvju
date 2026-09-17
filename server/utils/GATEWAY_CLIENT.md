# 网关客户端工具类使用说明（server/utils/gateway-client.cjs）

> 适用于 **Node 接口服务（CJS）** 调用网关接口，例如根目录 `app.js`、各 `*.cjs` 模块。
> 参考根目录 `oauth/`（TS 版）改写，去掉 `next/headers` 与 TS 别名依赖，纯 Node CommonJS。

---

## 1. 它解决什么

- 用 **client_credentials + HMAC-SHA256 签名** 自动换取网关 `access_token`（Bearer）。
- `access_token` **内存缓存**，并在过期前 20% 时间窗口提前刷新；失效（401/403 + `X-Error-Code` 900001/900002）自动刷新并重试一次。
- 按运行环境 **自动选择生产 / 测试网关客户端**（client_id / client_secret / client_type）。
- 统一 `fetch` / `json` 封装，自动拼 `servicePrefix`、支持 query、JSON body、代用户 token。

---

## 2. 环境与客户端的对应关系

工具类根据 `JUZHU_ENV`（优先）或 `NODE_ENV` 选择配置：

| 环境（env 命中） | 网关客户端 | client_type | client_id | client_secret |
|---|---|---|---|---|
| `production` / `prod` | `gz_lvju` | `Web_Server_KeIDC` | `gz_lvjuBBu793Lfpvs6v20dPdoij1J` | （见 `gateway-client.cjs` 中 `CLIENT_CONFIG.production`，可被环境变量覆盖） |
| 其它（test / dev / 未设） | `gz_lvju_test` | `Web_Server_ThirdParty` | `gz_lvju_testDTYCRqK1XxcusagEYg` | （见 `CLIENT_CONFIG.test`，可被环境变量覆盖） |

> 密钥值在 `gateway-client.cjs` 的 `CLIENT_CONFIG` 中已按上表固化；**生产建议改用环境变量 `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` 注入**，避免密钥入库。

### 网关地址
- 生产默认：`http://i.aroute.ke.com`。
- 测试默认：`https://aroute-test.ke.com`。
- 均可被环境变量 `OAUTH_GATEWAY_URL` 覆盖（优先）。

---

## 3. 快速使用（默认单例）

```js
const { defaultClient, gatewayJson } = require('./server/utils/gateway-client.cjs');

async function main() {
  // 直接拿 JSON（自动带 Bearer，自动刷新重试）
  const user = await gatewayJson('/api/user/uc/user-info', { method: 'GET' });
  console.log(user);

  // 带 query / JSON body
  const r = await gatewayJson('/gbc/ke/guardian/fund/manage/api/xxx', {
    method: 'POST',
    query: { page: 1 },
    body: { foo: 'bar' },
  });
}
main().catch((e) => console.error(e));
```

> `gatewayJson` 等价于 `defaultClient.json`。若需原始 `Response`，用 `gatewayFetch` / `defaultClient.fetch`。

---

## 4. 自定义实例（不同 service 前缀 / 不同网关）

```js
const { createGatewayClient, GatewayClient } = require('./server/utils/gateway-client.cjs');

// 例：对接资金监管服务，统一前缀
const fundClient = createGatewayClient({
  servicePrefix: '/gbc/ke/guardian/fund/manage',
  gatewayUrl: 'http://aroute.shtest.ke.com', // 可选，覆盖解析
});

// buildPath 会自动拼接前缀
const path = fundClient.buildPath('/api/account/list'); // -> /gbc/ke/guardian/fund/manage/api/account/list
const data = await fundClient.json(path, { method: 'GET', query: { k: 'v' } });

// 也可 new
const c = new GatewayClient({ servicePrefix: '/some/prefix' });
```

---

## 5. API 参考

### `GatewayClient` 类
| 方法 | 说明 |
|---|---|
| `getToken(forceRefresh=false)` | 取 access_token（带缓存）；`true` 强制刷新 |
| `buildPath(apiPath)` | 拼接 `servicePrefix` + apiPath |
| `fetch(path, options)` | 发起请求，返回 `Response`，自动带 Bearer + 失效重试 |
| `json(path, options)` | 同 fetch，解析 JSON；非 2xx 抛错 |

`options` 字段：`method`（默认 GET）、`body`（object 自动 JSON 化，或 string/Buffer）、`headers`、`query`、`loginToken`（代用户调用时附 `X-Login-Token`）。

### 模块导出
- `GatewayClient`：类
- `createGatewayClient(options)`：快捷工厂
- `defaultClient`：按当前环境自动配置的默认单例
- `gatewayFetch` / `gatewayJson`：基于 `defaultClient` 的扁平封装
- `buildOAuthSignature(path, method, params, secret)` / `createNonce()`：签名工具（便于单测 / 复用）

---

## 6. 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `JUZHU_ENV` / `NODE_ENV` | 选择生产 / 测试客户端 | `development` → 测试 |
| `OAUTH_GATEWAY_URL` | 网关地址（覆盖默认） | 生产 `http://i.aroute.ke.com` / 测试 `https://aroute-test.ke.com` |
| `OAUTH_CLIENT_ID` | 覆盖客户端 id | 依环境取 `CLIENT_CONFIG` |
| `OAUTH_CLIENT_SECRET` | 覆盖客户端 secret | 依环境取 `CLIENT_CONFIG` |
| `OAUTH_SERVICE_PREFIX` | 接口路径统一前缀 | 空 |

---

## 7. 与根目录 `oauth/` 的关系

| 维度 | `oauth/`（TS） | `server/utils/gateway-client.cjs`（本工具） |
|---|---|---|
| 运行环境 | Next.js（浏览器/SSR，依赖 `next/headers`） | 纯 Node CJS 接口服务 |
| 用户 token | 从 cookie 取 `X-Login-Token` | 由调用方通过 `loginToken` 传入（server-to-server 默认不带） |
| 签名算法 | HMAC-SHA256，排序拼接 | 完全一致 |
| token 缓存/重试 | 内存缓存 + 失效刷新重试 | 完全一致 |

两者可并存：前端/Next 侧用 `oauth/`，后端 CJS 接口服务用本工具。

---

## 8. 安全注意事项

- **密钥不入库**：生产环境请将 `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` 走部署环境变量（如 `runtime.env` / SCF 配置），不要在源码里长期维护明文。
- **网关地址**：生产默认 `http://i.aroute.ke.com`，测试默认 `https://aroute-test.ke.com`；如需切换可用环境变量 `OAUTH_GATEWAY_URL` 覆盖。
- 本工具仅在**服务端**调用，密钥不出现在任何前端页面 / 静态产物中（静态服务已拦截 `.env*` / `*.sql` / `*.py` 等敏感路径）。
- 调用网关的 `fetch` 使用 `cache: 'no-store'`，避免 token/响应被缓存。

---

## 9. 本地启动与指定环境

项目单入口为根目录 `app.js`（需 Node 22+），网关客户端按 `JUZHU_ENV` 自动切换。

**① 最简单本地启动**（端口取代码默认 `9000`，MySQL/密钥从 `.env` 或 `runtime.env` 自动加载）
```bash
node app.js
```

**② 用常用本地调试端口 8766 启动**
```bash
PORT=8766 node app.js
```

**③ 指定环境启动**（`JUZHU_ENV` 决定走哪个网关客户端与网关域名；`NODE_ENV` 为兜底）
```bash
JUZHU_ENV=production node app.js   # gz_lvju + http://i.aroute.ke.com
JUZHU_ENV=test      node app.js   # gz_lvju_test + https://aroute-test.ke.com
# 组合端口 + 环境
JUZHU_ENV=test PORT=8766 node app.js
```

**④ 完整本地联调**（显式覆盖变量，避免误连仓库内 `runtime.env` 的生产配置）
```bash
JUZHU_ENV=test \
PORT=8766 \
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_DB=juzhu MYSQL_USER=root MYSQL_PASSWORD=你的密码 \
JUZHU_API_KEY=local-dev-key \
JUZHU_ADMIN_PASSWORD=本地后台密码 \
node app.js
```
启动后访问：`http://localhost:8766/index.html`（前台）、`http://localhost:8766/juzhu-admin.html`（后台）。

> ⚠️ `JUZHU_API_KEY` **不能**填 `dev-juzhu-key`——该值在 `app.js` 中已被列为 `FORBIDDEN_API_KEY`，任何环境都视为无效。本地用任意自定义值（如 `local-dev-key`）即可。
> ⚠️ 仓库内的 `runtime.env` 写的是 `JUZHU_ENV=production` 且含**生产明文凭证**。本地联调测试网关/客户端时，务必像 ④ 那样显式传 `JUZHU_ENV=test` 与变量覆盖，避免误连生产网关与生产库。
