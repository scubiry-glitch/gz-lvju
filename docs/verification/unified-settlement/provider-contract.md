# 机构执行契约与验收

真实执行入口是 `server/settlement/execution.cjs`，机构适配器是 `server/settlement/provider.cjs`。默认 `execution_enabled` 未设为 `true` 时拒绝产生执行请求。本文没有机构真实字段、凭据或可直接用于生产的成功码。

部署配置由共享结算工厂传入 `config`，需包含：

```js
{
  execution_enabled: false,
  lease_seconds: 60,
  poll_seconds: 30,
  provider_contracts: {
    '机构书面确认的不可变版本号': {
      enabled: false,
      verified: false,
      evidence_ref: '合同与联调验收凭据编号',
      provider: '与资金来源、账户一致的机构标识',
      environment: '与资金来源、账户一致的环境标识',
      operations: {
        // 每种操作单独核验后才配置，不能从 SPLIT 推定支持其他操作。
        // SPLIT / RETURN / PAYOUT / RELEASE
      }
    }
  }
}
```

每种操作必须具有 `amount_unit`（`minor` 或 `yuan`）、`submit`、`query` 和 `result`。`submit.method`/`query.method` 只允许已实现的 `splitApply`、`splitReturn`、`querySplitResult`、`payout`、`queryPayout`、`release`、`queryRelease`。当前 payCenter 只具备前三类方法时，推广代发及单独原款释放仍不可开启。不得以 `splitApply` 猜测代发功能；只有机构明确证明同一接口支持该资金模式时才可映射。

`submit.template` 和 `query.template` 是声明式 JSON：普通字段保留常量，`{"$ref":"request_no"}` 读取冻结的规范请求，`{"$ref":"amount_minor","$unit":"yuan"}` 将整数分精确变为元字符串，`{"$each":"lines","template":{...}}` 遍历明细，循环内用 `line.id` 等路径。没有脚本执行或表达式求值。请求规范包含：

| 字段 | 用途 |
|---|---|
| `request_no` | 本执行子单永久不变的机构幂等号 |
| `source_id` / `payment_id` | 本地资金来源、原支付 |
| `contract_no` / `source_merchant_no` / `currency` | 合同、机构付款主体、币种 |
| `amount_minor` | 所有真实资金效果合计，包括经批准的隐含商户释放 |
| `explicit_amount_minor` | 需要显式指令的明细合计 |
| `lines` | 显式指令明细；隐含 S 释放不再次发送 |
| `effects` | 全部需核验的实际效果，每行含 id、amount_minor、payee_merchant_no、effect_kind |
| `original_request_no` | 分账回退关联原机构请求号 |
| `effects[].original_provider_line_id` | 回退关联原机构成功明细凭据 |

必须核验机构的金额字段究竟指 `amount_minor` 还是 `explicit_amount_minor`。模板不能把 S、B、Q、N 同时作为同一来源扣款。隐含 S 释放的原接口若不返回可验证的逐行释放证据，不能在本实现中将该 S 标为成功，应保留未知并补充经核验的查询契约。

`result` 是返回 JSON 字段路径映射，需有 `request_no`、`contract_no`、`source_merchant_no`、`currency`、`lines`，可有 `root` 和 `provider_order_no`。`result.line` 必须映射 `id`、`amount`、`payee_merchant_no`、`currency`、`status`、`provider_line_id`。`result.statuses` 将书面核验的原状态码映射为 `SUCCEEDED`、`FAILED_FINAL`、`PROCESSING` 或 `UNKNOWN`。`FAILED_FINAL` 还必须具备严格布尔值 `no_debit=true` 与 `reservation_released=true`；否则系统仍保留未知和预占。成功必须有机构明细凭据，并逐项匹配原请求、合同、付款方、收款方、币种和金额。

账户需经双人准入，`status=approved` 或 `active`，并具备 `capabilities={operations:[...], receive:true, evidence_ref:'...'}`。`operations` 按账户实际支持的机构动作填写，不能把所有动作默认开启。业务快照 `settlement_profile` 必须固定 `version`、`contract_mapping_version`、`funding_mode`、`platform_account_id` 和 `implicit_merchant_release`。当前支持受控收款 `CONTROLLED_COLLECTION`、商户受控原款 `MERCHANT_CONTROLLED_RECEIPT`；商户已自由结算款不能通过此模块凭空回收。

开启前应取得每种操作的机构书面契约及联调证据，确认订单级/明细级幂等、结果查询、部分成功、冻结释放、有效来源与合同、资金账入账及银行卡到账的区别、回退与退款依赖。配置版本内容被改动会阻止旧请求执行/查询，必须保留旧不可变版本直到在途请求全部核清。

## 原支付必须实际进入受控账户

已批准的业务快照还需 `settlement_profile.collection`：`mapping_version`、机构实际 `contract_no`、`source_merchant_no`、`provider`、`environment`。这些值必须与准入的原款机构账户核对。公共支付 worker 读取 `config.settlement_payment_contracts`，或部署环境 `SETTLEMENT_PAYMENT_CONTRACTS` 的 JSON；按 `collection.mapping_version` 获取独立核验的收款契约：

```js
{
  enabled: false,
  verified: false,
  evidence_ref: '受控支付联调验收编号',
  provider: '机构标识',
  environment: '机构环境',
  funding_modes: ['CONTROLLED_COLLECTION'],
  request_template: {
    recAndShareInfo: {
      merchantNo: {$ref: 'collection.source_merchant_no'},
      shareOrderMode: '必须替换为机构书面核验值',
      shareOrderInfos: [{
        merchantNo: {$ref: 'collection.source_merchant_no'},
        amount: {$ref: 'amount_yuan'},
        shareBizCode: {$ref: 'base.shareBizCode'}
      }]
    },
    contractInfo: {
      contractNo: {$ref: 'collection.contract_no'},
      contractAmount: {$ref: 'amount_yuan'}
    }
  },
  result: {
    contract_no: '机构查单返回的实际合同字段路径',
    source_merchant_no: '机构查单返回的受控收款商户字段路径',
    control_status: '机构查单返回的资金控制状态字段路径',
    controlled_values: ['必须替换为机构书面核验的受控值']
  }
}
```

上述示例始终关闭。系统不推断 `shareOrderMode=0` 表示受控、不把业务订单号当真实合同号。有结算快照却缺少获准收款映射时，在标记发送之前阻断。请求与契约 hash 持久保存在支付作业中；成功查单必须同时证明原合同、原账户和受控状态。没有结算快照的历史收银台行为保持原接口契约。

公共 `paymentCore.requestRefund` 也检查同一 funding source，避免旧退款入口绕过分账预占。普通退款扣除已清偿、分账预占、其他在途退款和未镜像成功退款；执行退款必须精确关联已双人批准、已预占、同原支付、同金额和同请求号的退款计划。受控支付已接受而资金来源尚未登记时，商业退款等待业务到账事件；系统对未接受的迟到、多付支付仍按原支付退款。

worker 通过 `runJobs({limit})` 拉取持久作业，领取短租约后提交数据库事务，再调用机构。请求一旦记录 `submitted_at`，恢复只查询原号；网络超时、不存在、返回不匹配均不释放预占。各成功/最终未扣款明细独立结转，`PARTIAL` 不会整体重发。暂停新增执行仍允许历史查询；未发送的 READY 在写发送标记前再次检查开关。消费者退款交给统一 paymentCore 的持久退款入口，不在执行模块重复记录其现金账。数据库会话使用 UTC。

隔离测试只有 `server/test/settlement_execution_test.cjs` 注入模拟机构，不存在运行时模拟付款开关。测试需要明确 `/tmp` 本地 MySQL socket，创建并销毁唯一临时库：

```sh
SETTLEMENT_TEST_SOCKET=/tmp/sy-settlement-实例/mysql.sock \
  node --test server/test/settlement_execution_test.cjs
```

覆盖关闭能力、跨域权限、金额凭据不符、并发防重、网络调用期间无数据库锁、超时查询、部分成功、B 到账再 Q、隐含 S 授权和付款时间、分账回退累积额度、逆向双人审核、退款依赖、共同退款来源镜像及退票历史保留。

退票核验只追加 `RETURNED` 事件并生成独立 `DRAFT` 重付组件，返回 `repayment_item_id`；原出款成功、历史清偿及原机构凭据不改写。重付组件重新确认账户、金额和时间后走普通审批。业务补差须为 `supplement:` 组件，并来自另行复核的 `platform_own` / `supplement` 资金来源，走已核验的 `PAYOUT`；普通 Q 仍必须使用所属 B 的实收佣金 lot。

共享误核销撤销由原 `commerce/settlement.cjs` 审核入口转入 `server/settlement/reversal.cjs`。在途资金必须先核清；待付余额取消并撤销授权/审批，已成功付款保留原清偿历史，逐原机构行建立追偿。原核销及相关经济调额只反记一次。B 在平台与原款之间的返还记录为 `INTERNAL_RETURN`，不会制造对平台自身的外部应收。S/Q 受益人追偿按 `settlement_recovery:{原执行行}` 记账，回收只随真实机构回退或已独立核验银行退票入账。撤销后迟到退票冲原追偿，不产生重付义务；卡券重核销使用新单位版本，保留原单位历史。

消费者退款还受经济义务约束：确认履约单位的 S+B 尚未撤销时，即使机构余额尚未实际付款也不能用于消费者退款；已成功及在途退款均计入累计额度。固定成本模式另有合同保留用途的余额按原合同可用额度处理。
