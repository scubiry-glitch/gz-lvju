> 历史阶段记录：测试域名现已切换为M1-A正式账号与MySQL持久化服务，以下M0页面、模式及操作说明不再适用于当前域名。当前入口和验收见 [M1-A交付说明](../newliving-commerce-m1a/README.md)。

# 新居住权益 M0：启动与验收

本实现对应 [Goal 验收标准](../../prd/GOAL-新居住权益闭环验收.md)，范围是用户确认的“无资金联调版”。业务流程由独立 Node 服务执行，前端沿用 `lvju-app.css`、全站共享导航及现有工作台布局。生产入口 `app.js` 不装载测试业务模块。

## 启动

**测试域名已接通（2026-09-19）：** [用户端](https://sytest.meizu.life/juzhu-commerce.html)、[推广端](https://sytest.meizu.life/juzhu-promoter.html)、[商户端](https://sytest.meizu.life/screens/commerce-merchant.html)、[管理端](https://sytest.meizu.life/screens/commerce-admin.html)。由 `sy-commerce-preview.service` 常驻运行，监听环回38780，Nginx仅将 `/api/commerce/v1/` 转入该服务；原业务API仍走8766。域名端仍是无资金、共享测试身份及内存数据，不是正式交易系统。服务重启后测试数据清空。

在仓库根目录运行：

```bash
npm run commerce:dev
```

默认本机地址：`http://127.0.0.1:38779`。可用 `COMMERCE_TEST_PORT` 改本地端口。仅绑定环回地址，默认仅接受localhost；可通过 `COMMERCE_PUBLIC_ORIGIN` 显式配置一个HTTPS预览来源，Host及Origin须匹配，拒绝其他来源。`NODE_ENV=production` 或 `JUZHU_ENV=production` 时禁止启动。没有数据库、凭据、支付方或通知服务依赖。

| 入口 | 路径 |
|---|---|
| 原频道首页（测试权益模块） | `/index.html?tab=jiazheng` |
| 用户端（券包、会员、卡券、预约、订单、售后） | `/juzhu-commerce.html` |
| 推广端（分享、佣金、测试提现） | `/juzhu-promoter.html` |
| 商户端（核销、预约、应结、结算指令） | `/screens/commerce-merchant.html` |
| 管理端（补发、售后、赔付、机构指令、审计） | `/screens/commerce-admin.html` |
| 全站总览 | `/overview.html#commerce-hub` |

服务数据仅存内存，重启清空；每次浏览器自动化验收另起临时端口及独立实例，不污染人工演示。前端仅在 sessionStorage 保存临时测试身份会话，不将订单、券或余额放入 localStorage。

原 `app.js` 中只增加 commerce 源码目录的静态访问拦截。首页添加能力探测脚本，只有确认当前服务器是无资金联调服务才替换原领券卡片；没有测试服务则保留原首页卡片和12类生活服务入口。测试服务为原首页提供最小只读目录夹具，不代理生产家政/房源 API。除明确静态白名单与 assets 图像/字体外，其余路径拒绝访问。

## 建议的演示顺序

1. 在推广端以“推广员·小沈”生成券包链接，复制后打开用户端。用户浏览规则与门店预约可得性，勾选确认后创建测试订单。
2. 在“测试收银台”点击“确认测试支付（无资金）”。验证生成5张券，推广端仍无已确认佣金。可勾选“测试发券失败”，到管理端按原批次补发。
3. 用户端打开第一张保洁券，选择可预约日期，预约后生成有效期120秒的动态口令。
4. 商户端选择“测试供应商A”，粘贴口令并预览。本商户应结为159.84元；预览不核销。勾选测试履约后确认核销。
5. 管理端检查未核销负债799.20元、商户应结159.84元、推广佣金19.98元、平台净留19.98元。点击“模拟机构账期到达”。推广端刷新后申请19.98元测试提现。
6. 管理端“模拟超时”将该指令置UNKNOWN；推广端可用金额不能恢复。管理端“查询原机构请求”读取模拟机构已成功结果，保持同一个 provider_request。
7. 用户对未使用券提交售后，管理端复核后记录未用退回。对已核销但服务失败的券提交售后，管理端复核后记录独立自有资金赔付与应收商户代偿，再演示追偿。
8. 管理端将一张未用券推进到期，验证自动原路退回。自然到期扫描每15秒执行一次；无须用户申请。核销/退款记录保留。
9. 开通会员、模拟会员到期，验证未过期赠券仍在；续费按新发放批次发券。订单页可提交开票/帮助工单，管理端登记回复，不生成真实发票。
10. 切换另一位用户、另一商户或推广员检查隔离。用户页选择商户身份时展示无权状态，服务端也拒绝对应操作。

## 技术与证据等级

- `commerce/domain.cjs`：同步内存业务域、版本快照、幂等请求、预约产能、核销计算、追加式平衡账、售后赔付、独立测试机构预占。
- `commerce/server.cjs`：环回监听、临时测试会话、接口角色及对象验证、Origin/Host检查、核销限频、到期扫描和静态白名单。
- `screens/_commerce-api.js`：服务端 API；`_commerce-ui.js`：四端投影；`_commerce.css`：沿用全站色板及组件，仅补布局/状态。
- 四个页面聚合了原计划的多个页面组，未创建多份订单或佣金账。`screens/_nav.js` 为桌面导航唯一数据源。
- `scripts/commerce/domain.test.cjs`、`http.test.cjs`：业务与真实本地 HTTP 测试。
- `scripts/commerce/browser.cjs`：Chromium 操作四端，检查界面、关键状态、权限、页面错误及共享导航。

所有生产资金操作都没有适配器实现；`/orders/:id/test-pay` 是明确测试事件入口，`/orders/:id/pay` 和正式支付回调返回404。测试身份切换仅存在于独立服务，不能作为正式SSO验收。

## M0 实际接口契约

前缀为 `/api/commerce/v1`，与完整一期规划共用域边界，M0采用聚合状态接口以减少页面联调复杂度。下表是当前可调用接口，规划中的生产接口不应当作已实现。响应为 `{request_id, code, data, test_only:true}`，失败为 `{request_id, code, error, test_only:true}`。

| 方法/路径 | 输入及出参要点 |
|---|---|
| `GET /meta` | `mode=isolated-memory-test`、`real_money=false`及测试身份清单 |
| `POST /test-sessions` | `{identity}` → `{token, actor}`；仅此独立服务存在 |
| `GET /catalog?city=沈阳` | 商品 `id/type/price/version/items`；每项含供应商、门店及逐日 `availability` |
| `GET /state` | 当前角色裁剪后的订单/券/会员/预约或佣金/应结/管理状态；不返回其他主体数据 |
| `POST /order-quotes`、`/orders` | `{product_id,version,city?,promotion_token?}`；报价金额和订单归属由服务端确定 |
| `POST /orders/:id/test-pay` | `{fail_grant?:boolean}`；仅本人订单，成功事件幂等；返回支付/发放状态 |
| `POST /appointments`、`/appointments/:id/cancel` | 预约传`{coupon_id,date}`，重复选择日期走改期；先验证新产能再释放旧预约 |
| `POST /me/coupons/:id/redemption-token` | 返回`token,expires_at`；两分钟有效，必须本人且有预约 |
| `POST /redemption-previews`、`/redemptions` | `{token,store,service_confirmed?}`；核销须确认凭证，预览不改变状态 |
| `POST /promotion-links` | `{product_id}` → 签名链接及过期时间；只限推广身份 |
| `POST /withdrawals` | `{amount}`整数分 → 唯一`provider_request`及状态；由测试机构预占 |
| `POST /refunds`、`/help` | 售后`{coupon_id,reason}`；帮助`{order_id,kind:INVOICE或HELP}`；生成持久于本次服务生命周期的工单 |
| `POST /admin/...` | 订单retry、refund approve、test-release、payout unknown/query/paid、compensation recover、expiry-job、test-expire、sales、test-capacity、test-membership-expire、help resolve；操作与页面一一对应，限admin身份 |

除meta/catalog/product公开读及测试会话交换外，接口要求 `Authorization: Bearer <临时测试会话>`。业务写操作要求 `Idempotency-Key`（8–200字符），键按主体与操作隔离，同键异请求409。金额字段 `total/price/basis/amount/supplier_payable` 在M0中均为**整数分**，前端显示时除100；生产API统一字段后缀与大整数契约仍按正式OpenAPI评审实施。403为对象或角色无权，409为状态冲突，422为规则缺项，429为核销限频。

## 运行验证

```bash
npm run commerce:test
node test_index_boot.js
node test_static_guard.js
```

浏览器测试需要现有 Playwright 与 Chromium。默认 `require('playwright')` 使用本地安装；已有外部安装时显式传路径，例如：

```bash
COMMERCE_PLAYWRIGHT_MODULE=/path/to/playwright-core \
COMMERCE_CHROME=/path/to/chrome \
node scripts/commerce/browser.cjs
```

本机验证所用路径：Playwright Core `/tmp/e2e/node_modules/playwright-core`，Chromium `/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`。这些是当前机器路径，不是代码运行时依赖约定。受限沙箱中监听本地端口和启动 Chromium 需要运行环境授权。

浏览器脚本输出 `browser-results.json` 及截图；每次全链路测试使用全新内存实例。截图中的身份、订单号和核销口令全部是本次隔离实例的测试数据；实例关闭后失效。最终结论见 [验收结果](RESULTS.md)。

## 正式交易前仍需完成

本 M0 不证明 MySQL 多连接事务、分布式并发、正式身份、真实支付清分/退款/代发或外部机构渠道能力。无实际商户资料、签约规则、真实费率或准备金验证。商品与单层推广规则均为固定测试配置；正式商品编辑、授权发布及规则双审按开发计划实现。

目前退款模型演示“未用券原路退回”与“已核销履约失败先行赔付”，后者保留原核销事实并记应收代偿；不等同于完整的误核销撤销/佣金冲回系统。多资金来源、尾款、第三方销售方身份、已提现追偿抵扣、跨账期清分、会员部分未分配资金等复杂分支保留给 M1。测试机构目前只模拟账期可用、预占、UNKNOWN及原单成功查询，未替代真实机构合同与税费规则。

M1 必须落实 v1.9 的 S01–S30/E01–E08、六个资金不变量完整反例集、真实 MySQL 并发、正式SSO与 G1–G4。不能将本目录的 M0 PASS 当成真实收款许可。
