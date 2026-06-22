# 保租房专用频道（南京试点 → 江苏全省）

> 建立江苏省住房运营基础设施 —— 政府认证、统一入口、标准落地、数据回流的"四方共建"长租平台。

**合作四方**：江苏住建厅 × 江苏银行 × 国企持有方（+ 白名单运营商：自如/龙湖/华润/招商/贝壳省心租 等同业）× 贝壳租房
**地域**：南京试点 3-5 个样板项目（0-12 月）→ 试点验证后向南京 46 个项目 + 全省 13 市推进（推广目标，非时间承诺）

---

## 📄 主文档

| 文档 | 用途 |
|---|---|
| [PRD V1.0](PRD-保租房专用频道-V1.0.md) | 完整产品需求文档 + 开发计划（15 章节，含 Mermaid 图） |
| [三档总入口](baozufang-channel-overview.html) | 版本选择器 + 能力对照表 |
| [总体图谱（PNG）](20260605_192600.png) | 四方共建 × 五大能力 × 三阶段路径 |

---

## 🎯 三档版本（点击进入对应总览）

| 版本 | 定位 | 页面数 | 上线周期 | 入口 |
|---|---|---|---|---|
| **V1 · 仅展示** | 信息门户型 · 0 资金风险 | 4 | 4-6 周 | [v1-basic.html](baozufang-overview-v1-basic.html) |
| **V2 · + 标准体系** | 展示 + 好房子标准公示 | 7 | 6-9 周（增量） | [v2-standard.html](baozufang-overview-v2-standard.html) |
| **V3 · + 交易闭环** | 端到端一站式办理 · 全四端 | 28 | 14-18 周（增量） | [v3-full.html](baozufang-overview-v3-full.html) |

---

## 📱 28 页 · 四端导航

### C 端 · 租客（16 页）

| # | 页面 | 链接 | 版本 | 状态 |
|---|---|---|---|---|
| C-01 | 频道首页 | [home](screens/home.html) · [index](index.html) | V1+ | ✅ |
| C-02 | 房源详情 | [detail](screens/detail.html) | V1+ | ✅ |
| C-03 | 政策资讯 | [policy](screens/policy.html) | V1+ | ✅ |
| C-04 | 个人中心 | [profile](screens/profile.html) | V1+ | ✅ |
| C-05 | 申请 / 资格 | [apply](screens/apply.html) | V3 | ✅ |
| C-06 | 我的申请 | [my-applications](screens/my-applications.html) | V3 | ✅ |
| C-07 | 电子合同 | [contracts](screens/contracts.html) | V3 | ✅ |
| C-08 | 在线缴费 | [payment](screens/payment.html) | V3 | ✅ |
| C-09 | 报修服务 | [repair](screens/repair.html) | V3 | ✅ |
| C-10 | 运营白名单 | [operators](screens/operators.html) | V2+ | ✅ |
| C-11 | 服务者认证 | [service-workers](screens/service-workers.html) | V2+ | ✅ |
| C-12 | 合格供应商（V2 扩 6 品类 + 物资徽章） | [suppliers](screens/suppliers.html) | V2+ | ✅ |
| C-13 | 公积金直付申请 | [c-housing-fund](screens/c-housing-fund.html) | V3 | 🟡 待建 |
| C-14 | 房源对比 | [c-compare](screens/c-compare.html) | V2 | 🟡 待建 |
| C-15 | 客群分流首页 | [c-persona-home](screens/c-persona-home.html) | V2 | 🟡 待建 |
| C-16 | 租金合规说明 | [c-rent-compliance](screens/c-rent-compliance.html) | V1+ | 🟡 待建 |

### B 端 · 国企持有方（资管视角）+ 白名单运营商（运营动作）+ 业主（4 页）

| # | 页面 | 链接 | 使用方 | 版本 | 状态 |
|---|---|---|---|---|---|
| B-01 | 业主托管 | [landlord](screens/landlord.html) | 个人业主 | V2+ | ✅ |
| B-02 | 资管大盘（入住率/收入/运营商绩效） | [b-operator-console](screens/b-operator-console.html) | **国企持有方** | V3 | 🟡 待建 |
| B-03 | 房源上下架管理 | [b-listing-mgmt](screens/b-listing-mgmt.html) | **白名单运营商**（国企只读） | V3 | 🟡 待建 |
| B-04 | 工单分派 / 入住率看板 | [b-occupancy](screens/b-occupancy.html) | **白名单运营商**（国企只读 SLA） | V3 | 🟡 待建 |

### G 端 · 住建厅监管（4 页）

| # | 页面 | 链接 | 版本 | 状态 |
|---|---|---|---|---|
| G-01 | 政府监管视图 | [gov-admin](screens/gov-admin.html) | V2+ | ✅ |
| G-02 | 监管数据大屏 | [g-dashboard](screens/g-dashboard.html) | V3 | 🟡 待建 |
| G-03 | 租金合规预警 | [g-rent-alert](screens/g-rent-alert.html) | V3 | 🟡 待建 |
| G-04 | 白名单审核 | [g-whitelist-review](screens/g-whitelist-review.html) | V2 | 🟡 待建 |

### 金融端 · 江苏银行（3 页）

| # | 页面 | 链接 | 版本 | 状态 |
|---|---|---|---|---|
| F-01 | 监管账户对账 | [f-escrow](screens/f-escrow.html) | V3 | 🟡 待建 |
| F-02 | 公积金直付通道 | [f-housing-fund](screens/f-housing-fund.html) | V3 | 🟡 待建 |
| F-03 | 资金流水大盘 | [f-treasury](screens/f-treasury.html) | V3 | 🟡 待建 |

### 系统 / 接口（1 页）

| # | 页面 | 链接 | 状态 |
|---|---|---|---|
| S-01 | 房源接入 API 文档 | [property-intake-api](screens/property-intake-api.html) | ✅ |

**汇总**：已建 15 页 + 待建 stub 13 页 = **28 页**

---

## 📚 参考资料

- [`江苏租赁行业标准_V25.docx`](江苏租赁行业标准_V25.docx) — 江苏省住建厅标准依据
- [`mq0n1457-保租房专用频道2026.6.3.doc`](mq0n1457-保租房专用频道2026.6.3.doc) — 项目方案文档
- [`mq0pq2pl-_好房子_标准提案-.xlsx`](mq0pq2pl-_好房子_标准提案-.xlsx) — 好房子 58 项评星细则
- [`20260605_192600.png`](20260605_192600.png) / [`20260605_223100.png`](20260605_223100.png) — 总体图谱

---

## 🚀 本地预览

```bash
cd /root/.openclaw/workspace/bzf
python3 -m http.server 8000
# 然后浏览器打开 http://localhost:8000/baozufang-channel-overview.html
```

入口推荐：
- 三档对比 → `baozufang-channel-overview.html`
- C 端体验 → `index.html` 或 `screens/home.html`
- 完整 PRD → `PRD-保租房专用频道-V1.0.md`（任意 Markdown 阅读器）

---

## 📅 三阶段开发节奏

| 阶段 | 周期 | 对应版本 | 核心交付 | 协作方 |
|---|---|---|---|---|
| **一 · 频道搭建** | 0-2 月 | V1 | 入口 + 5 C 端页 + 房源接入 | 贝壳 + 国企 |
| **二 · 运营深耕** | 2-6 月 | V2 | + 标准体系 + G 端最小监管 | + 住建厅 |
| **三 · 生态搭建** | 6-12 月 | V3 | + 交易闭环 + B 端工作台 + 金融通道 | + 江苏银行 |

详细 Sprint 拆解见 [PRD 第 9 章](PRD-保租房专用频道-V1.0.md)。

---

*Co-built by Beike Product · 2026-06-05*
