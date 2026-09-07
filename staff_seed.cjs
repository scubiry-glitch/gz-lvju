// staff_seed.cjs — 运营商员工花名册种子数据（MySQL 版）
// 幂等策略：INSERT IGNORE + uk_staff_emp_no（多 app.js 实例共用一库，重启都会跑 ensureSchema，
// 不能用"表空才写"，否则并发双跑会重复插入）。
'use strict';

// [emp_no, name, phone, level, role, station, month_orders, rating, contract_type, contract_end|'@CUR'|'@NEXT'|null, status, can_extra, note]
const STAFF_ROWS = [
  // L4 督导/店长 ×3
  ['EMP-2024-0021', '陈建国', '13851026582', 'L4', '旅居房管',       '梧桐公馆', 92, 4.98, '正式', '2027-08', 'active', 1, ''],
  ['EMP-2024-0156', '王晓琳', '13824002241', 'L4', '旅居门店',       '河西青年', 78, 4.92, '正式', '2026-12', 'active', 1, ''],
  ['EMP-2023-0102', '郑国强', '13705158876', 'L4', '检修',           '江北建发', 71, 4.88, '正式', '2027-05', 'active', 0, ''],
  // L3 高级管家 ×6
  ['EMP-2025-0418', '刘小红', '13722002208', 'L3', '保洁',           '河西青年', 38, 4.42, '正式', '2026-11', 'observe', 0, ''],
  ['EMP-2024-0335', '韩雪梅', '13913364427', 'L3', '旅居管家',       '梧桐公馆', 84, 4.91, '正式', '2027-03', 'active', 1, ''],
  ['EMP-2024-0287', '罗启明', '13851427763', 'L3', '检修',           '鼓楼物业', 63, 4.79, '正式', '2027-01', 'active', 1, ''],
  ['EMP-2025-0093', '杜春燕', '13776509145', 'L3', '入住服务',       '江宁安居', 58, 4.83, '正式', '2026-10', 'active', 0, ''],
  ['EMP-2025-0157', '蒋一鸣', '13861920058', 'L3', '客服与投诉处理', '总部',     49, 4.71, '正式', '2027-06', 'active', 0, ''],
  ['EMP-2024-0412', '沈丽娜', '13905167334', 'L3', '旅居门店',       '梧桐公馆', 66, 4.86, '正式', '2027-09', 'active', 1, ''],
  // L2 独立服役 ×10
  ['EMP-2026-0089', '周丽华', '13922224128', 'L2', '入住服务',       '江宁安居', 54, 4.72, '试用', '@CUR',    'active', 0, ''],
  ['EMP-2026-0064', '赵丽芳', '13808881164', 'L2', '客服与投诉处理', '总部',     66, 4.74, '正式', '2027-02', 'active', 0, ''],
  ['EMP-2026-0042', '吴桂英', '13733363361', 'L2', '保洁',           '建邺河西',  0, 0,    '正式', null,      'off',    0, ''],
  ['EMP-2025-0261', '马俊杰', '13844497521', 'L2', '房源托管',       '栖霞驻点', 61, 4.68, '正式', '2027-04', 'active', 1, ''],
  ['EMP-2025-0312', '林巧珍', '13955520483', 'L2', '保洁',           '鼓楼物业', 45, 4.55, '正式', '2027-07', 'active', 0, ''],
  ['EMP-2025-0204', '唐伟杰', '13766638452', 'L2', '检修',           '建邺河西', 52, 4.61, '正式', '2027-10', 'active', 1, ''],
  ['EMP-2025-0355', '何雅琴', '13877744639', 'L2', '旅居管家',       '河西青年', 57, 4.77, '正式', '2028-01', 'active', 0, ''],
  ['EMP-2026-0018', '高志远', '13988812067', 'L2', '房源托管',       '江北建发', 43, 4.49, '正式', '2026-11', 'active', 0, ''],
  ['EMP-2026-0035', '邓小岚', '13799927186', 'L2', '入住服务',       '梧桐公馆',  0, 4.63, '正式', '2027-12', 'leave',  0, ''],
  ['EMP-2024-0468', '冯建军', '13811144377', 'L2', '旅居房管',       '栖霞驻点', 48, 4.59, '正式', '2027-08', 'active', 1, ''],
  // L1 基础认证 ×5
  ['EMP-2026-0218', '孙建华', '13700015546', 'L1', '房源托管',       '栖霞驻点', 28, 0,    '试用', '@NEXT',   'train',  0, '师傅带教中'],
  ['EMP-2026-0231', '许　诺', '13822234912', 'L1', '保洁',           '建邺河西', 12, 0,    '正式', '2026-12', 'train',  0, ''],
  ['EMP-2026-0247', '蔡文静', '13933342805', 'L1', '入住服务',       '江宁安居',  9, 3.95, '正式', '2027-03', 'observe', 0, ''],
  ['EMP-2026-0258', '田　野', '13744450123', 'L1', '旅居门店',       '鼓楼物业', 15, 4.21, '正式', '2027-05', 'active', 0, ''],
  ['EMP-2026-0266', '秦雨桐', '13855566498', 'L1', '客服与投诉处理', '总部',     11, 4.05, '正式', '2027-06', 'active', 0, ''],
];

function pad2(n) { return String(n).padStart(2, '0'); }

// '@CUR'/'@NEXT' → 种子时刻的当月/次月（YYYY-MM）：保证「合同到期 ≤90 天」筛选永远有命中，不随时间漂移
function resolveContractEnd(v) {
  if (v !== '@CUR' && v !== '@NEXT') return v;
  const d = new Date();
  if (v === '@NEXT') d.setMonth(d.getMonth() + 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

async function seedAll(conn) {
  const now = new Date().toISOString().slice(0, 19);
  let inserted = 0;
  for (const r of STAFF_ROWS) {
    const [empNo, name, phone, level, role, station, orders, rating, cType, cEnd, status, canExtra, note] = r;
    const [ret] = await conn.execute(
      `INSERT IGNORE INTO operator_staff
         (emp_no, name, phone, level, \`role\`, station, month_orders, rating,
          contract_type, contract_end, status, can_extra, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [empNo, name, phone, level, role, station, orders, rating,
       cType, resolveContractEnd(cEnd), status, canExtra, note, now, now]
    );
    if (ret.affectedRows > 0) inserted++;
  }
  return { inserted, total: STAFF_ROWS.length };
}

module.exports = { seedAll };
