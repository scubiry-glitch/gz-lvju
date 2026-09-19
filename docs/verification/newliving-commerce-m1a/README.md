# M1-A：正式业务底座与管理页面

本轮范围：[目标与验收标准](../../prd/M1A-正式业务底座与管理页验收.md)。需求基线为券包与会员系统v1.9。代码位于分支 `plan/newliving-coupons-membership-v1.9`。

## 实际访问入口

- [生活权益](https://sytest.meizu.life/juzhu-commerce.html)：商品详情、本人卡券、会员、订单、预约、售后。
- [权益推广](https://sytest.meizu.life/juzhu-promoter.html)：商品分享、签名来源、本人推广统计。
- [商户中心](https://sytest.meizu.life/screens/commerce-merchant.html)：商户、门店、核销人员、券商品、库存、产能、订单、卡券、预约、核销、售后。
- [运营中心](https://sytest.meizu.life/screens/commerce-admin.html)：经营概览及16个管理页面。
- [账号与权限中心](https://sytest.meizu.life/screens/account-center.html)：使用既有账号管理，不另外维护登录体系。

页面沿用 `lvju-app.css` 配色、卡片、字体及全站共享导航；桌面和390px手机均验收。表单提供商家/城市/账号选择、字段校验、逐券明细编辑，配置支持保存、提审、独立复核、发布、停用。列表提供搜索、状态筛选、分页、详情及失败重试。

## 账号与审核

正式登录复用 `BZF_SESSION_TOKEN` 和 `accounts / roles / account_roles / sessions`。旧全局Key、机器账号和M0测试会话不能访问权益业务。

新增权限默认不赋予旧业务角色，平台管理员的既有 `*` 可用。其他人员通过账号中心创建/配置角色：

| 工作职责 | 权限 | 数据范围 |
|---|---|---|
| 平台配置与履约 | `commerce.admin.read`、`commerce.admin.write` | 显式城市或all；机构/商户范围仅覆盖有归属的资源 |
| 独立复核 | `commerce.admin.read`、`commerce.admin.review` | 同上；提交人不能自审 |
| 商户资料与售后协同 | `commerce.merchant.read`、`commerce.merchant.write` | vendor；账号须绑定既有商家 |
| 门店核销 | `commerce.merchant.read`、`commerce.merchant.redeem` | vendor；还须存在已发布的本门店核销人员授权 |
| 用户与个人推广 | 正式个人账号即可 | 本人资产、本人推广记录 |

正式试点资料、合同、报价与门店人员由业务运营录入。公开库不注入验收商品、测试账号或模拟订单。未发布商品时前台显示真实空态。双人复核需要两个不同账号，不能由同一人切换角色规避。

## 业务边界

当前是**支付关闭的M1-A业务底座**，不是可收款上线版本：

- `POST /orders` 返回409，页面不会出现测试支付、强制已支付、模拟到账或提现按钮。
- 已验证支付后的预占/履约方法仅供未来支付适配器内部调用，未提供HTTP入口。库存原子预占、逐券发放、履约快照与幂等已在独立MySQL库验收。
- 核销才记录逐券应结与佣金事实；这些明细不表示支付机构已结算。
- 未使用卡券到期后冻结并自动建立原路退款待处理单；实际退款、分账、提现及赔付需M1-B支付通道。不会将待处理标成已退款。
- 会员有效期与赠券有效期独立；本轮会员价格要求等于赠券分摊合计，其他复杂定价模型尚未开放。
- 商户可回复售后，平台受理或驳回。冻结与核销互斥。已核销服务赔付、完整财务冲回及机构渠道属于M1-B。

## 数据与运行

- 21张独立 `commerce_*` 表，MySQL8/InnoDB；结构同步在 `juzhu/mysql_schema.sql`，执行入口 `commerce/migrate.cjs`。
- 迁移带版本、校验和及数据库锁，每步可重复执行；只新增权益表，保留旧业务表。
- 审批快照不可覆盖；编辑已发布资料产生新草稿，原发布版本继续服务既有业务。
- 库存预占、产能预约、卡券冻结/核销及发放幂等使用事务；定时扫描超时预占及到期卡券。
- `sy-commerce-preview.service` 现运行 `commerce/app.cjs`，监听127.0.0.1:38780。Nginx只转发 `/api/commerce/v1/`，原账号/业务API仍走8766。
- 数据库及会话签名配置从既有宿主凭据机制加载，不写仓库和验收报告。
- 部署脚本 `node scripts/commerce/install-preview.cjs` 保留配置备份、检查健康状态，并刷新原账号API的权限目录。Nginx使用配置校验后信号重载。
- 回退不得删除业务表或恢复M0测试会话入口；应恢复上一个经过验证的M1-A代码/服务版本，数据库保持兼容。

## 可重复验收

```bash
node scripts/commerce/m1a-test.cjs --browser
node scripts/commerce/m1a-iam-regressions.cjs
node scripts/commerce/m1a-public-smoke.cjs
node test_index_boot.js
node test_static_guard.js
```

业务与浏览器验收创建独立临时MySQL数据库，结束后清理。原IAM回归另外创建独立数据库、临时数据库账号及原API进程，自动清理，避免其历史清理逻辑触及现有业务库。需要本机MySQL管理套接字权限；浏览器依赖路径可以由 `COMMERCE_PLAYWRIGHT_MODULE` / `COMMERCE_CHROME` 指定。

- [M1-A验收结果](results.json)：25项，包含实际浏览器新增→提审→不同账号复核→发布。
- [公网验收](public-results.json)：HTTPS页面/API、原账号登录接口、全部管理页面及频道入口。
- 账号回归：权限矩阵67项、登录安全25项、数据范围20项、账号中心22项均通过；权限默认值快照通过。
- 截图 `01-05` 为隔离库业务流程，`public-0..3` 为实际测试域名页面。

原M0目录是前一阶段的历史验收记录，不代表当前域名的运行模式。当前验收以本目录为准。
