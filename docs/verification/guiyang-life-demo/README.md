# 贵阳生活权益演示与主站复用验收

更新：2026-09-19。分支：`plan/newliving-coupons-membership-v1.9`。

## 已交付

- 用户端沿用全站米白、墨绿、金色与宋体标题；生活封面、专题、会员入口、底部导航。
- 权益区改为紧凑商品列表，支持单品券、券包、会员切换，关键词搜索和服务分类筛选。
- 商品独立详情：`juzhu-voucher.html?kind=skus|packages|plans&id=...&city=贵阳`；本人卡券独立详情：`juzhu-voucher.html?coupon=...`。
- 会员提供独立介绍、购买确认及到账流程；演示会员有效期365天，赠送五张独立90天有效的卡券。
- 贵阳12个频道、46项既有服务均补齐城市商品和详情；新增12家演示商户、12个门店、12位演示服务者、38种单品券、5个专题券包及1个会员礼包、1个会员方案。
- 咨询、估价、保险及金融入口保持原服务类型，不把它们包装成普通付费服务券；虚构商户与服务均标注演示。

## 订单与工单复用

- 购买在同一事务中写入主站 `gr_orders`；主站「我的订单」及订单详情展示该记录。`commerce_orders` 保留发券所需的权益快照扩展，使用相同订单号。
- 主站订单接口使用 `source=account` 从真实账号会话推导本人订单命名空间；匿名及其他账号不能通过猜测 `user_id` 读取订单。
- 售后在同一事务中写入主站 `jz_orders`，复用原有P/B/S工单列表、派单、处理与进度页面；`commerce_cases` 保留券冻结及退款状态关联。
- 主站处理完成后同步权益售后结果；权益管理端结单也同步主站工单状态。
- 售后工单为 `pay_status=not_required`，进入现有工单池，无需支付；前端不出现付款入口，后端支付接口拒绝处理此类工单。
- 已有2笔线上演示权益订单已幂等关联主站，未改变金额、未生成资金交易。新增订单自动关联。

## 无资金边界

`/demo-orders` 仅在测试环境启用，要求有效个人账号、明确演示确认、已发布演示商品和匹配版本。金额仅供展示，实际扣款、佣金及结算均为0；不调用支付适配器，不伪造支付流水。普通 `/orders` 真实购买仍关闭。

## 验证与运行

- `node scripts/commerce/m1a-test.cjs --guiyang-demo --browser`：32项通过；隔离MySQL及浏览器覆盖发券、库存、幂等、会员购买、独立详情、账户与城市隔离等。
- `node scripts/commerce/m1a-iam-regressions.cjs --main-reuse`：隔离主站订单、工单、派单推进、免支付保护与浏览器页面检查；结果见 `main-reuse-results.json`。
- `node scripts/commerce/m1a-iam-regressions.cjs`：权限注册2项、权限闸67项、认证安全25项、范围20项、IAM22项通过。
- `node scripts/commerce/m1a-public-smoke.cjs`：只读公开站点检查；结果见相邻 `newliving-commerce-m1a/public-results.json`。
- `node test_static_guard.js` 与 `node test_index_boot.js` 通过。

初始化脚本 `seed-guiyang-demo.cjs --apply` 幂等，仅创建本批次缺项，保留已编辑记录和库存。`link-main-systems.cjs` 幂等补齐历史主站关联。凭据只从宿主环境加载，文档和验收产物不保存凭据。

## 入口

- 贵阳权益：`https://sytest.meizu.life/juzhu-commerce.html?city=贵阳`
- 贵阳单品券：`https://sytest.meizu.life/juzhu-commerce.html?city=贵阳&kind=skus`
- 主站订单：`https://sytest.meizu.life/juzhu-jiazheng-orders.html`
- 主站工单池：`https://sytest.meizu.life/screens/p-service-demand.html`

封面图片复用仓库已有居家照片，压缩为39KB WebP。消费端HTML由 `scripts/commerce/consumer-page.html` 生成；再运行页面生成器不会覆盖本次改版。

后续会员中心、独立选券、兑换码与二维码核销更新，参见 [验收说明](../member-wallet/README.md)。
