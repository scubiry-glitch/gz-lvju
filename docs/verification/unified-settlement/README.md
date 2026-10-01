# 统一结算开发与验收记录

对应设计：[新居住统一分账系统设计](../../plans/2026-10-02-newliving-real-profit-sharing-design.md)。本目录记录代码实现、可重跑验证及启用条件。机构适配测试使用隔离的 MySQL 和明确标识的测试机构响应；实际机构合同、账户准入和真实资金联调仍需使用部署方的有效材料完成。

## 实现入口

| 能力 | 实现 |
| --- | --- |
| 共享结算运行时及后台恢复任务 | `server/settlement/index.cjs`，主站 `app.js`、独立 `commerce/app.cjs` 均接入 |
| 原规则计算、支付到账、权益核销、客户验收 | `business.cjs`、`primitives.cjs`；接入 `commerce/service.cjs` 和两个支付业务适配器 |
| 单笔金额、收款账户、付款时间调整 | `workflow.cjs`，版本校验、差额账、独立复核、在途保护 |
| 商户 AUTO／REVIEW／HOLD、ANY／ALL 审批 | `workflow.cjs`；策略配置与发布分离，停用撤销未执行授权 |
| 主体、账户、协议准入 | `configuration.cjs`；保留订单合同快照，账户及协议独立审核 |
| 真实机构执行及回退 | `execution.cjs`、`provider.cjs`；持久请求号、任务租约、预占、原号查询、逐行结果、S 释放、B 到账 lot、Q 二段付款 |
| 原路退款 | 公共 `server/payment/core.cjs` 唯一执行，共享分账验证原款与经济额度；业务事件确认现金账 |
| 独立资金补差、先行赔付 | `own-funds.cjs`；入账凭据防重、双人准入、存量义务额度保护、实际赔付后激活追偿 |
| 核销撤销、已付追偿、退票及重付 | `reversal.cjs` 与原 `commerce/settlement.cjs` 门面连接；保留原成功历史 |
| 外部小程序订单正常出账 | `external.cjs`、`vendor_api.cjs`；签名回调 Inbox、审批主体绑定、候选订单及证据、人工核验、合同应计与实收分离 |
| 收款方周期账单与下载 | `statements.cjs`、`exports.cjs`；冻结版本、跨期、确认／异议、CSV／XLSX／中文 PDF |
| API 与权限 | `/api/settlement/v1/`，`http.cjs`、`access.cjs`、`perm_registry.cjs` |
| 操作页面 | `/screens/settlement-admin.html`、`/screens/settlement-statements.html`；生活订单页增加验收入口 |

所有文件路径以仓库根目录为基准，表格省略的模块目录为 `server/settlement/`。

## 资金与账单口径

站内以订单接受的唯一成功支付登记资金来源，权益核销或客户验收才确认应付。S 与 B 消耗原支付资金，Q 使用 B 实际到账后生成的资金批次；Q 不再次占用消费者原支付。原款释放保存独立效果，不伪造第二次商户转账。固定服务成本与平台佣金独立配置，未分配部分保留待履约负债。

金额使用整数分和 BigInt。单次计划金额与累计应付分开，实际成功才增加清偿额；改单不改历史流水。在途结果未知时不能改账户或金额，保留预占并查原请求号。补差和赔付须有独立确认的自有资金，审批额度扣除同来源已批准但尚未付款的义务。

平台佣金 B 是账户间资金划拨，可以调整本次付款安排；不能把该资金腿当作平台应付做应结调增减。合同佣金经济口径变更通过撤销原业务确认及重新认定处理，避免凭空借记不存在的平台应付。

外部订单固定为 `EXTERNAL_RECORD_ONLY`。商户报送、机构核验、合同应计、渠道结算和佣金到账分别记录。即使付款凭证缺失，订单也进入账单覆盖清单并显示待核验。外部付款不会生成站内资金来源、支付订单或执行指令。200 元消费、20 元佣金、收款 12 元、退佣 5 元后应收 3 元；已收 20 元再退佣 5 元时，应收为 0，另列待退 5 元。

## 配置和运行

迁移沿用原 `commerce_ledger_entries` 和结算明细，旧 004／005 迁移定义不修改。新增共享 schema、执行、账单、自有资金和撤销追偿结构；迁移可重复运行。连接在执行 SQL 前归一到 UTC，界面账期按北京时间展示，不能仅依赖 mysql2 的客户端 `timezone` 参数。

部署前在目标环境完成代码评审及备份，显式运行：

```sh
npm run settlement:migrate
```

命令通过已有宿主数据库凭据机制连接；本文和仓库不保存凭据。主站、独立 commerce 进程与结算必须连接同一个业务库。

| 配置 | 作用 |
| --- | --- |
| `SETTLEMENT_REPORTS_ENABLED=1` | 自动同步外部订单、注册各债权／债务主体月账、生成账单、处理导出；不要求打开真实付款 |
| `SETTLEMENT_ENABLED=1` | 新站内订单锁定已准入的共享结算协议；未核验受控收款配置时下单被拒绝 |
| `SETTLEMENT_WORKER_ENABLED=1` | 与上一项同时开启后，评估自动／人工授权并编译新资金计划 |
| `SETTLEMENT_PAYMENT_CONTRACTS` | 受控收款的不可变机构映射 JSON，验证原合同、原收款方和资金控制证据 |
| `SETTLEMENT_PROVIDER_CONTRACTS` | 分账、回退、代付、原款释放及查询的机构映射 JSON |
| `SETTLEMENT_PDF_FONT` | 部署机器已有的中文字体；缺失时导出明确失败，可补齐后重试 |

资金能力默认关闭，`.env.example` 提供独立报表开关。暂停新增执行时仍处理已发请求的查询和已批准逆向恢复；不能删除历史契约版本或覆盖相同版本的字段映射。机构成功回执要逐项匹配原请求、资金来源、合同、金额、币种和收款人，普通接口成功码不会直接记为付款成功。

收款和分账的完整映射、账户能力字段及验收证据见 [provider-contract.md](provider-contract.md)。代码没有把未核验的 `shareOrderMode`、`splitLevel` 或 `leafFlag` 写成真实机构常量。

按需运行一次后台任务或只读不变量检查：

```sh
npm run settlement:worker
npm run settlement:verify
```

主站及独立 commerce 进程均有周期任务；数据库任务租约、内容幂等和唯一键支持重复调度。

## 准入和操作顺序

1. 在账号中心给财务配置 `settlement.fund.*`、`settlement.policy.*`、`settlement.approval.act` 等对应权限及主体范围；申请、准入和审核使用不同账号。新权限没有自动扩大现有内置角色的权限面。
2. 给收款方配置 `settlement.statement.read/export/confirm/dispute`，通过已批准主体绑定限定可见范围。推广员使用 `account:<账号 ID>`；外部商家只提交资料时授予 `settlement.external.submit`，该权限不能核验自身资料或修改合同应计。
3. 审批主体绑定、机构账户和协议。站内来源／商户／平台账户必须处于相同机构环境和币种；`collection` 与实际来源账户核对。平台佣金账户所属主体须先由全局权限账号双人准入 `platform/entity` 绑定，协议申请与审批还要分别具有原款及平台账户主体权限，防止商户把平台资金腿改为自己的账户。外部协议不要求本站资金账户或机构付款能力。
4. 配置商户结算策略并独立发布。可以多节点 ANY／ALL；同优先级冲突会阻止自动结算。改单产生新版本和独立复核，旧审批不能授权新金额。
5. 对站内生活服务，由本人在已付且已完成服务的订单页确认验收。对权益，使用有效核销事实；演示券不进入真实资金域。
6. 财务在工作台查看计划、原机构请求及逐行结果；失败释放与未知保留预占分别处理。外部商户和其他收款方在对账页查看月账、提出异议或下载已生成文件。下载时重新验证当前账号和主体范围。

## 已实施的准入边界

- 本期现金生活服务是一单一个完整履约单位，采用客户验收。部分退款后禁止全额验收；分阶段服务及合同自动验收需要另行批准对应单位、通知和履约政策，不能靠 `done`、评价或默认时间推断。
- 不同法律结算主体的权益商品需按主体拆单。相同结算主体的多商户、多券可共用兼容原款路线；不同主体不能错误共用首个商户的审批及权限。
- 已结清原款、缺少历史支付或合同快照的订单不会被迁移为可付款余额。历史资料必须核验，原沙箱记录不会冒充真实到账。
- 机构实际支持哪些动作，以已核验契约为准；缺少真实代付／释放能力时该动作保持关闭，账单照常出具。
- 住宿分账未纳入此次共享域；原住宿支付接口沿用既有功能。

## 验证方式

必须显式提供位于 `/tmp` 的独立 MySQL socket。测试只创建带随机后缀的临时库，结束后删除各自库；机构响应是本地测试契约，不发真实付款。运行：

```sh
SETTLEMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
TZ=Asia/Shanghai npm run settlement:test

SETTLEMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
node scripts/commerce/settlement-test.cjs --browser

PAYMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
TZ=Asia/Shanghai node --test \
  server/test/unified_payment_core_test.cjs \
  server/test/payment_gateway_compat_test.cjs \
  server/test/payment_service_test.cjs \
  server/test/jiazheng_cashier_test.cjs \
  server/test/jiazheng_legacy_compat_test.cjs \
  server/test/legacy_payment_boundary_test.cjs \
  scripts/commerce/payment-integration.test.cjs \
  scripts/commerce/legacy-api-compat.test.cjs
```

统一测试覆盖精确计算、AUTO 累计额度并发、会签、改单失效、账户版本、幂等与撤权重放、原请求超时、部分结果、两跳资金、退款／追偿／退票、补差、外部缺资料正常出账、版本／跨期、真实格式导出、HTTP 行级权限和浏览器。`settlement_runtime_test.cjs` 使用真实运行时和 HTTP，特意使用返回 Date 的连接并先设置非 UTC 会话，验证服务本身完成归一。

完整统一回归输出保存在 [settlement-test.txt](settlement-test.txt)，原权益结算与浏览器重跑输出见 [legacy-settlement-test.txt](legacy-settlement-test.txt)，公共支付、生活服务及权益旧接口兼容回归输出见 [payment-compatibility-test.txt](payment-compatibility-test.txt)。原权益的详细业务和浏览器证据另在 [newliving-commerce-settlement](../newliving-commerce-settlement/)。

2026-10-02 最终隔离验收结果：

| 验证组 | 结果 |
| --- | --- |
| 共享计算、工作流、资金执行、逆向、账单、HTTP、真实运行时 | 81 项通过，0 失败、0 跳过 |
| 统一工作台和收款方浏览器 | 21 项检查通过，包含 18 次模拟接口写入 |
| 公共支付、生活服务、权益支付及旧接口兼容 | 79 项通过，0 失败、0 跳过 |
| 原权益结算业务和浏览器 | 19 个场景通过 |
| 交付静态检查 | 48 个 JavaScript 文件语法通过；权限注册、文档资源及导航链接通过；旧 004／005 迁移段逐字保持不变 |

最终用例包含跨主体资金路线申请／审批拒绝、平台法律主体独立准入、B 资金腿禁止经济调额、零金额权益调账拒绝且不改变明细版本。`git diff --check` 通过。此处通过仅指隔离程序验收，不替代真实机构准入和实款联调。

页面验收截图：[管理工作台](admin-desktop.png)、[收款方账单](statements-desktop.png)、[手机账单](statements-mobile.png)。

验证期间，旧权限脚本曾按默认配置调用本机运行站点，完成权限和认证回归，并在 scope 回归中发现两个旧 stats 断言不匹配。随后停止了该组测试；本次残留的 7 个测试账号与 1 个测试机构已按唯一运行标识清理，测试项目已删除。该组不计入本次隔离全绿结论，没有调用支付或分账接口；后续验证均使用隔离库和模拟机构。

## 2026-10-02 测试站页面接入修复

用户反馈收款方页面显示“暂时无法读取结算数据”。实际定位为 `/api/settlement/v1/me` 被通用 `/api/` 路由送至旧主进程 `8766`，收到 `200 text/html` 首页；已运行的独立 commerce 服务 `38780` 能正常处理共享结算接口。两个进程的数据库目标已核对一致。

已在 `deploy/commerce/nginx-location.conf` 及 sytest 当前 nginx 配置中加入 `/api/settlement/v1/` 专用转发，配置备份、`nginx -t` 后平滑重载。前端保留非 JSON 响应的 HTTP 状态，分别呈现登录、服务未就绪、暂不可用和响应异常；两个页面脚本版本升至 `20261002-3`。未变更账务数据、未启用真实付款或修改报表调度开关。

本地浏览器回归增至 27 项，补充 HTML 401／404／502／503／200、重定向至 HTML 及服务恢复后重新加载。测试站实际浏览器验证 7 项通过：匿名登录提示、授权身份和账单 JSON、桌面账单、手机布局、管理页及脚本无异常，见 [live-route-check.json](live-route-check.json)、[桌面截图](live-statements-desktop.png)、[手机截图](live-statements-mobile.png)。线上验证仅登录及只读查询，结束后撤销本次验证会话。
