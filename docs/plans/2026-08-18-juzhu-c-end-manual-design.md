# C 端联调测试手册 设计文档

- 日期：2026-08-18
- 产出物：根目录《C端联调测试手册.md》
- 受众：GR 侧 C 端测试人员（产品/测试/开发），**不含任何后台操作**

## 背景与分工

已有《联调手册.md》（GR 内部商家联调：SQL 配置/接口测试/日志排查）与 api_doc.md（商家侧协议）。
缺一份纯 C 端视角的走查手册：页面流程、下单跳小程序、订单状态核对，以及与来来同事的配合话术。

## 关键决策

| 决策点 | 结论 | 依据 |
|--------|------|------|
| 文件位置 | 根目录《C端联调测试手册.md》 | 与《联调手册.md》并列，命名风格一致（用户确认） |
| 来来配合方式 | 可直接复制的话术模板 + 信息清单 | 用户确认 |
| 订单状态深度 | 完整状态用例表（每状态：来来动作/必带信息/列表预期/详情预期）+ 验收清单 | 用户确认 |
| 禁止微信内打开 | 提醒二：weixin:// 协议跳转被微信内建浏览器拦截，须系统浏览器 | 用户需求 + api_doc.md 5.1 响应格式 |
| 模拟用户共享订单 | 提醒一置顶加粗：user_id 固定 demo_user_001，首页每次加载强制重置（index.html 内联脚本），所有人订单互相可见，属预期行为非 bug；附 setUserId 隔离方法及"回首页即重置"的坑 | 用户明确要求显著提醒 |
| 商品核对入口（增补 2026-08-18） | 第 2 章新增 2.1 节：来来建品后测试人员在 screens/p-jz-product.html 核对字段（商家/城市/SPU 关联/上架状态/价格/path+query 非空）；该页 GET 查询公开无需凭证，写操作需 API Key（提示勿点） | 用户要求；页面代码核验（fetch /api/juzhu/jz/* GET 走 _public_get 无鉴权） |

## 内容结构

特别提醒（模拟用户/浏览器要求，置顶）→ 1 测试前准备 → 2 前置条件核对（话术①创建商品）→ 3 页面全流程（首页/列表/详情/下单跳转）→ 4 订单状态联调（话术②推单 + 状态用例表）→ 5 注意事项 → 6 验收清单。

## 事实来源（全部经代码核验）

- 页面链路：index.html（三专区/四类目/订单栏角标/citySheet 城市切换）→ juzhu-jiazheng-list.html（?type=/子类筛选）→ juzhu-jiazheng-detail.html（多商家比价/同商家多规格/wechat-link 下单 → window.location.href = url_link）→ 来来小程序
- 订单：juzhu-jiazheng-orders.html（5 tab 无"已取消"、金额分转元、订单号后 6 位）、juzhu-jiazheng-order-detail.html（5 步步骤条/cancelled 红条/vendor-detail 静默覆盖 status/fee/worker/cancel_reason）
- pending 不可见：gr_orders.list_user_orders 过滤 `status != 'pending'`
- user_id：screens/_jzapi.js `jz_demo_user_id` + `demo_user_001`；index.html 加载时 `BZF_JZ.setUserId('demo_user_001')` 强制重置
- 状态机与必带字段：jiazheng_api.py 回调校验（paid+fee / assigned+worker / cancelled+cancel_reason）

## 明确不写

后台 SQL/日志/接口协议细节（指向《联调手册.md》与 api_doc.md）。
