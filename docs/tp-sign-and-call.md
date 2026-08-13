# 话务平台调用与签名规范

> 适用：绑定虚拟号 `GET /bundling/alloc`  
> 受众：服务端 / BFF 研发与联调人员  
> 原则：**业务标识与密钥只存在服务端，禁止下发到任何对公网暴露的端（H5 / App / 小程序 / 静态页）**

---

## 1. 为什么必须服务端代调

话务 `app_id` / `app_key` 对应号池与计费资源，明文出现在端上会导致：

- 被抓包复用，产生**不可控成本**
- 业务被伪造调用，污染绑定与通话数据
- 测试 / 线上密钥泄露后难以止血

**正确链路：**

```text
C 端 / 运营端  →  自有服务端（持有 app_id/app_key，算 sign）  →  话务平台
```

**错误链路（禁止）：**

```text
C 端直接拼 app_id + sign 调话务   ✗
前端 JS / HTML 写死 app_key       ✗
把签名算法与密钥放到静态仓库对外访问 ✗
```

端上最多拿到：**脱敏后的虚拟号展示串** 或 **由服务端签发的短期拨号票据**，不得持有 `app_id` / `app_key` / 原始 `sign` 计算材料。

---

## 2. 环境

| 环境 | Base URL | 网络 | 说明 |
|------|----------|------|------|
| 测试 | `http://tp-test.lianjia.com` | 外网可访问 | 联调、验收 |
| 线上 | `http://i.tp.lianjia.com` | **内网**，外网不可访问 | 正式流量；调用方须部署在可访问内网的服务 |

配置建议（示例名，具体值进密钥系统 / 本地 `juzhu/.env.local`，**不要写进前端仓库明文**）：

| 配置项 | 含义 |
|--------|------|
| `TP_BASE` | 环境 Base URL |
| `TP_APP_ID` | 话务分配的业务标识 |
| `TP_APP_KEY` | 对应密钥，仅服务端 |

本地开发：复制 `juzhu/.env.example` → `juzhu/.env.local` 填入密钥；`python3 juzhu/server.py` 启动时自动加载（进程里已有的环境变量优先，不覆盖）。

线上上线前由话务侧完成产品线配置；测试通过后切 `TP_BASE` 到线上地址，**密钥与 app_id 仍只读服务端配置**。

业务接入申请联系话务侧（对接人：李弘扬）。

---

## 3. 公共参数（签名校验）

每个请求必须携带：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `app_id` | int/string | 是 | 话务分配的业务标识（服务端配置） |
| `ts` | int | 是 | 当前 Unix 时间戳（**秒**）；须在服务端时间 **前后 1800 秒**内 |
| `sign` | string | 是 | 按下文算法生成的 MD5 十六进制串 |

---

## 4. 签名（sign）算法

1. 收集本次请求的全部 GET（及若有 POST）参数，**排除 `sign` 本身**。
2. 去掉值为空的参数（空串不参与签名）。
3. 按参数名 **key 正向字典序**排序。
4. 拼成：`key1=value1&key2=value2&...`
5. 在字符串末尾追加：`&app_key=<服务端持有的密钥>`
6. 对整串做 **MD5**，得到小写 hex，即为 `sign`。

拼串形态示例（密钥用占位，勿把真实 key 写进对外文档或端上）：

```text
app_id=<TP_APP_ID>&number=188000050511&ts=1786517937&app_key=<TP_APP_KEY>
→ md5(...) → sign
```

### 参考实现（Python，仅服务端）

```python
import hashlib

def generate_sign(params: dict, app_key: str) -> str:
    data = {
        k: v for k, v in params.items()
        if k != "sign" and v is not None and str(v).strip() != ""
    }
    items = sorted((str(k).strip(), str(v).strip()) for k, v in data.items())
    raw = "&".join(f"{k}={v}" for k, v in items) + f"&app_key={app_key}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()
```

本地联调脚本（密钥走环境变量或 `juzhu/.env.local`）：`scripts/tp_bundling_alloc.py`

---

## 5. 绑定号码接口

| 项 | 内容 |
|----|------|
| 路径 | `/bundling/alloc` |
| 方法 | `GET` |
| 本业务约定 | **不传 `port`** |

### 常用业务参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `number` | 条件 | 被叫真实号码；多号逗号分隔。与 `uc_id` 二选一 |
| `uc_id` | 条件 | 用户 ID；有则 `number` 失效 |
| `app_call_id` | 否 | 业务侧绑定关系唯一 ID（通话回调可带回） |
| `city_id` | 否 | 城市编码 |
| `app_data` | 否 | 随路数据 |
| `expire_time` | 否 | 绑定过期，`Y-m-d H:i:s` |

号码有效性：11–13 位纯数字，且非 400 号（例：`02787654321`、`8613811111111`）。

### 请求示例（形态）

```http
GET {TP_BASE}/bundling/alloc?app_id={TP_APP_ID}&number=188000050511&ts={ts}&sign={sign}
```

### 成功响应示例

```json
{
  "errno": 0,
  "errmsg": "成功",
  "data": [
    {
      "errno": 0,
      "errmsg": "成功",
      "virtual_phone_number": "4008891279-0355",
      "phone_number": "188000050511",
      "port": null
    }
  ]
}
```

### 常见错误码

| errno | 含义 | 处理 |
|-------|------|------|
| `0` | 成功 | 将 `virtual_phone_number` 交业务使用；**不要长期缓存** |
| `200001` | 签名验证失败 | 检查排序、空值过滤、`app_key`、是否误把 `sign` 算进原文 |
| `200002` | 未接入该业务 | 联系话务确认该 `app_id` 是否已开通绑定能力与号池 |

---

## 6. 业务注意

1. **号码时效**：绑定号有时效，业务侧**不得缓存**虚拟号作长期映射；每次需要时由服务端重新申请或按话务回调更新。
2. **时钟**：`ts` 以秒为单位，与话务服务器偏差超过 ±1800s 会失败。
3. **日志脱敏**：服务端日志可打 `app_id`（若合规允许）、`ts`、业务单号、返回 `errno`；**禁止**打印完整 `app_key` 与未脱敏的 `sign_raw`（含 key 的待签串）。
4. **仓库与发布**：前端静态资源、公开文档、Demo HTML **不得**出现真实 `app_id` / `app_key`；密钥进配置中心 / 环境变量 / KMS。

---

## 7. 自测清单（服务端）

- [ ] 密钥仅存在部署环境变量 / 密钥系统，前端包体检索无 `app_key` / 话务 Base 直调
- [ ] 正签可通；故意错签返回 `200001`
- [ ] 不传 `port`，仅 `app_id + number + ts + sign` 可绑定成功
- [ ] 连续两次绑定，虚拟号可变（验证未错误缓存）
- [ ] 测试环境验证通过后，线上仅改 `TP_BASE`（及线上密钥配置），调用仍走内网服务

---

## 8. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-12 | 初稿：签名算法、环境、安全边界、`/bundling/alloc` 不传 port；测试联调通过 |
