# 会员中心、选券与兑换验收（2026-09-19）

## 页面

- 首页：`/juzhu-commerce.html?city=贵阳`，仅保留 2 个精选券包。
- 选券：`/juzhu-vouchers.html?city=贵阳`，独立页面，单品券/券包切换、关键词和分类筛选。
- 会员：`/juzhu-commerce.html?view=memberships&city=贵阳`，深绿金色卡面、赠券数量及期限、展开使用条件、会员记录、我的卡券入口。
- 我的：`/juzhu-commerce.html?view=account&city=贵阳`，新增兑换码兑换。
- 底部统一为首页 / 选券 / 会员 / 我的；用户页隐藏退出。

## 兑换和核销

后台券商品、券包配置、会员方案中，已发布的演示商品提供“生成兑换码”。兑换码有效期为 1～90 天，单码单次兑换；不写入操作审计明文。运营发码请求支持幂等重试，商品版本变更后旧码拒绝兑换。

兑换事务锁定兑换码，校验有效期、商品状态与演示标记，然后在同一事务内扣减库存、生成主站订单、发券和开通会员。异常全部回滚。当前依照无资金联调约定，仅测试环境且仅演示商品开放，实际支付与佣金始终为零。

核销二维码在本地生成，内容 `NLV1:<券编号>:<动态码>`，2 分钟有效。支持复制券编号和动态码、过期遮蔽和刷新。门店可使用扫码枪粘贴识别结果；支持 BarcodeDetector 的浏览器可直接摄像头扫码，不支持时明确提供手动录入方式。仍校验原有门店人员权限、本人卡券、当日预约、有效期、重复核销与退款互斥。

## 验证入口

- `node scripts/commerce/m1a-test.cjs --guiyang-demo --browser`：独立数据库、三类兑换、权限/城市隔离、幂等/并发/过期/库存回滚、主站订单、会员与选券布局、二维码真实解码、剪贴板、商户识别、过期刷新。
- `node scripts/commerce/m1a-iam-regressions.cjs`：主站 IAM 与权限注册回归。
- `node scripts/commerce/m1a-public-smoke.cjs`：测试站只读回归。
- 二维码解码测试依赖 `/tmp/commerce-qr-test/node_modules/jsqr`，可用 `npm install --prefix /tmp/commerce-qr-test --no-audit --no-fund jsqr` 安装；生产页面复用站内 MIT 许可 `_qr.js`，不请求第三方二维码服务。

截图为隔离验收账号生成；其中的兑换码、券编号和动态码不对应线上可用权益。

## 完成结果

- 隔离数据库与浏览器：39 项通过。
- IAM 回归：136 项通过。
- 线上只读回归：16 项通过；独立选券页 HTTP 200。
- 静态入口、首页启动检查和差异空白检查通过。
- 已应用迁移 `002_exchange_codes` 并更新 sytest 服务。二维码截图和 320/390/430/1440 宽度会员截图存于本目录。

## 2026-09-21 视觉精修

- 会员首屏增加赠券数量、权益项数和使用方式摘要，压缩卡面和标题留白；开通栏不再覆盖权益内容。
- 首页及选券商品卡将长说明截短为两行，保留名称、核心摘要、有效期、数量和价格。
- 消费者端主要按钮、筛选控件和登录按钮统一为不低于 44px 的触控高度；“我的”页改为三列网格，避免登录按钮挤压昵称。
- 卡券列表增加状态样式、摘要、到期／服务日期／金额元数据和紧凑操作区；完整编号仍在详情页保留。
- 核销弹窗将倒计时和刷新按钮置于二维码下方固定区域，过期二维码保持尺寸并给出刷新指引；提交操作显示“提交中…”，成功/失败反馈使用就近 Toast。
- 加载过程中保留页面布局并显示更新遮罩，尊重 `prefers-reduced-motion`。

本轮截图：`visual-home-390.png`、`visual-home-products-390.png`、`visual-shop-390.png`、`visual-membership-390.png`、`visual-account-390.png`。浏览器检查覆盖 390px 首页、选券、会员和我的页面；均无横向溢出、无页面错误，选券按钮和筛选控件实测 44px。

视觉专项脚本：`node scripts/commerce/consumer-visual-polish-audit.cjs`，7/7 通过，零页面错误、未产生业务数据变更；结果与会员/我的截图见 `consumer-visual-polish-audit.json`、`visual-polish-membership-390.png` 和 `visual-polish-account-390.png`。当前 sytest 贵阳公开目录实测为 49 张单品券、10 个券包和 1 个会员方案，其中 47/7/1 为可演示购买商品；另有 2 张单品券和 3 个券包是结算演示夹具，购买入口关闭。

- 卡券钱包专项：`node scripts/commerce/consumer-wallet-visual-audit.cjs`，4/4 通过；覆盖 320/390px 下可用、线上核销、已核销、已过期、售后冻结五种状态，主操作门控、编号复制和二维码失效布局，截图为 `wallet-mock-320.png`、`wallet-mock-390.png`、`wallet-qr-expired-320.png`、`wallet-qr-expired-390.png`。
- 反馈专项：`node scripts/commerce/consumer-feedback-audit.cjs`，4/4 通过；覆盖重复提交拦截、提交中/失败恢复、业务成功文案、Toast 视口位置、`prefers-reduced-motion` 及管理/推广端兼容，无真实写入。
