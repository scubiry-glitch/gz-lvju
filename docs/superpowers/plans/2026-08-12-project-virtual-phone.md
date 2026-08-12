# 项目维度虚拟号拨号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保租房/卖旧买新项目在后台录入真实号；户型详情页拨号时服务端实时换绑 400 虚拟号，真实号不进 `data.json`、不回传 C 端。

**Architecture:** `projects.contact_phone` 仅存 SQLite；管理 API 可读写；`export_json` 与公开项目 JSON 剥离该字段；新增 `juzhu/tp_client.py` 封装 TP `/bundling/alloc`；C 端 `GET /api/juzhu/projects/{id}/virtual-phone` 每次无缓存取号；`juzhu-unit-detail.html` 隐私确认后实时 fetch 再 `tel:`。

**Tech Stack:** Python 3 + SQLite（`juzhu/server.py`）、现有 admin HTML、原生 JS 前台、环境变量 `TP_*`。

**Spec:** `docs/superpowers/specs/2026-08-12-project-virtual-phone-design.md`

## Global Constraints

- 真实号禁止进入 `data.json` / 公开前台 API 响应
- 虚拟号禁止前后端缓存；每次拨号独立请求 TP
- `TP_APP_ID` / `TP_APP_KEY` 仅服务端环境变量；默认 `TP_BASE=http://tp-test.lianjia.com`；线上 `http://i.tp.lianjia.com`
- 本业务调 TP **不传 `port`**
- 拨号入口仅 `juzhu-unit-detail.html`；不回落城市/管家号
- 用户未要求时不强制 git commit

## File map

| 文件 | 职责 |
|------|------|
| `juzhu/schema.sql` | 文档化 `contact_phone` 列 |
| `juzhu/db.py` | ALTER 迁移；`export_json` / `normalize_project_row` 剥离真实号（导出） |
| `juzhu/tp_client.py` | 签名 + alloc + 虚拟号格式化（新建） |
| `juzhu/server.py` | 管理 CRUD 读写校验；公开 virtual-phone；公开项目响应脱敏 |
| `juzhu-admin.html` | 项目表单录入真实号；城市电话 Tab 降级文案 |
| `juzhu-unit-detail.html` | 实时取号拨打 |
| `juzhu/app.js` | 可选：`fetchProjectVirtualPhone(projectId)` 辅助 |
| `juzhu/test_virtual_phone.py` | 单元/接口测试（mock TP） |

---

### Task 1: Schema 迁移 + 导出脱敏

**Files:**
- Modify: `juzhu/schema.sql`（`projects` 表）
- Modify: `juzhu/db.py`（migrate + `normalize_project_row` / export）

**Produces:**
- DB 列 `projects.contact_phone TEXT`
- `normalize_project_row_public(d)` 或在 `export_json` 内 `pop("contact_phone", None)`；管理端仍可用含真实号的 `row_to_dict` / 专用 normalize

- [ ] **Step 1:** 在 `schema.sql` 的 `projects` 定义中 `old_house_hint` 后增加 `contact_phone TEXT,`

- [ ] **Step 2:** 在 `db.py` 的 `project_cols` migrations 列表增加：
  `("contact_phone", "ALTER TABLE projects ADD COLUMN contact_phone TEXT")`

- [ ] **Step 3:** 在 `export_json` 的 `export_city` 里，对每个 project 在写入前删除真实号：
  ```python
  for p in projects:
      p.pop("contact_phone", None)
  data["projects"] = [normalize_project_row(p) for p in projects]
  ```
  （若 `normalize_project_row` 先执行，则在 normalize 后 pop，保证文件无该键或为 null。）

- [ ] **Step 4:** 跑一次 `python3 -c "from juzhu.db import connect, export_json; c=connect(); export_json(c); c.close()"`，确认 `juzhu/data.json` 的 projects 无真实 `contact_phone` 值。

---

### Task 2: `juzhu/tp_client.py`

**Files:**
- Create: `juzhu/tp_client.py`
- Reuse logic from: `scripts/tp_bundling_alloc.py`

**Produces:**
- `generate_sign(params, app_key) -> str`
- `alloc_virtual_phone(number: str) -> dict` 返回 `{virtual_phone, display, tel}` 或抛错
- `format_virtual_phone(raw: str) -> {virtual_phone, display, tel}`
- `validate_real_phone(phone: str) -> str | None`（空→None；非法→raise ValueError）

- [ ] **Step 1:** 实现文件，要点：
  - 读 `os.environ`：`TP_APP_ID`、`TP_APP_KEY`、`TP_BASE`（默认 `http://tp-test.lianjia.com`）
  - 缺密钥 → `RuntimeError("TP_APP_ID/TP_APP_KEY 未配置")`
  - `urllib` 强制 `ProxyHandler({})`
  - 不传 `port`
  - 解析 `body["data"][0]["virtual_phone"]`；`errno != 0` 抛错
  - `4008891279-0355` → `display="400 889 1279 转 0355"`，`tel="tel:4008891279,0355"`
  - 真实号校验：strip 后全数字，长度 11–13，不以 `400` 开头

- [ ] **Step 2:** 本地 dry 测：
  `python3 -c "from juzhu.tp_client import format_virtual_phone, validate_real_phone; print(format_virtual_phone('4008891279-0355')); print(validate_real_phone('13800138000'))"`

---

### Task 3: Server — 管理 CRUD + 公开 virtual-phone + 脱敏

**Files:**
- Modify: `juzhu/server.py`

**Consumes:** `tp_client.alloc_virtual_phone` / `validate_real_phone`

- [ ] **Step 1:** 路由：在现有 `/api/juzhu/projects/` 分支**之前**匹配：
  ```python
  m = re.match(r"^/api/juzhu/projects/(\d+)/virtual-phone$", path)
  if m and method == "GET":
      return self._project_virtual_phone(int(m.group(1)))
  ```

- [ ] **Step 2:** `_project_virtual_phone(pid)`：
  1. SELECT `id, contact_phone, name` FROM projects WHERE id=?
  2. 无行 → 404
  3. 无号 → 400 `{"error":"未配置联系电话"}`
  4. 调 `alloc_virtual_phone`；成功返回三字段；失败 502 `{"error":"暂时无法接通，请稍后重试"}`（日志脱敏）
  5. **禁止**把 `contact_phone` 写入响应

- [ ] **Step 3:** `_create_project` / `_update_project`：接受 `contact_phone`；经 `validate_real_phone`；写入 INSERT/UPDATE 列列表。

- [ ] **Step 4:** 公开 `GET /api/juzhu/projects/{slug}`、district projects、trade 列表等返回前 `pop("contact_phone", None)`（统一 helper `_public_project(d)`）。Admin 的 `normalize_project_row` / admin GET **保留**真实号。

- [ ] **Step 5:** 手工测（需 `TP_*`）：
  ```bash
  curl -s http://127.0.0.1:8765/api/juzhu/admin/projects/1 -H "X-Api-Key: $KEY" | jq .contact_phone
  curl -s -X PUT http://127.0.0.1:8765/api/juzhu/admin/projects/1 -H "X-Api-Key: $KEY" -H "Content-Type: application/json" -d '{"contact_phone":"13800138000"}'
  curl -s http://127.0.0.1:8765/api/juzhu/projects/1/virtual-phone
  # 确认无 contact_phone 字段；连续两次调用均发出（可看服务端日志）
  ```

---

### Task 4: 后台 UI

**Files:**
- Modify: `juzhu-admin.html`

- [ ] **Step 1:** `renderNewProjectForm` 增加：
  ```html
  <div class="fld"><label>联系电话（真实号）</label>
  <input id="n_phone" placeholder="11–13 位手机/固话，勿填 400"/>
  <p class="hint">用户拨号时由服务端实时换绑为 400 虚拟号；真实号不会写入 data.json</p></div>
  ```
  `createProject` body 增加 `contact_phone: document.getElementById('n_phone').value.trim() || null`

- [ ] **Step 2:** `renderEditor` 同样增加 `#p_phone`；`saveProject` body 带上 `contact_phone`。

- [ ] **Step 3:** 城市「预约电话」Tab hint 改为：已降级；户型详情拨号改走项目联系电话。

---

### Task 5: 前台户型详情实时拨号

**Files:**
- Modify: `juzhu-unit-detail.html`
- Modify: `juzhu/app.js`（可选 helper）

- [ ] **Step 1:** 在 `app.js` 增加：
  ```javascript
  function fetchProjectVirtualPhone(projectId) {
    return fetch('/api/juzhu/projects/' + projectId + '/virtual-phone', {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    }).then(function(r) {
      return r.json().then(function(j) {
        if (!r.ok) throw new Error((j && j.error) || '暂时无法接通');
        return j;
      });
    });
  }
  ```
  挂到 `JUZHU` 导出；**不要**使用 localStorage。

- [ ] **Step 2:** 改 `callWithPrivacy`：确认后不再直接用静态 `tel`，改为：
  ```javascript
  function callWithPrivacy(projectId) {
    // show modal...
    privacyOk.onclick = function() {
      closePrivacy();
      if (!projectId) { alert('暂未配置咨询电话'); return; }
      privacyOk.disabled = true;
      JUZHU.fetchProjectVirtualPhone(projectId).then(function(res) {
        if (res.display) { /* 可选：短暂展示 */ }
        location.href = res.tel;
      }).catch(function(e) {
        alert(e.message || '暂时无法接通，请稍后重试');
      }).finally(function(){ privacyOk.disabled = false; });
    };
  }
  ```
  底部 CTA / 管家图标 / 租金咨询均传入 `p.id`（项目 id），**不再** `JUZHU.unitKeeperPhone` / `bookingPhone`。

- [ ] **Step 3:** 未配置时（可先 HEAD/或首次失败 400）：点击仍弹隐私框，确认后提示「请在内容编辑后台为该项目填写联系电话」。

---

### Task 6: 测试

**Files:**
- Create: `juzhu/test_virtual_phone.py`

- [ ] **Step 1:** 测 `validate_real_phone` / `format_virtual_phone`（纯函数）。
- [ ] **Step 2:** mock `alloc`（unittest.mock.patch），测 handler：无号 400、有号返回三字段且无真实号、连续两次调用 mock call_count==2。
- [ ] **Step 3:** 测 export 后 JSON 无 contact_phone 真实值（可写入临时 DB）。

Run: `python3 -m pytest juzhu/test_virtual_phone.py -v`（若无 pytest 则 `python3 juzhu/test_virtual_phone.py`）

---

## Spec coverage checklist

| Spec 项 | Task |
|---------|------|
| `contact_phone` 列 + 迁移 | 1 |
| data.json 不带真实号 | 1 |
| TP client + 双环境 Base | 2 |
| 管理 CRUD 真实号 | 3+4 |
| 实时 virtual-phone API 无缓存 | 3 |
| 公开响应脱敏 | 3 |
| 详情页 CTA 实时拨号 | 5 |
| 验收/测试 | 6 |

## Self-review

- 无 TBD；路由用数字 id 避免与 slug 冲突。
- 公开 slug 详情须脱敏，否则 SELECT * 会泄漏。
- Commit 步骤按用户规则：仅在用户要求时执行。
