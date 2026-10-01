# 权益 C 端 · 消费者视角验收截图说明

目录内 9 张截图为**新居住生活权益 C 端**的响应式与关键视图留档，对应
[GOAL-新居住权益闭环验收](../../prd/GOAL-新居住权益闭环验收.md) AC14（关键移动页 390px /
桌面 1440px 无横向溢出或遮挡；正常 / 空 / 错误状态可验证）的浏览器检查证据。

## 截图清单

| 文件 | 内容 |
|---|---|
| `home-320.png` / `home-390.png` / `home-430.png` / `home-1440.png` | `juzhu-commerce.html` 生活权益首页四档宽度（320 / 390 / 430 / 1440） |
| `home-bottom-390.png` | 首页 390px 底部 tab 区（首页 / 选券 / 会员 / 我的） |
| `coupons-390.png` | 我的卡券视图 390px（含状态筛选 chips） |
| `memberships-390.png` | 会员视图 390px（会员卡面 + 我的会员记录） |
| `account-390.png` | 我的视图 390px（登录态 / 卡券预约售后入口） |
| `error-390.png` | 接口失败态 390px（空态 + 错误提示可见） |

## 口径与局限

- 采集环境为 sytest 预览（无资金演示口径），数据来自 `guiyang-demo` 演示种子。
- 本目录**只覆盖 C 端**；结算 / 酒店通兑 / 运行验收证据分别在
  `newliving-commerce-settlement/`、`hotel-exchange-closed-loop/`、`newliving-commerce-m1a4/`。
- 截图为静态留档，复跑方式与断言口径见仓库根 `test_index_boot.js`、`test_static_guard.js`
  与 `/tmp/e2e` playwright-core harness（MCP browser 缺 Chromium 不可用）。
