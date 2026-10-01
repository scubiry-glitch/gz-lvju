# 结算测试数据与全流程走查

**测试站实际走查已通过。** 2026-10-02 04:09—04:10（UTC+8）完成 9 组真实 HTTP 与浏览器检查，记录 41 个业务接口请求、8 张截图和 CSV、XLSX、PDF 三份下载文件；04:15—04:15 补齐中文状态后，再次只读检查 4 组并重拍 5 张页面截图。详见[完整走查结果](results.json)、[最终只读复查](readonly-results.json)和[种子清单](seed.json)。

这些场景写入测试库，页面通过真实账号、权限、HTTP 接口、审批记录、执行任务和版本账单访问数据。资金机构使用后端专用 `SYTEST_MOCK / SANDBOX` 适配器；模拟凭证、来源和账户均标记为 `settlement-walkthrough-v1`，不关联真实支付，也不向真实机构发送资金指令。页面不加载前端假数据或替换接口结果。

测试站入口：

- [统一结算工作台](https://sytest.meizu.life/screens/settlement-admin.html)
- [收款方对账单](https://sytest.meizu.life/screens/settlement-statements.html)

## 账号与主体范围

账号在账号中心持久化，使用独立的 `settlement_demo_*` 角色。种子不赋予通配权限，不重置已有账号密码；若已有同名账号或角色与本批定义不符，停止初始化。

| 角色 | 登录名 | 主要操作 | 可见主体 |
| --- | --- | --- | --- |
| 财务经办 | `settlement_demo_operator` | 查看应结、调整付款安排、发起执行、配置规则与准入资料、导入外部凭证、生成账单 | 本批七个结算主体 |
| 财务复核 | `settlement_demo_reviewer` | 审批应结与赔付、复核账户和规则、核验外部凭证、处理账单异议 | 本批七个结算主体 |
| 资金复核 | `settlement_demo_reviewer2` | 第二位独立审批人，完成会签节点 | 本批七个结算主体 |
| 商家财务 | `settlement_demo_merchant` | 查看、下载、确认账单及提出异议，提交外部对账资料 | 明净保洁、安心搬家、邻里权益、悦享家外部商户 |
| 推广渠道 | `settlement_demo_promoter` | 查看、下载、确认推广账单及提出异议 | 社区推荐官渠道 |
| 平台财务 | `settlement_demo_platform` | 查看、下载、确认平台账单及提出异议 | 新居住平台结算主体 |

七个主体标识为 `demo-cleaning`、`demo-moving`、`demo-rights`、`demo-external`、`demo-promoter`、`demo-platform`、`demo-customer`。页面使用已准入账户和协议中的中文名称显示主体；实际账号 ID、主体范围和业务记录 ID 以 `seed.json` 为准。商家报送权限不能核验资料，申请人与复核人分别操作。

本批数据可继续操作。指定的“结果未知”执行单在本次走查中已沿原请求号查询为 `SUCCEEDED`；单笔金额、时间、账户调整已由另一账号批准，后续仍可发起新的调整。商户专用补证订单已核验为 268 元。重复运行种子会保留这些变化及其他账号的操作，不会恢复初始状态。

凭据保存在宿主私有文件 `/root/.config/sy-settlement-walkthrough/credentials.json`。本文、仓库、种子清单和验证报告均不记录密码或会话 token；脚本仅在执行时使用宿主文件或已注入的密码环境变量。

## 场景矩阵与核对口径

| 场景 | 业务与入口 | 应观察到的状态或关系 |
| --- | --- | --- |
| 保洁完整结算 | `DEMO-CLEAN-PAID`，应结与付款 | 商户收款、平台佣金划转、推广二次付款均有独立成功记录；推广使用平台佣金实际到账资金 |
| 分次付款 | `DEMO-CLEAN-INSTALLMENT` | 顾客支付 680 元，10% 佣金下商户应结 612 元；本次先付 200 元，商户剩余应结 412 元 |
| 结果未知 | `DEMO-CLEAN-UNKNOWN`，详情中的“查询机构结果” | 查询沿用原机构请求号；确认结果后更新原执行单，不创建第二张付款单 |
| 约定付款时间 | `DEMO-CLEAN-SCHEDULED` | 尚未到 2026-10-20 的约定付款时间，不能提前出款 |
| 售后争议 | `DEMO-CLEAN-DISPUTE` | 售后暂缓申请保留独立待复核记录，不将争议直接记为已付或减免 |
| 单笔调整 | `DEMO-CLEAN-ADJUSTMENT` | 同时修改本次付款金额、时间和同主体已批准账户；预览后申请，由另一账号审批，总应付不变 |
| 多级审核与会签 | `DEMO-MOVING-REVIEW`，审批待办 | 先完成业务履约复核，再由财务复核与资金复核共同完成会签 |
| 机构明确失败 | `DEMO-MOVING-FAILED` | 保留原失败结果；后续付款需重新授权，不把失败记为到账 |
| 权益结算 | `DEMO-RIGHTS-PAID`、`AUTHORIZED`、`PARTIAL`、`PENDING` | 覆盖已付、已授权待执行、部分成功和待申请；部分成功不整体重发 |
| 补差与赔付 | “补差与赔付”页签 | 独立自有资金入账 500 元；赔付 100 元，银行退票 20 元后净赔付 80 元，追偿金额随真实净付款计算；另有 30 元待复核赔付 |
| 外部订单资料不全 | `DEMO-EXT-PENDING`、`DEMO-EXT-UNKNOWN` | 外部付款尚未核验或金额未知仍进入账单覆盖清单；未知金额不按零元计入 |
| 专用商户补证走查 | `DEMO-EXT-WALKTHROUGH` | 对同号未知金额候选补报 268 元并独立核验；只补齐该专用订单，不向已收款订单重复添加支付 |
| 外部佣金与部分退款 | `DEMO-EXT-PAID`，双方对账单 | 合同应计、退款冲减、实际收到佣金分别记账；保留补证前后账单版本 |
| 三方账单与异议 | 收款方对账单 | 商家、推广、平台只能看获授权主体；账单可确认或提出异议，下载 CSV、XLSX、PDF 时再次校验权限 |

外部示例的金额均按整数分计算：顾客支付 `20000` 分，按 10% 应计佣金 `2000` 分；顾客退款 `5000` 分对应冲减佣金 `500` 分；平台已实际收到佣金 `1200` 分。因此：

```text
佣金未收 = 2000 - 500 - 1200 = 300 分 = 3.00 元
```

平台账单显示佣金应收与未收，外部商家账单显示同一笔佣金应付与未付。顾客消费额 200 元、佣金应计 20 元和佣金实收 12 元是不同事实。商户补证使用另一笔专用订单：未知金额候选与补报凭证共享同一外部交易号，核验后确认 268 元；原 3 元佣金余额示例保持不变。历史账单不会被原地覆盖。

## 种子、状态和只读检查

以下命令均在仓库根目录运行。数据库凭据沿用宿主配置机制；本测试站实际服务库为 `juzhu`，不覆盖数据库名。测试站写入命令显式指定 `--target sytest` 和站点来源，脚本也校验宿主配置及 `JUZHU_ENV=test`；`SETTLEMENT_DEMO_PASSWORD` 由宿主执行环境注入，不将其值写入命令、文档或日志。

初始化持久化场景并导出不含凭据的清单：

```sh
JUZHU_ENV=test COMMERCE_PUBLIC_ORIGIN=https://sytest.meizu.life \
node scripts/settlement/demo-seed.cjs seed --target sytest \
  > docs/verification/settlement-walkthrough/seed.json
```

同批种子已为 `READY` 时返回原清单，不清空走查后的状态，不重复创建资金来源或付款。读取当前种子状态：

```sh
JUZHU_ENV=test COMMERCE_PUBLIC_ORIGIN=https://sytest.meizu.life \
node scripts/settlement/demo-seed.cjs status
```

仅检查本批走查数据的账务不变量：

```sh
JUZHU_ENV=test COMMERCE_PUBLIC_ORIGIN=https://sytest.meizu.life \
node scripts/settlement/verify-walkthrough.cjs --target sytest
```

只校验清单格式和操作范围，不连接站点：

```sh
node scripts/settlement/demo-live-walkthrough.cjs \
  --origin https://sytest.meizu.life \
  --manifest docs/verification/settlement-walkthrough/seed.json \
  --validate-only
```

读取真实 HTTP 页面、角色范围及场景数据，保存桌面和手机截图：

```sh
node scripts/settlement/demo-live-walkthrough.cjs \
  --origin https://sytest.meizu.life \
  --manifest docs/verification/settlement-walkthrough/seed.json \
  --credentials /root/.config/sy-settlement-walkthrough/credentials.json \
  --output /root/.config/sy-settlement-walkthrough/live-readonly \
  --read-only
```

`--read-only` 会登录取得会话并查询业务数据，不提交改单、审批、凭证或导出任务。脚本拒绝未经显式指定的站点，只允许本地环回地址和指定测试站。

隔离库初始化用于先验证种子代码，需明确提供 `/tmp` 下的独立 MySQL socket：

```sh
SETTLEMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
node scripts/settlement/demo-seed.cjs seed --isolated \
  --database settlement_seed_walkthrough

SETTLEMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
node scripts/settlement/demo-seed.cjs status --isolated \
  --database settlement_seed_walkthrough
```

## 真实 HTTP 与浏览器全流程

测试站后台需启用本批模拟机构和报表任务：`JUZHU_ENV=test`、`SETTLEMENT_DEMO_ENABLED=1`、`SETTLEMENT_REPORTS_ENABLED=1`。真实机构付款开关保持关闭。模拟机构入口还会核对上下文、资金来源、账户、环境及批次标记；不能仅凭 URL 或普通账号权限选择模拟付款。

完整走查命令会修改清单关联的测试业务记录：

```sh
node scripts/settlement/demo-live-walkthrough.cjs \
  --origin https://sytest.meizu.life \
  --manifest docs/verification/settlement-walkthrough/seed.json \
  --credentials /root/.config/sy-settlement-walkthrough/credentials.json \
  --output /root/.config/sy-settlement-walkthrough/live
```

脚本验证以下过程：

1. 六个真实账号登录；页面各管理页签有持久化数据，返回主体不超出清单范围。
2. 经办在页面预览并提交金额、付款时间、收款账户调整；复核账号完成独立审批，核对总应付不变及审批留痕。
3. 使用原请求体和原 `Idempotency-Key` 重放调整，不产生第二条调整。
4. 对指定未知执行单发起查询，等待原单结果，核对原机构请求号和执行单集合不变。
5. 商户补充外部付款凭证，财务复核核验金额、币种、时间和原业务归属。
6. 商家、推广、平台分别读取自己的账单，并验证访问其他主体账单被拒绝。
7. 等待真实导出任务完成，通过浏览器下载 CSV、XLSX、PDF，检查非空内容及文件格式；保存手机截图并检查页面无横向溢出。

脚本只允许清单中的业务记录及由这些记录产生的审批、凭证、导出任务发生写入；浏览器未声明的写请求会被阻止。私有输出目录保存 `walkthrough-state.json`，记录请求体、幂等键及结果，支持断点重放；不保存密码或会话 token。输出还包括 `results.json`、桌面/手机截图和三种格式的下载文件。

当前页面尚无独立的回退/退款计划、外部覆盖范围、佣金应计登记总入口；这些接口的自动化和模块验证见[统一结算验收说明](../unified-settlement/README.md)。本脚本只声明其实际覆盖的页面与操作。

## 验证结果

| 验证项目 | 当前状态 | 证据 |
| --- | --- | --- |
| 走查脚本语法与纯本地范围校验 | 已通过 | 未连接 HTTP、未启动浏览器的脚本检查 |
| 结算后端隔离回归 | 90 项通过，0 失败、0 跳过 | [隔离回归记录](regression.json) |
| 既有结算兼容回归 | 19 项通过 | [隔离回归记录](regression.json) |
| 页面本地接口夹具回归 | 27 项通过；中文状态更新后重跑通过 | [隔离回归记录](regression.json)，含非 JSON 错误和越权交互检查 |
| 既有支付迁移兼容 | 1 项通过 | [隔离回归记录](regression.json) |
| 测试站持久化种子 | 17 个场景上下文、38 条应结、12 个初始账单版本 | [种子清单](seed.json) |
| 同批种子重放 | 保留相同清单及现有业务状态 | [幂等初始化记录](idempotency.json) |
| 测试站真实 HTTP 和浏览器全流程 | **9 组通过**，三种账单实际下载 | [完整结果](results.json) |
| 中文状态更新后的最终页面 | **4 组只读复查通过**，手机无页面横向溢出 | [只读结果](readonly-results.json) |
| 走查后账务不变量 | 通过，无不一致项 | [走查前](invariants-before.json)、[走查后](invariants-after.json) |
| 真实支付隔离与导出结果 | 本批真实支付相关记录均为 0；三种导出均为 `READY` | [支付隔离及导出记录](payment-isolation.json) |

走查后快照为 17 个场景上下文、38 条应结、41 个账务事件、11 张执行单和 18 个账单版本。账单定时任务已在 12 个初始版本上生成后续版本；同批数据也有其他账号继续发起审批，均保留现状。具体状态以证据文件及其时间为准，后续操作可继续改变数量和状态。

最终页面：[工作台](images/final/01-admin-items.png)、[商家账单](images/final/04-statements-merchant.png)、[推广账单](images/final/04-statements-promoter.png)、[平台账单](images/final/04-statements-platform.png)、[手机账单](images/final/06-statements-mobile.png)。操作留痕：[调整预览](images/live/02-adjustment-preview.png)、[独立审批](images/live/03-reviewer-approval.png)、[账单详情及下载](images/live/05-statement-detail-downloads.png)。

实际下载样例：[CSV](downloads/statement-csv.csv)、[XLSX](downloads/statement-xlsx.xlsx)、[PDF](downloads/statement-pdf.pdf)。报告记录各文件的长度和 SHA-256。公开产物仅包含本批测试业务与经过筛选的请求状态；凭据和包含幂等键的私有走查日志不归档到仓库。


民宿预订也已接入共享系统，离店后 N 天可在结算规则配置；持久化场景、渠道佣金与验证记录见 [民宿结算走查](booking.md)。
