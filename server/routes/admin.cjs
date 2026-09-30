'use strict';
/**
 * /api/juzhu/admin/* 管理域（从 app.js 拆出）。
 * 权限闸仍在 app.js（perm_registry）；此处只做业务处理。
 * 另含公开 GET /api/juzhu/settings（与 admin/settings 同形）。
 */
function createAdminRouter(deps) {
  return async function handleAdminRoutes(urlPath, qs, req, res) {
    const {
queryRows,
      jsonReply,
      readBody,
      mysql2,
      getDbConfig,
      crypto,
      housingCities,
      parseJsonFields,
      encodeTags,
      channelBrand,
      isProduction,
      ensureSchema,
      authCenter,
      requireApiKey,
      requirePerm,
      requireAnyPerm,
      guardRatingSubmit,
      requestSession,
      extractBearerToken,
      validateRealPhone,
      contactPhoneFromBody,
      stripContactPhone,
      slugify,
      cityDupReply,
      resolveBodyCityId,
      insertCityRow,
      updateCityRow,
      uniqueProjectSlug,
      uniqueUnitSlug,
      syncDistrictStats,
      syncProjectUnitCount,
      normalizeUnitExtInput,
      normalizeUnitRoomProfileInput,
      syncUnitCover,
      normalizeProjectExtInput,
      normalizeCancelPolicyInput,
      projectPublishEligibility,
      stayConfigOf,
      cancelPolicyOf,
      cancelPolicyTextOf,
      minStayNightsOf,
      transactionCapabilitiesOf,
      wholeHousePriceUnit,
      unitNightPrice,
      vendorRate,
      settingValue,
      vendorApi,
      notifyVendorEvent,
      imgThumbs,
      maskPhoneStd,
      stripVendorSecrets,
      idpOidc,
      permRegistry,
      ADMIN_PREFIX,
      catalogMemoInvalidateAll,
      catalogMemoInvalidateTopics,
      housingParseJsonField,
      housingHydrateCoverFields,
      housingTagsToDb,
      ratingCfg,
      RATING_DIMS,
      RATING_CODE_PREFIX,
      stayCfg,
      connExec,
      fallbackUnitRowFor,
      auditIfAccount,
      isAdminSessionAuthorized,
      verifyAdminLoginToken
    } = deps;

    // --- from app.js L2677-4288 ---
    // GET /api/juzhu/admin/vendor-onboarding?status= —— 受理列表（服务认证中台；权限点 vendor.onboarding.review）
    if (urlPath === '/api/juzhu/admin/vendor-onboarding' && req.method === 'GET') {
      await ensureSchema();
      const qp = new URLSearchParams(qs);
      const st = (qp.get('status') || '').trim();
      const sql = 'SELECT vo.*, (SELECT v.name FROM jz_vendors v WHERE v.id = vo.approved_vendor_id) AS approved_vendor_name'
        + ' FROM vendor_onboarding vo' + (st ? ' WHERE vo.status=?' : '') + ' ORDER BY vo.created_at DESC LIMIT 200';
      const rows = await queryRows(sql, st ? [st] : []);
      const byStatus = await queryRows('SELECT status, COUNT(*) AS c FROM vendor_onboarding GROUP BY status');
      const counts = {}; byStatus.forEach(r => { counts[r.status] = r.c; });
      return jsonReply(res, { items: rows, counts: counts });
    }

    // POST /api/juzhu/admin/vendor-onboarding/:id/review —— 受理 / 通过 / 驳回（状态机 + 审计由权限闸记录）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendor-onboarding\/(\d+)\/review$/);
      if (m && req.method === 'POST') {
        await ensureSchema();
        const id = parseInt(m[1], 10);
        const body = await readBody(req);
        const action = String(body.action || '').trim();
        if (!['review', 'approve', 'reject'].includes(action)) return jsonReply(res, { error: 'bad request', message: 'action 须为 review / approve / reject' }, 400);
        const rows = await queryRows('SELECT * FROM vendor_onboarding WHERE id=?', [id]);
        if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
        const cur = rows[0];
        if (cur.status === 'approved' || cur.status === 'rejected') return jsonReply(res, { error: 'conflict', message: '该申请单已终审（' + cur.status + '），不可再变更' }, 409);
        let next;
        if (action === 'review') {
          if (cur.status !== 'pending') return jsonReply(res, { error: 'conflict', message: '仅待受理单可转核验中' }, 409);
          next = 'reviewing';
        } else if (action === 'approve') {
          next = 'approved';
        } else {
          next = 'rejected';
          if (!String(body.note || '').trim()) return jsonReply(res, { error: 'bad request', message: '驳回必须填写理由（留痕）' }, 400);
        }
        const reviewer = (req.principal && req.principal.account && (req.principal.account.name || req.principal.account.login_name)) || '';
        let discount = null;
        if (action === 'approve' && body.rate_discount !== undefined && body.rate_discount !== null && body.rate_discount !== '') {
          discount = Math.max(0, Math.min(10, parseFloat(body.rate_discount) || 0));
        }
        const checklist = body.checklist ? String(JSON.stringify(body.checklist)).slice(0, 2000) : (cur.checklist_json || null);
        await queryRows(
          `UPDATE vendor_onboarding SET status=?, rate_discount=?, checklist_json=?, review_note=?, reviewer=?, reviewed_at=NOW() WHERE id=?`,
          [next, discount, checklist, String(body.note || '').slice(0, 500), String(reviewer).slice(0, 64), id]
        );
        // 规则 20：审批通过即把核定费率回填商家（接通「申请单核定 → 商家费率」断桥）。
        // 按 phone 单命中 active 商家才回填；未命中/多命中不阻塞，由「商家费率」台配置。
        let backfillNote = '';
        if (next === 'approved') {
          const rateVal = Math.round((Math.max(0, (parseFloat(cur.rate_base) || 10) - (discount != null ? discount : 0))) * 100) / 100;
          const vrows = await queryRows("SELECT id, name FROM jz_vendors WHERE phone=? AND status='active'", [cur.phone]);
          if (vrows.length === 1) {
            const chans = String(cur.channels || 'rental').split(',').map((c) => c.trim());
            const bizCols = [];
            if (chans.some((c) => c === 'rental' || c === 'minsu')) bizCols.push('commission_housing');
            if (chans.some((c) => c === 'jiazheng')) bizCols.push('commission_jiazheng');
            if (!bizCols.length) bizCols.push('commission_housing');   // 申请单频道缺省按房源档
            await queryRows(
              `UPDATE jz_vendors SET ${bizCols.map((c) => c + '=?').join(', ')} WHERE id=?`,
              [...bizCols.map(() => rateVal), vrows[0].id]
            );
            // 受理台 ↔ 商家档案互通（2026-09-22）：申请单记下关联商家，详情/列表可回查
            await queryRows('UPDATE vendor_onboarding SET approved_vendor_id=? WHERE id=?', [vrows[0].id, id]);
            backfillNote = '；费率已回填商家 ' + vrows[0].name + '（' + rateVal + '%）';
            await authCenter.audit({
              action: 'vendor.commission.update', resource: 'vendors', resourceId: String(vrows[0].id),
              result: 'ok', after: Object.fromEntries(bizCols.map((c) => [c, rateVal])),
              before: Object.fromEntries(bizCols.map((c) => [c, null])),
            });
          } else if (vrows.length > 1) {
            backfillNote = '；按手机号命中多个商家，费率未自动回填（请在「商家费率」台配置）';
          } else {
            backfillNote = '；暂未找到匹配商家，费率请在「商家费率」台配置';
          }
        }
        const out = await queryRows('SELECT * FROM vendor_onboarding WHERE id=?', [id]);
        return jsonReply(res, Object.assign({}, out[0], {
          message: next === 'approved'
            ? '已通过。密钥（vendor_id + hmac_key）按线下流程发放；费率基准 10%' + (discount != null ? ' · 折扣 ' + discount : '') + backfillNote
            : (next === 'reviewing' ? '已转入核验中' : '已驳回（已留痕）'),
        }));
      }
    }

    // ===== GET 只读接口 =====

    if (urlPath === '/api/juzhu/admin/dictionary' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const allCities = await queryRows('SELECT * FROM cities ORDER BY id');
      const city = housingCities
        ? housingCities.pickCity(allCities, qp.get('city'))
        : (allCities[0] || null);
      const districts = city
        ? await queryRows('SELECT * FROM districts WHERE city_id=? ORDER BY sort_order, id', [city.id])
        : [];
      const channels = await queryRows('SELECT * FROM channels ORDER BY sort_order, id');
      // 周边玩法维度（规则 17）：不按城市过滤——绑定 picker 需要全省通用（city_id NULL）与跨市目的地
      const spots = await queryRows('SELECT * FROM spots ORDER BY type, sort_order, id');
      spots.forEach((r) => parseJsonFields(r, ['tags']));
      allCities.forEach((r) => { r.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(r.hidden_home_tabs) : []; });
      if (city) city.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(city.hidden_home_tabs) : [];
      return jsonReply(res, { city, cities: allCities, districts, channels, spots });
    }

    if (urlPath === '/api/juzhu/admin/cities' && req.method === 'GET') {
      const rows = await queryRows('SELECT * FROM cities ORDER BY id');
      rows.forEach((r) => { r.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(r.hidden_home_tabs) : []; });
      return jsonReply(res, rows);
    }

    if ((urlPath === '/api/juzhu/admin/settings' || urlPath === '/api/juzhu/settings') && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const allCities = await queryRows('SELECT id, booking_phone, slug, name FROM cities ORDER BY id');
      const city = housingCities
        ? housingCities.pickCity(allCities, qp.get('city') || qp.get('city_id'))
        : (allCities[0] || null);
      const settings = await queryRows('SELECT `key`, value FROM settings');
      const settingsMap = {};
      for (const r of settings) settingsMap[r.key] = r.value;
      const brand = channelBrand
        ? channelBrand.fromSettingsMap(settingsMap)
        : { name: (settingsMap.channel_name || '新居住频道').trim() || '新居住频道' };
      return jsonReply(res, {
        booking_phone: city ? city.booking_phone : null,
        show_city_switcher: settingsMap.show_city_switcher !== '0',
        show_life_service: settingsMap.show_life_service !== '0',
        channel_name: brand.name,
        // 抽佣全局基准（规则 20）：商家未差异化时回落到这里
        commission_housing_default: String(vendorRate.defaultRateOf(settingsMap, 'housing')),
        commission_jiazheng_default: String(vendorRate.defaultRateOf(settingsMap, 'jiazheng')),
        // C 端模拟登录开关：仅非生产（JUZHU_ENV != prod/production）开启；生产恒 false，C 端走 jsbridge3 真实登录
        mock_login: !isProduction(),
      });
    }

    if (urlPath === '/api/juzhu/admin/projects' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT p.*, d.name AS district_name, v.name AS vendor_name FROM projects p'
        + ' LEFT JOIN districts d ON d.id=p.district_id'
        + ' LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id WHERE 1=1';
      const params = [];
      // scope 行级过滤（不可被 query 参数绕过；QS 显式条件与 scope 取交集，窄者胜）：
      // city → city_id IN；org → 本机构下商家；vendor → 本商家；self 档不放行管理列表
      const principal = await authCenter.principalOf(req).catch(() => null);
      if (principal && principal.type === 'account') {
        const scope = authCenter.scopeOf(principal);
        if (scope.level === 'city') {
          const cs = authCenter.scopeCitySql(scope, 'p.city_id');
          sql += cs.sql; params.push(...cs.params);
        } else if (scope.level === 'org' && scope.orgId != null) {
          sql += ' AND p.owner_vendor_id IN (SELECT id FROM jz_vendors WHERE org_id=?)'; params.push(scope.orgId);
        } else if (scope.level === 'vendor' && scope.vendorId != null) {
          sql += ' AND p.owner_vendor_id=?'; params.push(scope.vendorId);
        } else if (scope.level !== 'all') {
          return jsonReply(res, { error: 'forbidden', message: '当前账号数据范围不足（' + scope.level + ' 档）' }, 403);
        }
      }
      if (qp.get('city_id')) { sql += ' AND p.city_id=?'; params.push(parseInt(qp.get('city_id'))); }
      if (qp.get('channel')) { sql += ' AND p.channel=?'; params.push(qp.get('channel')); }
      if (qp.get('district_id')) { sql += ' AND p.district_id=?'; params.push(parseInt(qp.get('district_id'))); }
      if (qp.get('vendor_id')) { sql += ' AND p.owner_vendor_id=?'; params.push(parseInt(qp.get('vendor_id'))); }
      if (qp.get('q')) { sql += ' AND p.name LIKE ?'; params.push('%' + qp.get('q') + '%'); }
      sql += ' ORDER BY p.channel, p.sort_order, p.id';
      const rows = await queryRows(sql, params);
      rows.forEach((r) => parseJsonFields(r, ['tags', 'rating']));
      return jsonReply(res, rows);
    }

    // GET /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'GET') {
        const pid = parseInt(m[1]);
        const projs = await queryRows(
          'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
          [pid]
        );
        if (!projs.length) return jsonReply(res, { error: 'not found' }, 404);
        parseJsonFields(projs[0], ['tags', 'rating']);
        const units = await queryRows('SELECT * FROM units WHERE project_id=? ORDER BY sort_order', [pid]);
        units.forEach((u) => parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']));
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?) ORDER BY entity_id, sort_order, id",
          [pid]
        );
        return jsonReply(res, { project: projs[0], units, photos });
      }
    }

    if (urlPath === '/api/juzhu/districts' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const cityKey = (qp.get('city') || '').trim();
      let sql = 'SELECT d.* FROM districts d';
      const params = [];
      if (cityKey) {
        sql += ' INNER JOIN cities c ON c.id=d.city_id WHERE (c.slug=? OR c.name=?)';
        params.push(cityKey, cityKey);
      }
      sql += ' ORDER BY d.sort_order, d.id';
      const rows = await queryRows(sql, params);
      return jsonReply(res, rows);
    }

    if (urlPath === '/api/juzhu/stats' && req.method === 'GET') {
      const [d] = await queryRows("SELECT COUNT(*) AS c FROM districts");
      const [pb] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel IN ('rental','minsu')");
      const [pt] = await queryRows("SELECT COUNT(*) AS c FROM projects WHERE channel='trade'");
      const [u] = await queryRows("SELECT COALESCE(SUM(managed_unit_count), 0) AS c FROM projects WHERE channel IN ('rental','minsu')");
      // 运营商维度（持有方资管大盘用）：仅持有 report.read 的账号会话可见——
      // 匿名/旧 Key 消费方（C 端/B 端演示页）拿降级响应，不再泄漏商家明细
      const principal = await authCenter.principalOf(req).catch(() => null);
      const isAccount = principal && principal.type === 'account';
      const canSeeOperators = isAccount &&
        (authCenter.hasPermission(principal, 'report.read') || authCenter.hasPermission(principal, '*'));
      let operators = [];
      let degraded = true;
      if (canSeeOperators) {
        const scope = authCenter.scopeOf(principal);
        const cityJoin = authCenter.scopeCitySql(scope, 'p.city_id');
        operators = await queryRows(
          `SELECT v.id, v.name, v.type, COUNT(p.id) AS project_count,
                  COALESCE(SUM(COALESCE(p.managed_unit_count, p.unit_count)), 0) AS unit_count
           FROM jz_vendors v
           LEFT JOIN projects p ON p.owner_vendor_id = v.id AND p.channel IN ('rental','minsu')${cityJoin.sql}
           WHERE v.type IN ('platform','housing_operator','lvju_host','homestay')
           GROUP BY v.id, v.name, v.type ORDER BY project_count DESC, v.id`,
          cityJoin.params
        );
        degraded = false;
      }
      return jsonReply(res, {
        districts: d.c,
        projects_rental: pb.c,
        projects_bzf: pb.c, // 旧字段别名（历史消费方兼容）
        projects_trade: pt.c,
        units: u.c,
        operators,
        degraded, // true = 匿名/无 report.read，operators 已剥离
      });
    }

    // ===== 写操作接口 =====

    // GET /admin/vendors/consult —— 商家维度咨询方式（C 端详情页左下角咨询入口优先级）
    if (urlPath === '/api/juzhu/admin/vendors' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = 'SELECT v.id, v.type, v.name, v.phone, v.city_ids, v.status, v.review_status, v.review_note, v.reviewed_at, v.created_at, v.updated_at,'
        + ' (SELECT ob.apply_no FROM vendor_onboarding ob WHERE ob.approved_vendor_id = v.id ORDER BY ob.id DESC LIMIT 1) AS onboarding_apply_no'
        + ' FROM jz_vendors v WHERE 1=1';
      const params = [];
      if (qp.get('review_status')) { sql += ' AND review_status=?'; params.push(qp.get('review_status')); }
      if (qp.get('status')) { sql += ' AND status=?'; params.push(qp.get('status')); }
      sql += ' ORDER BY id DESC LIMIT 500';
      return jsonReply(res, await queryRows(sql, params));
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/review$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const reviewStatus = String(body.review_status || '').trim();
        if (!['reviewing', 'approved', 'rejected'].includes(reviewStatus)) return jsonReply(res, { error: 'review_status 须为 reviewing/approved/rejected' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const vid = parseInt(m[1], 10);
          const [curRows] = await conn.execute(
            'SELECT id, name, review_status, status FROM jz_vendors WHERE id=?', [vid]);
          if (!curRows.length) return jsonReply(res, { error: '商家不存在' }, 404);
          const cur = curRows[0];
          const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
          const nextStatus = reviewStatus === 'approved' ? 'active' : (reviewStatus === 'rejected' ? 'suspended' : 'active');
          await conn.execute(
            'UPDATE jz_vendors SET review_status=?, review_note=?, reviewed_at=?, status=?, updated_at=? WHERE id=?',
            [reviewStatus, String(body.review_note || '').trim().slice(0, 1000) || null, now, nextStatus, now, vid]
          );
          // 资质复审是准入动作：处理器内记 before/after（role.update 金标准），不只依赖 ROUTES 自动审计
          const p = req.principal || {};
          await authCenter.audit({
            accountId: p.account && p.account.id,
            principalType: 'account',
            roles: p.roles,
            action: 'vendor.review.update',
            resource: 'vendors',
            resourceId: String(vid),
            scopeLevel: authCenter.bestScopeLevel(p),
            result: 'ok',
            before: { review_status: cur.review_status, status: cur.status },
            after: { review_status: reviewStatus, status: nextStatus },
            ip: p.ip, ua: p.ua,
          });
          return jsonReply(res, { ok: true, id: vid, review_status: reviewStatus, status: nextStatus });
        } finally { await conn.end(); }
      }
    }

    if (urlPath === '/api/juzhu/admin/vendors/consult' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT v.id, v.name, v.type, v.consult_mode, COUNT(p.id) AS project_count
         FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id
         WHERE v.status='active'
         GROUP BY v.id, v.name, v.type, v.consult_mode
         HAVING project_count > 0
         ORDER BY project_count DESC, v.id`);
      return jsonReply(res, rows.map((v) => Object.assign(v, { consult_mode: v.consult_mode || 'consultant' })));
    }

    // PUT /admin/vendors/:id/consult-mode —— 切换商家咨询方式（consultant=咨询顾问/400 虚拟号；ai=AI 咨询，上线前勿切）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/consult-mode$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const mode = String(body.consult_mode || '').trim();
        if (!['consultant', 'ai'].includes(mode)) return jsonReply(res, { error: 'consult_mode 仅支持 consultant / ai' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute(
            'UPDATE jz_vendors SET consult_mode=?, updated_at=? WHERE id=?',
            [mode, new Date().toISOString().slice(0, 19).replace('T', ' '), parseInt(m[1], 10)]
          );
          if (!r.affectedRows) return jsonReply(res, { error: 'not found' }, 404);
          return jsonReply(res, { ok: true, id: parseInt(m[1], 10), consult_mode: mode });
        } finally { await conn.end(); }
      }
    }

    // GET /admin/vendors/rates —— 商家费率（两档）+ 全局基准（规则 20；权限点 admin.read）
    if (urlPath === '/api/juzhu/admin/vendors/rates' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      let sql = `SELECT v.id, v.name, v.type, v.phone, v.status, v.review_status,
                        v.commission_housing, v.commission_jiazheng, COUNT(p.id) AS project_count
                 FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id
                 WHERE 1=1`;
      const params = [];
      if (qp.get('status')) { sql += ' AND v.status=?'; params.push(qp.get('status')); }
      sql += ' GROUP BY v.id, v.name, v.type, v.phone, v.status, v.review_status, v.commission_housing, v.commission_jiazheng ORDER BY v.id DESC LIMIT 500';
      const rows = await queryRows(sql, params);
      const srows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        [vendorRate.defaultSettingKey('housing'), vendorRate.defaultSettingKey('jiazheng')]);
      const settingsMap = {};
      for (const r of srows) settingsMap[r.key] = r.value;
      const vendors = rows.map((v) => Object.assign({}, v, {
        commission_housing: v.commission_housing == null ? null : Number(v.commission_housing),
        commission_jiazheng: v.commission_jiazheng == null ? null : Number(v.commission_jiazheng),
        commission_housing_effective: vendorRate.effectiveRateOf(v, 'housing', settingsMap),
        commission_jiazheng_effective: vendorRate.effectiveRateOf(v, 'jiazheng', settingsMap),
      }));
      return jsonReply(res, {
        defaults: {
          housing: vendorRate.defaultRateOf(settingsMap, 'housing'),
          jiazheng: vendorRate.defaultRateOf(settingsMap, 'jiazheng'),
        },
        vendors,
      });
    }

    // PUT /admin/vendors/commission-defaults —— 抽佣全局基准（两键 KV；规则 20；权限点 vendor.fund.write）
    // 与 PUT /admin/settings 并行写同一组 KV（那边挂 settings.write 给平台管理员）；null = 删除键回落内置 10。
    if (urlPath === '/api/juzhu/admin/vendors/commission-defaults' && req.method === 'PUT') {
      const body = await readBody(req);
      const out = {};
      for (const biz of vendorRate.BIZLINES) {
        const k = vendorRate.defaultSettingKey(biz);
        if (!(biz in body) && !('commission_' + biz + '_default' in body)) continue;
        const raw = (biz in body) ? body[biz] : body['commission_' + biz + '_default'];
        let v;
        try { v = vendorRate.normalizeRate(raw); } catch (e) { return jsonReply(res, { error: e.message }, 400); }
        if (v == null) await queryRows('DELETE FROM settings WHERE `key`=?', [k]);
        else await queryRows(
          'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
          [k, String(v)]
        );
        out[biz] = v;
      }
      if (!Object.keys(out).length) return jsonReply(res, { error: '无可更新字段（housing / jiazheng）' }, 400);
      const srows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        [vendorRate.defaultSettingKey('housing'), vendorRate.defaultSettingKey('jiazheng')]);
      const settingsMap = {};
      for (const rr of srows) settingsMap[rr.key] = rr.value;
      return jsonReply(res, {
        ok: true,
        defaults: {
          housing: vendorRate.defaultRateOf(settingsMap, 'housing'),
          jiazheng: vendorRate.defaultRateOf(settingsMap, 'jiazheng'),
        },
      });
    }

    // GET /admin/vendors/commission-history —— 费率变更详单（规则 20；挂 vendor.fund.write，
    // 不借道 /admin/audit 的 audit.read：看佣金历史不需要全站审计权限）
    if (urlPath === '/api/juzhu/admin/vendors/commission-history' && req.method === 'GET') {
      const rows = await queryRows(
        `SELECT id, resource_id, role_code, before_json, after_json, created_at
         FROM audit_log
         WHERE action='vendor.commission.update' AND before_json IS NOT NULL
         ORDER BY id DESC LIMIT 50`);
      return jsonReply(res, {
        items: rows.map((r0) => {
          let before = {}, after = {};
          try { before = JSON.parse(r0.before_json || '{}'); } catch (_) {}
          try { after = JSON.parse(r0.after_json || '{}'); } catch (_) {}
          return { id: r0.id, vendor_id: r0.resource_id, role_code: r0.role_code, created_at: r0.created_at, before, after };
        }),
      });
    }

    // PUT /admin/vendors/:id/commission —— 商家费率调整（两档；规则 20；权限点 vendor.fund.write）
    // 口径：0-100 两位小数，null = 清除（回落全局基准）；调价不追溯，仅新订单生效。
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/vendors\/(\d+)\/commission$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        let nextHousing, nextJiazheng;
        try {
          if ('commission_housing' in body) nextHousing = vendorRate.normalizeRate(body.commission_housing);
          if ('commission_jiazheng' in body) nextJiazheng = vendorRate.normalizeRate(body.commission_jiazheng);
        } catch (e) { return jsonReply(res, { error: e.message }, 400); }
        if (nextHousing === undefined && nextJiazheng === undefined) {
          return jsonReply(res, { error: '无可更新字段（commission_housing / commission_jiazheng）' }, 400);
        }
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const vid = parseInt(m[1], 10);
          const [rows] = await conn.execute(
            'SELECT id, name, commission_housing, commission_jiazheng FROM jz_vendors WHERE id=?', [vid]);
          if (!rows.length) return jsonReply(res, { error: '商家不存在' }, 404);
          const cur = rows[0];
          const num = (x) => (x == null ? null : Number(x));
          const before = { commission_housing: num(cur.commission_housing), commission_jiazheng: num(cur.commission_jiazheng) };
          const sets = [], vals = [];
          if (nextHousing !== undefined) { sets.push('commission_housing=?'); vals.push(nextHousing); }
          if (nextJiazheng !== undefined) { sets.push('commission_jiazheng=?'); vals.push(nextJiazheng); }
          await conn.execute(
            `UPDATE jz_vendors SET ${sets.join(', ')}, updated_at=? WHERE id=?`,
            [...vals, new Date().toISOString().slice(0, 19).replace('T', ' '), vid]
          );
          // 敏感商业条款变更：处理器内记 before/after（role.update 金标准），不只依赖 ROUTES 自动审计
          const p = req.principal || {};
          await authCenter.audit({
            accountId: p.account && p.account.id,
            principalType: 'account',
            roles: p.roles,
            action: 'vendor.commission.update',
            resource: 'vendors',
            resourceId: String(vid),
            scopeLevel: authCenter.bestScopeLevel(p),
            result: 'ok',
            before,
            after: {
              commission_housing: nextHousing !== undefined ? nextHousing : before.commission_housing,
              commission_jiazheng: nextJiazheng !== undefined ? nextJiazheng : before.commission_jiazheng,
            },
            ip: p.ip, ua: p.ua,
          });
          return jsonReply(res, {
            ok: true,
            vendor: {
              id: vid, name: cur.name,
              commission_housing: nextHousing !== undefined ? nextHousing : before.commission_housing,
              commission_jiazheng: nextJiazheng !== undefined ? nextJiazheng : before.commission_jiazheng,
            },
          });
        } finally { await conn.end(); }
      }
    }

    // PUT /admin/settings
    if (urlPath === '/api/juzhu/admin/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      let parsedChannel = null;
      if (body.channel_name !== undefined) {
        parsedChannel = channelBrand
          ? channelBrand.parseChannelName(body.channel_name)
          : { ok: !!(body.channel_name || '').trim(), name: String(body.channel_name || '').trim(), error: '频道名称不能为空', status: 400 };
        if (!parsedChannel.ok) return jsonReply(res, { error: parsedChannel.error }, parsedChannel.status);
      }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        if (body.booking_phone !== undefined) {
          const phone = (body.booking_phone || '').trim() || null;
          const resolved = await resolveBodyCityId(conn, body);
          if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
          await conn.execute('UPDATE cities SET booking_phone=? WHERE id=?', [phone, resolved.cityId]);
        }
        for (const k of ['show_city_switcher', 'show_life_service']) {
          if (k in body) {
            const v = body[k] ? '1' : '0';
            await conn.execute(
              'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
              [k, v]
            );
          }
        }
        // 抽佣全局基准（规则 20）：0-100 两位小数；传 null/'' = 删除键（回落内置 10.00 兜底）
        for (const biz of vendorRate.BIZLINES) {
          const k = vendorRate.defaultSettingKey(biz);
          if (k in body) {
            let v;
            try { v = vendorRate.normalizeRate(body[k]); } catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
            if (v == null) await conn.execute('DELETE FROM settings WHERE `key`=?', [k]);
            else await conn.execute(
              'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
              [k, String(v)]
            );
          }
        }
        let channelOut;
        if (parsedChannel) {
          await conn.execute(
            'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
            ['channel_name', parsedChannel.name]
          );
          channelOut = parsedChannel.name;
        }
        await conn.commit();
        const phoneOut = body.booking_phone !== undefined
          ? ((body.booking_phone || '').trim() || null)
          : undefined;
        const out = { ok: true, booking_phone: phoneOut };
        if (channelOut !== undefined) out.channel_name = channelOut;
        return jsonReply(res, out);
      } finally {
        await conn.end();
      }
    }

    // GET 已在上方；POST /admin/cities
    if (urlPath === '/api/juzhu/admin/cities' && req.method === 'POST') {
      const body = await readBody(req);
      const parsed = housingCities
        ? housingCities.validateCityWrite(body)
        : { ok: !!(body.name || '').trim(), error: '城市名称不能为空', status: 400, fields: { name: (body.name || '').trim(), slug: (body.slug || '').trim() || slugify(body.name) } };
      if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const city = await insertCityRow(conn, parsed.fields);
        await conn.commit();
        if (city) city.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(city.hidden_home_tabs) : [];
        return jsonReply(res, { ok: true, city }, 201);
      } catch (e) {
        return cityDupReply(res, e);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/cities/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/cities\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const cid = parseInt(m[1], 10);
        const body = await readBody(req);
        const parsed = housingCities
          ? housingCities.validateCityWrite(body, { partial: true })
          : { ok: false, error: '无更新字段', status: 400 };
        if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
          const city = await updateCityRow(conn, cid, parsed.fields);
          await conn.commit();
          catalogMemoInvalidateAll();
          if (city) city.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(city.hidden_home_tabs) : [];
          return jsonReply(res, { ok: true, city });
        } catch (e) {
          return cityDupReply(res, e);
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/cities/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/cities\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const cid = parseInt(m[1], 10);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
          const [[cityCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM cities');
          const [[distCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM districts WHERE city_id=?', [cid]);
          const [[projCnt]] = await conn.execute('SELECT COUNT(*) AS c FROM projects WHERE city_id=?', [cid]);
          const guard = housingCities
            ? housingCities.canDeleteCity({
              cityCount: cityCnt.c, districtCount: distCnt.c, projectCount: projCnt.c,
            })
            : { ok: true };
          if (!guard.ok) { conn.end(); return jsonReply(res, { error: guard.error }, guard.status); }
          await conn.execute('DELETE FROM cities WHERE id=?', [cid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // PUT /admin/city（兼容旧前端：按 city_id 更新，缺省第一座；无城市则创建）
    if (urlPath === '/api/juzhu/admin/city' && req.method === 'PUT') {
      const body = await readBody(req);
      const parsed = housingCities
        ? housingCities.validateCityWrite(body)
        : { ok: !!(body.name || '').trim(), error: '城市名称不能为空', status: 400, fields: { name: (body.name || '').trim(), slug: (body.slug || '').trim() || slugify(body.name) } };
      if (!parsed.ok) return jsonReply(res, { error: parsed.error }, parsed.status);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        let cid = null;
        if (body.city_id != null && String(body.city_id).trim() !== '') {
          cid = parseInt(body.city_id, 10);
          const [existing] = await conn.execute('SELECT id FROM cities WHERE id=?', [cid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '城市不存在' }, 404); }
        } else {
          const [rows] = await conn.execute('SELECT id FROM cities ORDER BY id LIMIT 1');
          cid = rows.length ? rows[0].id : null;
        }
        let city;
        if (!cid) city = await insertCityRow(conn, parsed.fields);
        else city = await updateCityRow(conn, cid, parsed.fields);
        await conn.commit();
        return jsonReply(res, { ok: true, city });
      } catch (e) {
        return cityDupReply(res, e);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/channels/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/channels\/([^/]+)$/);
      if (m && req.method === 'PUT') {
        const channelId = m[1];
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM channels WHERE id=?', [channelId]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '频道不存在' }, 404); }
          const fields = [], params = [];
          if ('label' in body) {
            const label = (body.label || '').trim();
            if (!label) { conn.end(); return jsonReply(res, { error: '频道名称不能为空' }, 400); }
            fields.push('label=?'); params.push(label);
          }
          if ('sort_order' in body) { fields.push('sort_order=?'); params.push(parseInt(body.sort_order) || 0); }
          if ('enabled' in body) { fields.push('enabled=?'); params.push(body.enabled ? 1 : 0); }
          if ('note' in body) { fields.push('note=?'); params.push((body.note || '').trim() || null); }
          if ('hidden_cities' in body) {
            const hc = body.hidden_cities;
            const hcVal = (Array.isArray(hc) && hc.length) ? JSON.stringify(hc) : (hc ? String(hc) : null);
            fields.push('hidden_cities=?'); params.push(hcVal);
          }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          params.push(channelId);
          await conn.execute(`UPDATE channels SET ${fields.join(', ')} WHERE id=?`, params);
          await conn.commit();
          const [ch] = await conn.execute('SELECT * FROM channels WHERE id=?', [channelId]);
          return jsonReply(res, { ok: true, channel: ch[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/districts
    if (urlPath === '/api/juzhu/admin/districts' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '行政区名称不能为空' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const resolved = await resolveBodyCityId(conn, body);
        if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
        const cityId = resolved.cityId;
        const slug = (body.slug || name).trim() || name;
        const [existing] = await conn.execute('SELECT id FROM districts WHERE city_id=? AND slug=?', [cityId, slug]);
        if (existing.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        await conn.execute(
          'INSERT INTO districts(city_id, name, slug, note, sort_order, cover_image, has_projects) VALUES (?,?,?,?,?,?,?)',
          [cityId, name, slug, (body.note || '').trim() || null, parseInt(body.sort_order) || 999,
           (body.cover_image || '').trim() || null, parseInt(body.has_projects) || 0]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const did = r[0].id;
        await syncDistrictStats(conn, did);
        await conn.commit();
        const [districts] = await conn.execute('SELECT * FROM districts WHERE id=?', [did]);
        return jsonReply(res, { ok: true, district: districts[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/districts/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/districts\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const did = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM districts WHERE id=?', [did]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '行政区不存在' }, 404); }
          const mapping = { name: 'name', slug: 'slug', note: 'note', sort_order: 'sort_order',
            cover_image: 'cover_image', is_hot: 'is_hot', layout_tall: 'layout_tall',
            layout_wide: 'layout_wide', bg_class: 'bg_class', has_projects: 'has_projects' };
          const fields = [], params = [];
          for (const [key, col] of Object.entries(mapping)) {
            if (key in body) {
              let val = body[key];
              if (['sort_order','is_hot','layout_tall','layout_wide','has_projects'].includes(key)) {
                val = (val !== null && val !== '') ? parseInt(val) : 0;
              } else if (typeof val === 'string') {
                val = val.trim() || null;
              }
              fields.push(`${col}=?`); params.push(val);
            }
          }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          params.push(did);
          await conn.execute(`UPDATE districts SET ${fields.join(', ')} WHERE id=?`, params);
          await syncDistrictStats(conn, did);
          await conn.commit();
          const [districts] = await conn.execute('SELECT * FROM districts WHERE id=?', [did]);
          return jsonReply(res, { ok: true, district: districts[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/districts/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/districts\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const did = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cnt] = await conn.execute('SELECT COUNT(*) AS c FROM projects WHERE district_id=?', [did]);
          if (cnt[0].c > 0) { conn.end(); return jsonReply(res, { error: `该区仍有 ${cnt[0].c} 个项目，无法删除` }, 400); }
          const [existing] = await conn.execute('SELECT id FROM districts WHERE id=?', [did]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '行政区不存在' }, 404); }
          await conn.execute('DELETE FROM districts WHERE id=?', [did]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // ===== 周边玩法字典（spots / project_spots，规则 17）=====
    // SPOT_TYPES 单一数据源：scenic=景区 | biz=商圈（可扩展；改这里别在页面另造枚举）
    const SPOT_TYPES = ['scenic', 'biz', 'food', 'cafe'];
    const SPOT_TYPE_LABELS = { scenic: '景区', biz: '商圈', food: '美食', cafe: '咖啡' };
    const SPOT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;

    // GET /admin/spots（字典全量；?type=&city_id= 可选过滤）
    if (urlPath === '/api/juzhu/admin/spots' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const conds = [], params = [];
      if (qp.get('type')) { conds.push('type=?'); params.push(qp.get('type')); }
      if (qp.get('city_id')) { conds.push('city_id=?'); params.push(parseInt(qp.get('city_id'))); }
      const rows = await queryRows(
        'SELECT * FROM spots' + (conds.length ? ' WHERE ' + conds.join(' AND ') : '') + ' ORDER BY type, sort_order, id',
        params
      );
      rows.forEach((r) => parseJsonFields(r, ['tags']));
      return jsonReply(res, rows);
    }

    // POST /admin/spots
    if (urlPath === '/api/juzhu/admin/spots' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '名称不能为空' }, 400);
      const type = body.type || 'scenic';
      if (!SPOT_TYPES.includes(type)) return jsonReply(res, { error: 'type 须为 ' + SPOT_TYPES.join('/') }, 400);
      let slug = (body.slug || '').trim();
      if (!slug) slug = 'spot-' + Date.now().toString(36);
      if (!SPOT_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [dup] = await conn.execute('SELECT id FROM spots WHERE slug=?', [slug]);
        if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        await conn.execute(
          'INSERT INTO spots(city_id, type, name, slug, icon, cover_image, summary, body, photos, address, duration, ticket, tags, link, sort_order, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [body.city_id ? parseInt(body.city_id) : null, type, name, slug,
           (body.icon || '').trim() || null, (body.cover_image || '').trim() || null,
           (body.summary || '').trim() || null,
           (body.body || '').trim() || null,
           Array.isArray(body.photos) ? JSON.stringify(body.photos) : null,
           (body.address || '').trim() || null, (body.duration || '').trim() || null,
           (body.ticket || '').trim() || null,
           Array.isArray(body.tags) ? JSON.stringify(body.tags) : null,
           (body.link || '').trim() || null, parseInt(body.sort_order) || 999,
           body.enabled === 0 || body.enabled === '0' ? 0 : 1]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const [rows] = await conn.execute('SELECT * FROM spots WHERE id=?', [r[0].id]);
        await conn.commit();
        return jsonReply(res, { ok: true, spot: rows[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/spots/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/spots\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const sid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '地点不存在' }, 404); }
          if (body.type != null && !SPOT_TYPES.includes(body.type)) {
            conn.end(); return jsonReply(res, { error: 'type 须为 ' + SPOT_TYPES.join('/') }, 400);
          }
          const mapping = { name: 'name', slug: 'slug', type: 'type', city_id: 'city_id', icon: 'icon',
            cover_image: 'cover_image', summary: 'summary', body: 'body', photos: 'photos',
            address: 'address', duration: 'duration', ticket: 'ticket',
            tags: 'tags', link: 'link', sort_order: 'sort_order', enabled: 'enabled' };
          const fields = [], params = [];
          for (const [key, col] of Object.entries(mapping)) {
            if (!(key in body)) continue;
            let val = body[key];
            if (key === 'sort_order') val = parseInt(val) || 0;
            else if (key === 'enabled') val = (val === 0 || val === '0') ? 0 : 1;
            else if (key === 'city_id') val = val ? parseInt(val) : null;
            else if (key === 'tags' || key === 'photos') val = Array.isArray(val) ? JSON.stringify(val) : (val || null);
            else if (typeof val === 'string') val = val.trim() || null;
            if (key === 'slug' && val && !SPOT_SLUG_RE.test(val)) {
              conn.end(); return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
            }
            fields.push(`${col}=?`); params.push(val);
          }
          if (!fields.length) { conn.end(); return jsonReply(res, { error: '无更新字段' }, 400); }
          if (body.slug != null) {
            const [dup] = await conn.execute('SELECT id FROM spots WHERE slug=? AND id<>?', [body.slug, sid]);
            if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
          }
          params.push(sid);
          await conn.execute(`UPDATE spots SET ${fields.join(', ')} WHERE id=?`, params);
          await conn.commit();
          const [rows] = await conn.execute('SELECT * FROM spots WHERE id=?', [sid]);
          return jsonReply(res, { ok: true, spot: rows[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/spots/:id（被项目绑定中则拒绝，先在项目里解除绑定）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/spots\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const sid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [cnt] = await conn.execute('SELECT COUNT(*) AS c FROM project_spots WHERE spot_id=?', [sid]);
          if (cnt[0].c > 0) { conn.end(); return jsonReply(res, { error: `该地点仍被 ${cnt[0].c} 个项目绑定，请先在项目里解除绑定` }, 400); }
          const [existing] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: '地点不存在' }, 404); }
          await conn.execute('DELETE FROM spots WHERE id=?', [sid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/projects/:id/spots（绑定列表） / PUT（整体替换绑定）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/spots$/);
      if (m && (req.method === 'GET' || req.method === 'PUT')) {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          if (req.method === 'GET') {
            const [rows] = await conn.execute(
              'SELECT ps.spot_id, ps.note, ps.sort_order, s.name, s.type, s.icon, s.slug, s.cover_image ' +
              'FROM project_spots ps JOIN spots s ON s.id=ps.spot_id WHERE ps.project_id=? ORDER BY ps.sort_order, ps.id', [pid]);
            return jsonReply(res, { ok: true, bindings: rows });
          }
          // PUT：整体替换（草稿式编辑，一次保存全量提交；会覆盖同项目的并发编辑）
          const body = await readBody(req);
          const list = Array.isArray(body.bindings) ? body.bindings : [];
          if (list.length > 12) return jsonReply(res, { error: '最多绑定 12 处（保持 C 端区块克制）' }, 400);
          const seen = new Set();
          for (const b of list) {
            const sid = parseInt(b && b.spot_id, 10);
            if (!sid) return jsonReply(res, { error: 'bindings 里存在无效 spot_id' }, 400);
            if (seen.has(sid)) return jsonReply(res, { error: '同一地点重复绑定' }, 400);
            seen.add(sid);
          }
          for (const sid of seen) {
            const [ex] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
            if (!ex.length) return jsonReply(res, { error: `地点 #${sid} 不存在` }, 400);
          }
          await conn.beginTransaction();
          await conn.execute('DELETE FROM project_spots WHERE project_id=?', [pid]);
          for (const b of list) {
            await conn.execute(
              'INSERT INTO project_spots(project_id, spot_id, note, sort_order) VALUES (?,?,?,?)',
              [pid, parseInt(b.spot_id, 10), ((b.note || '') + '').trim().slice(0, 120) || null, parseInt(b.sort_order) || 0]);
          }
          await conn.commit();
          const [rows] = await conn.execute(
            'SELECT ps.spot_id, ps.note, ps.sort_order, s.name, s.type FROM project_spots ps JOIN spots s ON s.id=ps.spot_id WHERE ps.project_id=? ORDER BY ps.sort_order, ps.id', [pid]);
          return jsonReply(res, { ok: true, bindings: rows });
        } catch (e) {
          try { await conn.rollback(); } catch (_) {}
          throw e;
        } finally {
          await conn.end();
        }
      }
    }

    // ===== 内容域：旅游路线（routes）+ 房源专题（settings KV topic_*）=====
    // 与 spots 同属内容编辑口径（house.write，规则 17/18）；专题 = 房源筛选条件（规则 15），
    // 路线 = spots 的有序编排（站点内容仍在 spots 单一数据源，不复制正文）。
    const ROUTE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;
    const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}$/;

    // GET /admin/routes（全量含未上架；?city_id= 可选过滤）
    if (urlPath === '/api/juzhu/admin/routes' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const rows = qp.get('city_id')
        ? await queryRows('SELECT * FROM routes WHERE city_id=? OR city_id IS NULL ORDER BY sort_order, id', [parseInt(qp.get('city_id'))])
        : await queryRows('SELECT * FROM routes ORDER BY sort_order, id');
      rows.forEach((r) => { try { r.stops = r.stops ? JSON.parse(r.stops) : []; } catch (_) { r.stops = []; } });
      return jsonReply(res, rows);
    }

    // POST /admin/routes
    if (urlPath === '/api/juzhu/admin/routes' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      if (!name) return jsonReply(res, { error: '路线名称不能为空' }, 400);
      let slug = (body.slug || '').trim();
      if (!slug) slug = 'route-' + Date.now().toString(36);
      if (!ROUTE_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符（用作 C 端深链）' }, 400);
      const stops = Array.isArray(body.stops) ? body.stops : [];
      if (stops.length > 12) return jsonReply(res, { error: '单条路线最多 12 个点位（保持行程克制）' }, 400);
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const [dup] = await conn.execute('SELECT id FROM routes WHERE slug=?', [slug]);
        if (dup.length) { conn.end(); return jsonReply(res, { error: 'slug 已存在' }, 400); }
        for (const s of stops) {
          const sid = parseInt(s && s.spot_id, 10);
          if (!sid) { conn.end(); return jsonReply(res, { error: 'stops 里存在无效 spot_id' }, 400); }
          const [ex] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: `点位 #${sid} 不存在` }, 400); }
        }
        await conn.execute(
          'INSERT INTO routes(city_id, slug, name, summary, cover_image, days, stops, sort_order, enabled) VALUES (?,?,?,?,?,?,?,?,?)',
          [body.city_id ? parseInt(body.city_id) : null, slug, name,
           (body.summary || '').trim() || null, (body.cover_image || '').trim() || null,
           Math.min(30, Math.max(1, parseInt(body.days) || 1)),
           JSON.stringify(stops.map((s) => ({ spot_id: parseInt(s.spot_id, 10), note: ((s.note || '') + '').trim().slice(0, 120) || '' }))),
           parseInt(body.sort_order) || 999,
           (body.enabled === false || body.enabled === 0 || body.enabled === '0') ? 0 : 1]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const [rows] = await conn.execute('SELECT * FROM routes WHERE id=?', [r[0].id]);
        await conn.commit();
        return jsonReply(res, { ok: true, route: rows[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/routes/:id（全量更新）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/routes\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const rid = parseInt(m[1]);
        const body = await readBody(req);
        const name = (body.name || '').trim();
        if (!name) return jsonReply(res, { error: '路线名称不能为空' }, 400);
        const stops = Array.isArray(body.stops) ? body.stops : [];
        if (stops.length > 12) return jsonReply(res, { error: '单条路线最多 12 个点位（保持行程克制）' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [ex] = await conn.execute('SELECT id FROM routes WHERE id=?', [rid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: '路线不存在' }, 404); }
          for (const s of stops) {
            const sid = parseInt(s && s.spot_id, 10);
            if (!sid) { conn.end(); return jsonReply(res, { error: 'stops 里存在无效 spot_id' }, 400); }
            const [sp] = await conn.execute('SELECT id FROM spots WHERE id=?', [sid]);
            if (!sp.length) { conn.end(); return jsonReply(res, { error: `点位 #${sid} 不存在` }, 400); }
          }
          await conn.execute(
            'UPDATE routes SET city_id=?, name=?, summary=?, cover_image=?, days=?, stops=?, sort_order=?, enabled=? WHERE id=?',
            [body.city_id ? parseInt(body.city_id) : null, name,
             (body.summary || '').trim() || null, (body.cover_image || '').trim() || null,
             Math.min(30, Math.max(1, parseInt(body.days) || 1)),
             JSON.stringify(stops.map((s) => ({ spot_id: parseInt(s.spot_id, 10), note: ((s.note || '') + '').trim().slice(0, 120) || '' }))),
             parseInt(body.sort_order) || 999,
             (body.enabled === false || body.enabled === 0 || body.enabled === '0') ? 0 : 1,
             rid]
          );
          const [rows] = await conn.execute('SELECT * FROM routes WHERE id=?', [rid]);
          await conn.commit();
          return jsonReply(res, { ok: true, route: rows[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/routes/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/routes\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const rid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [ex] = await conn.execute('SELECT id FROM routes WHERE id=?', [rid]);
          if (!ex.length) { conn.end(); return jsonReply(res, { error: '路线不存在' }, 404); }
          await conn.execute('DELETE FROM routes WHERE id=?', [rid]);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/topics —— settings KV topic_* 清单（slug/label/channel/tags/enabled）
    if (urlPath === '/api/juzhu/admin/topics' && req.method === 'GET') {
      const rows = await queryRows("SELECT `key`, value FROM settings WHERE `key` LIKE 'topic\\_%'");
      const topics = rows.map((r) => {
        const slug = String(r.key).replace(/^topic_/, '');
        let crit = {};
        try { crit = JSON.parse(r.value || '{}'); } catch (_) { crit = {}; }
        return { slug, label: crit.label || slug, channel: crit.channel || null, tags: Array.isArray(crit.tags) ? crit.tags : [], enabled: crit.enabled !== false, desc: crit.desc || '', cover_image: crit.cover_image || '' };
      }).sort((a, b) => a.slug.localeCompare(b.slug));
      return jsonReply(res, topics);
    }

    // PUT /admin/topics/:slug（upsert；专题 = 房源筛选条件，tags 至少 1 个）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/topics\/([a-z0-9][a-z0-9-]*)$/);
      if (m && req.method === 'PUT') {
        const slug = m[1];
        if (!TOPIC_SLUG_RE.test(slug)) return jsonReply(res, { error: 'slug 须为小写字母/数字/连字符' }, 400);
        const body = await readBody(req);
        const label = (body.label || '').trim();
        if (!label) return jsonReply(res, { error: '专题名称不能为空' }, 400);
        const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t || '').trim()).filter(Boolean) : [];
        if (!tags.length) return jsonReply(res, { error: '专题至少需要 1 个 tag 条件（专题=筛选条件，规则 15）' }, 400);
        const crit = { label, tags };
        if (body.channel) crit.channel = String(body.channel);
        const desc = (body.desc || '').trim(); if (desc) crit.desc = desc;
        const cover = (body.cover_image || '').trim(); if (cover) crit.cover_image = cover;
        // enabled 接受布尔 false / 0 / '0'（admin UI 传布尔，脚本可能传 0）
        crit.enabled = !(body.enabled === false || body.enabled === 0 || body.enabled === '0');
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          await conn.execute(
            'INSERT INTO settings(`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)',
            ['topic_' + slug, JSON.stringify(crit)]
          );
          await conn.commit();
          catalogMemoInvalidateTopics();
          return jsonReply(res, { ok: true, topic: { slug, label, channel: crit.channel || null, tags, enabled: crit.enabled } });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/topics/:slug（bzf 保租房专区是规则 15 既有契约，禁止删除）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/topics\/([a-z0-9][a-z0-9-]*)$/);
      if (m && req.method === 'DELETE') {
        if (m[1] === 'bzf') return jsonReply(res, { error: 'topic_bzf 是保租房专区既有契约（规则 15），不可删除；可编辑或下架' }, 400);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute('DELETE FROM settings WHERE `key`=?', ['topic_' + m[1]]);
          if (!r.affectedRows) { conn.end(); return jsonReply(res, { error: '专题不存在' }, 404); }
          await conn.commit();
          catalogMemoInvalidateTopics();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/projects
    if (urlPath === '/api/juzhu/admin/projects' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const channel = body.channel || 'rental';
      const HOUSING_CHANNELS = ['rental', 'minsu', 'newhouse', 'resale'];
      if (!name) return jsonReply(res, { error: '项目名称不能为空' }, 400);
      if (!HOUSING_CHANNELS.includes(channel) && channel !== 'trade') {
        return jsonReply(res, { error: 'channel 须为 rental/minsu/newhouse/resale/trade' }, 400);
      }
      if (['rental', 'minsu'].includes(channel) && String(body.status || '').toLowerCase() === 'online') {
        return jsonReply(res, { error: '新建房源必须先保存为 draft，完成商家/房源审核后再上架' }, 400);
      }
      let projectExt = null;
      try { projectExt = normalizeProjectExtInput(body.ext, channel); }
      catch (e) { return jsonReply(res, { error: e.message }, 400); }
      const conn = await mysql2.createConnection(getDbConfig());
      try {
        const resolved = await resolveBodyCityId(conn, body, '未配置城市');
        if (resolved.error) { conn.end(); return jsonReply(res, { error: resolved.error }, resolved.status); }
        const cityId = resolved.cityId;
        let districtId = body.district_id || null;
        if (HOUSING_CHANNELS.includes(channel)) {
          if (!districtId) { conn.end(); return jsonReply(res, { error: '房源项目须选择行政区' }, 400); }
          const [d] = await conn.execute('SELECT id FROM districts WHERE id=? AND city_id=?', [districtId, cityId]);
          if (!d.length) { conn.end(); return jsonReply(res, { error: '行政区不存在或不属于当前城市' }, 400); }
        } else {
          districtId = null;
        }
        const slug = await uniqueProjectSlug(conn, channel, name, body.slug);
        const [cityRows] = await conn.execute('SELECT name FROM cities WHERE id=?', [cityId]);
        const cityName = cityRows.length ? cityRows[0].name : '';
        let address = body.address;
        if (!address) {
          if (districtId) {
            const [d] = await conn.execute('SELECT name FROM districts WHERE id=?', [districtId]);
            address = d.length ? `${d[0].name} · ${name}` : `${cityName} · ${name}`;
          } else {
            address = `${cityName} · ${name}`;
          }
        }
        let contactPhone = null;
        try {
          contactPhone = 'contact_phone' in body ? validateRealPhone(body.contact_phone) : null;
        } catch (e) {
          conn.end();
          return jsonReply(res, { error: e.message }, 400);
        }
        let ownerVendorId = null;
        if (body.owner_vendor_id != null && body.owner_vendor_id !== '') {
          const [v] = await conn.execute('SELECT id FROM jz_vendors WHERE id=?', [parseInt(body.owner_vendor_id, 10)]);
          if (!v.length) { conn.end(); return jsonReply(res, { error: '商家不存在' }, 400); }
          ownerVendorId = parseInt(body.owner_vendor_id, 10);
        }
        await conn.execute(
          `INSERT INTO projects(city_id,district_id,channel,name,slug,cover_image,address,tags,
            sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint,contact_phone)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,COALESCE(?,0),?,?,?)`,
          [cityId, districtId, channel, name, slug, body.cover_image || null, address,
           encodeTags(body.tags),
           body.sort_order || 999, body.price_from || null,
           body.is_featured ? 1 : 0, body.featured_rank || null, body.old_house_hint || null,
           contactPhone]
        );
        const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
        const pid = r[0].id;
        if (ownerVendorId != null || body.status != null || projectExt != null) {
          await conn.execute(
            'UPDATE projects SET owner_vendor_id=COALESCE(?, owner_vendor_id), status=COALESCE(?, status), ext=COALESCE(?, ext) WHERE id=?',
            [ownerVendorId,
             body.status != null ? String(body.status) : null,
             projectExt != null ? JSON.stringify(projectExt) : null,
             pid]
          );
        }
        if (districtId) await syncDistrictStats(conn, districtId);
        await conn.commit();
        const [projs] = await conn.execute(
          'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
          [pid]
        );
        parseJsonFields(projs[0], ['tags', 'rating']);
        return jsonReply(res, { ok: true, project: projs[0] }, 201);
      } finally {
        await conn.end();
      }
    }

    // PUT /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const pid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [existing] = await conn.execute('SELECT id, channel FROM projects WHERE id=?', [pid]);
          if (!existing.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const sets = [], vals = [];
          const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
          if ('name' in body) {
            put('name', body.name);
            put('slug', body.slug || slugify(body.name));
          } else if ('slug' in body) {
            put('slug', body.slug);
          }
          for (const col of ['address', 'cover_image', 'sort_order', 'price_from',
              'is_featured', 'featured_rank', 'old_house_hint', 'status']) {
            if (col in body) put(col, body[col]);
          }
          if ('ext' in body) {
            try {
              const ext = normalizeProjectExtInput(body.ext, existing[0].channel);
              put('ext', ext != null ? JSON.stringify(ext) : null);
            } catch (e) {
              conn.end();
              return jsonReply(res, { error: e.message }, 400);
            }
          }
          if ('owner_vendor_id' in body) {
            const val = body.owner_vendor_id;
            if (val === null || val === '') { conn.end(); return jsonReply(res, { error: 'owner_vendor_id 不可为空（商家维度必挂）' }, 400); }
            const [v] = await conn.execute('SELECT id FROM jz_vendors WHERE id=?', [parseInt(val, 10)]);
            if (!v.length) { conn.end(); return jsonReply(res, { error: '商家不存在' }, 400); }
            put('owner_vendor_id', parseInt(val, 10));
          }
          try {
            const contactPhone = contactPhoneFromBody(body);
            if (contactPhone !== undefined) put('contact_phone', contactPhone);
          } catch (e) {
            conn.end();
            return jsonReply(res, { error: e.message }, 400);
          }
          if ('tags' in body) put('tags', encodeTags(body.tags));
          if ('managed_unit_count' in body) {
            const val = body.managed_unit_count;
            put('managed_unit_count', (val !== null && val !== '') ? parseInt(val) : null);
          }
          if ('rating' in body) {
            const [statRow] = await conn.execute('SELECT rating_status FROM projects WHERE id=?', [pid]);
            if (statRow.length && ['draft', 'rejected', null].includes(statRow[0].rating_status)) {
              put('rating', body.rating ? JSON.stringify(body.rating) : null);
            }
          }
          if (sets.length) {
            vals.push(pid);
            await conn.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`, vals);
          }
          await syncProjectUnitCount(conn, pid);
          const [distRow] = await conn.execute('SELECT district_id FROM projects WHERE id=?', [pid]);
          if (distRow.length && distRow[0].district_id) {
            await syncDistrictStats(conn, distRow[0].district_id);
          }
          await conn.commit();
          const [projs] = await conn.execute(
            'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
            [pid]
          );
          parseJsonFields(projs[0], ['tags', 'rating']);
          return jsonReply(res, { ok: true, project: projs[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/projects/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT district_id FROM projects WHERE id=?', [pid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const did = rows[0].district_id;
          // 删除关联 photos、units
          const [units] = await conn.execute('SELECT id FROM units WHERE project_id=?', [pid]);
          for (const u of units) {
            await conn.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id=?", [u.id]);
          }
          await conn.execute('DELETE FROM units WHERE project_id=?', [pid]);
          await conn.execute('DELETE FROM projects WHERE id=?', [pid]);
          if (did) await syncDistrictStats(conn, did);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/projects/:id/units
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/units$/);
      if (m && req.method === 'POST') {
        const pid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [projs] = await conn.execute('SELECT id, channel FROM projects WHERE id=?', [pid]);
          if (!projs.length) { conn.end(); return jsonReply(res, { error: 'project not found' }, 404); }
          const name = body.name || '新户型';
          const slug = await uniqueUnitSlug(conn, pid, name, body.slug);
          let unitExt = null;
          try { unitExt = normalizeUnitExtInput(body.ext, projs[0].channel); }
          catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
          await conn.execute(
            `INSERT INTO units(project_id,name,slug,area_sqm,layout_label,rent_monthly,price_total,
              tags,unit_spec,promo_price,amenities,keeper,rent_detail,sort_order,cover_image,ext)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [pid, name, slug, body.area_sqm || null, body.layout_label || null,
             body.rent_monthly || null, body.price_total || null,
             encodeTags(body.tags),
             body.unit_spec || null, body.promo_price || null,
             body.amenities ? JSON.stringify(body.amenities) : null,
             body.keeper ? JSON.stringify(body.keeper) : null,
             body.rent_detail ? JSON.stringify(body.rent_detail) : null,
             body.sort_order || 999, body.cover_image || null,
             unitExt != null ? JSON.stringify(unitExt) : null]
          );
          const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
          const uid = r[0].id;
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          const [units] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
          parseJsonFields(units[0], ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']);
          return jsonReply(res, { ok: true, unit: units[0] }, 201);
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'GET') {
        const uid = parseInt(m[1]);
        const units = await queryRows('SELECT * FROM units WHERE id=?', [uid]);
        if (!units.length) return jsonReply(res, { error: 'not found' }, 404);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order",
          [uid]
        );
        return jsonReply(res, { unit: units[0], photos });
      }
    }

    // PUT /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const uid = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            'SELECT u.project_id, p.channel AS channel FROM units u JOIN projects p ON p.id=u.project_id WHERE u.id=?', [uid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const pid = rows[0].project_id;
          const sets = [], vals = [];
          const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
          if ('name' in body) {
            put('name', body.name);
            put('slug', await uniqueUnitSlug(conn, pid, body.name, body.slug, uid));
          } else if ('slug' in body) {
            put('slug', await uniqueUnitSlug(conn, pid, null, body.slug, uid));
          }
          for (const col of ['area_sqm','layout_label','rent_monthly','price_total',
              'unit_spec','promo_price','sort_order','cover_image']) {
            if (col in body) put(col, body[col]);
          }
          if ('total_qty' in body) {
            // 总间数（多间库存 2026-09-10）：1-999；不得低于未来晚已订间数（否则隐性超售）
            const tq = parseInt(body.total_qty, 10);
            if (!(tq >= 1 && tq <= 999)) { conn.end(); return jsonReply(res, { error: 'total_qty（总间数）须为 1-999 的整数' }, 400); }
            const [bmax] = await conn.execute(
              `SELECT COALESCE(MAX(GREATEST(booked_qty, status='booked')), 0) AS m FROM stay_calendar
               WHERE unit_id=? AND stay_date>=CURDATE()`, [uid]);
            if (Number(bmax[0].m) > tq) { conn.end(); return jsonReply(res, { error: `未来已有晚的已订间数达 ${bmax[0].m}，total_qty 不得低于该值` }, 400); }
            put('total_qty', tq);
          }
          if ('ext' in body) {
            // 服务端兜底：ext.cancel_policy 过单一数据源校验，防管理端拼错口径（规则15 差异属性放 ext）
            if (body.ext && typeof body.ext === 'object' && !Array.isArray(body.ext) && 'cancel_policy' in body.ext) {
              try { body.ext.cancel_policy = body.ext.cancel_policy === null ? undefined : normalizeCancelPolicyInput(body.ext.cancel_policy); }
              catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
            }
            try {
              const ext = normalizeUnitExtInput(body.ext, rows[0].channel);
              put('ext', ext != null ? JSON.stringify(ext) : null);
            } catch (e) {
              conn.end();
              return jsonReply(res, { error: e.message }, 400);
            }
          }
          if ('tags' in body) put('tags', encodeTags(body.tags));
          if ('amenities' in body) put('amenities', body.amenities ? JSON.stringify(body.amenities) : null);
          if ('keeper' in body) put('keeper', body.keeper ? JSON.stringify(body.keeper) : null);
          if ('rent_detail' in body) put('rent_detail', body.rent_detail ? JSON.stringify(body.rent_detail) : null);
          if (sets.length) {
            vals.push(uid);
            await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, vals);
          }
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          const [units] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
          parseJsonFields(units[0], ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']);
          return jsonReply(res, { ok: true, unit: units[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/units/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const uid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT project_id FROM units WHERE id=?', [uid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const pid = rows[0].project_id;
          await conn.execute("DELETE FROM photos WHERE entity_type='unit' AND entity_id=?", [uid]);
          await conn.execute('DELETE FROM units WHERE id=?', [uid]);
          await syncProjectUnitCount(conn, pid);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // GET /admin/units/:id/photos
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)\/photos$/);
      if (m && req.method === 'GET') {
        const uid = parseInt(m[1]);
        const units = await queryRows('SELECT id FROM units WHERE id=?', [uid]);
        if (!units.length) return jsonReply(res, { error: 'unit not found' }, 404);
        const photos = await queryRows(
          "SELECT * FROM photos WHERE entity_type='unit' AND entity_id=? ORDER BY sort_order, id",
          [uid]
        );
        return jsonReply(res, { photos });
      }
    }

    // POST /admin/units/:id/photos  （仅支持 JSON body，不支持文件上传）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/units\/(\d+)\/photos$/);
      if (m && req.method === 'POST') {
        const uid = parseInt(m[1]);
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
          return jsonReply(res, { error: '文件上传请使用 /api/juzhu/admin/upload 接口，Serverless 环境不支持直接上传图片到本机文件系统' }, 503);
        }
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [units] = await conn.execute('SELECT id FROM units WHERE id=?', [uid]);
          if (!units.length) { conn.end(); return jsonReply(res, { error: 'unit not found' }, 404); }
          const filePath = (body.file_path || '').trim();
          if (!filePath) { conn.end(); return jsonReply(res, { error: 'file_path 不能为空' }, 400); }
          const isCover = body.is_cover ? 1 : 0;
          let sortOrder = body.sort_order;
          if (sortOrder == null) {
            const [r] = await conn.execute(
              "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM photos WHERE entity_type='unit' AND entity_id=?",
              [uid]
            );
            sortOrder = r[0].n;
          }
          if (isCover) {
            await conn.execute("UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?", [uid]);
          }
          await conn.execute(
            "INSERT INTO photos(entity_type, entity_id, file_path, source_path, is_cover, sort_order) VALUES ('unit', ?, ?, ?, ?, ?)",
            [uid, filePath, body.source_path || null, isCover, sortOrder]
          );
          const [r] = await conn.execute('SELECT LAST_INSERT_ID() AS id');
          const photoId = r[0].id;
          await syncUnitCover(conn, uid);
          await conn.commit();
          const [photos] = await conn.execute('SELECT * FROM photos WHERE id=?', [photoId]);
          return jsonReply(res, { ok: true, photo: photos[0] }, 201);
        } finally {
          await conn.end();
        }
      }
    }

    // PUT /admin/photos/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/photos\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const photoId = parseInt(m[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'", [photoId]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const uid = rows[0].entity_id;
          if (body.is_cover) {
            await conn.execute("UPDATE photos SET is_cover=0 WHERE entity_type='unit' AND entity_id=?", [uid]);
          }
          let isCoverVal = null;
          if ('is_cover' in body) isCoverVal = body.is_cover ? 1 : 0;
          let categoryVal = null;
          if ('category' in body) {
            try { categoryVal = photoCfg.normalizeCategoryInput(body.category); }
            catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
          }
          await conn.execute(
            `UPDATE photos SET
               file_path=COALESCE(?, file_path),
               sort_order=COALESCE(?, sort_order),
               is_cover=COALESCE(?, is_cover),
               category=COALESCE(?, category)
             WHERE id=?`,
            [body.file_path ? body.file_path.trim() : null,
             body.sort_order != null ? body.sort_order : null,
             isCoverVal, categoryVal, photoId]
          );
          await syncUnitCover(conn, uid);
          await conn.commit();
          const [photos] = await conn.execute('SELECT * FROM photos WHERE id=?', [photoId]);
          return jsonReply(res, { ok: true, photo: photoCfg.photoOut(photos[0]) });
        } finally {
          await conn.end();
        }
      }
    }

    // DELETE /admin/photos/:id
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/photos\/(\d+)$/);
      if (m && req.method === 'DELETE') {
        const photoId = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute(
            "SELECT entity_id FROM photos WHERE id=? AND entity_type='unit'", [photoId]
          );
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const uid = rows[0].entity_id;
          await conn.execute('DELETE FROM photos WHERE id=?', [photoId]);
          await syncUnitCover(conn, uid);
          await conn.commit();
          return jsonReply(res, { ok: true });
        } finally {
          await conn.end();
        }
      }
    }

    // POST /admin/export（Serverless 无持久文件系统，跳过写文件，返回 ok）
    if (urlPath === '/api/juzhu/admin/export' && req.method === 'POST') {
      return jsonReply(res, { ok: true, stats: { note: 'Serverless 环境跳过 JSON 导出' } });
    }

    // POST /admin/upload（图片上传需要对象存储，此处返回提示）
    if (urlPath === '/api/juzhu/admin/upload' && req.method === 'POST') {
      return jsonReply(res, { error: 'Serverless 环境不支持本地文件上传，请先在外部上传图片并使用图片 URL' }, 503);
    }

    // POST /admin/projects/:id/rating/submit
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/projects\/(\d+)\/rating\/submit$/);
      if (m && req.method === 'POST') {
        const pid = parseInt(m[1]);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
          const proj = rows[0];
          // 权限：房主 vendor 或 platform（admin 会话/API Key）
          const sess = await requestSession(req);
          const owns = sess && sess.role === 'vendor' && proj.owner_vendor_id === sess.vendorId;
          if (!owns && !(await requireApiKey(req, res))) return;
          const dimsReq = RATING_DIMS[proj.channel];
          if (!dimsReq) { conn.end(); return jsonReply(res, { error: '该频道暂不支持评级（支持 rental/minsu）' }, 400); }
          if (proj.rating_status === 'pending') { conn.end(); return jsonReply(res, { error: '已在复核队列中' }, 400); }
          let rating = {};
          if (proj.rating) {
            try { rating = JSON.parse(proj.rating); } catch (_) { rating = {}; }
          }
          const dims = rating.dims || {};
          if (!dimsReq.every(k => dims[k] != null)) {
            conn.end();
            return jsonReply(res, { error: `请先保存 ${dimsReq.length} 维自评分（${proj.channel} 口径）` }, 400);
          }
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          rating.code = `${RATING_CODE_PREFIX[proj.channel] || 'SY'}-${pid}`;
          await conn.execute(
            "UPDATE projects SET rating=?, rating_status='pending', rating_submitted_at=?, rating_note=NULL WHERE id=?",
            [JSON.stringify(rating), now, pid]
          );
          await conn.commit();
          const [updated] = await conn.execute(
            'SELECT p.*, d.name AS district_name FROM projects p LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?',
            [pid]
          );
          return jsonReply(res, { ok: true, project: updated[0] });
        } finally {
          await conn.end();
        }
      }
    }

    // --- from app.js L4800-5022 ---
    // ===== admin auth 接口 =====

    // POST /api/juzhu/admin/auth/login —— 走账号中心（accounts 表）
    // 必须显式 login_name（旧「只传 password 默认唯一 platform_admin」已移除：可被探测账号存在性）
    if (urlPath === '/api/juzhu/admin/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const idName = String(body.login_name || body.username || '').trim();
      const pwd = String(body.password || '');
      if (!idName) return jsonReply(res, { error: '请输入账号' }, 400);
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
      const out = await authCenter.loginWithPassword(idName, pwd, ip, req.headers['user-agent'] || '', { ttlSeconds: authCenter.SESSION_TTL.human_admin });
      if (out.error) return jsonReply(res, { error: out.error, retry_after: out.retry_after }, out.throttled ? 429 : 401);
      return jsonReply(res, {
        token: out.token,
        expires_at: out.expires_at,
        account: out.account,
        roles: out.roles.map((r) => r.role_code),
      });
    }

    // GET /api/juzhu/admin/auth/check
    if (urlPath === '/api/juzhu/admin/auth/check' && req.method === 'GET') {
      const token = extractBearerToken(req);
      const sess = await authCenter.verifySessionToken(token).catch(() => null);
      if (sess) {
        return jsonReply(res, {
          ok: true,
          account: sess.account,
          roles: sess.roles.map((r) => r.role_code),
          permissions: [...authCenter.permissionsOf({ roles: sess.roles })],
        });
      }
      if (verifyAdminLoginToken(token)) {
        const exp = parseInt(token.split('.')[0], 10);
        return jsonReply(res, { ok: true, legacy: true, expires_at: new Date(exp * 1000).toISOString() });
      }
      return jsonReply(res, { ok: false }, 401);
    }

    // ===== 账号中心管理（platform_admin；原生多账号：任何主体直接挂 N 个 account）=====

    // ===== IdP 联邦配置（platform_admin；secret 只写不读）=====
    // GET /api/juzhu/admin/idp-configs（权限已由入口闸按 perm_registry 校验：admin.read）
    if (urlPath === '/api/juzhu/admin/idp-configs' && req.method === 'GET') {
      return jsonReply(res, await authCenter.listIdpConfigs());
    }
    // PUT /api/juzhu/admin/idp-configs —— 新建/更新（body.org_no 为主键维度；client_secret 缺省=不改）
    if (urlPath === '/api/juzhu/admin/idp-configs' && req.method === 'PUT') {
      const body = await readBody(req);
      const wp = req.principal;
      const out = await authCenter.upsertIdpConfig(body, {
        accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
        ip: wp && wp.ip, ua: wp && wp.ua,
      });
      if (out.error) return jsonReply(res, { error: out.error }, 400);
      return jsonReply(res, out);
    }

    // GET /api/juzhu/admin/accounts?vendor_id=&org_id=&principal_type=
    // （权限已由入口闸按 perm_registry 校验：admin.read；旧全局 Key 在闸上已 403）
    if (urlPath === '/api/juzhu/admin/accounts' && req.method === 'GET') {
      return jsonReply(res, await authCenter.listAccounts(Object.fromEntries(new URLSearchParams(qs))));
    }

    // POST /api/juzhu/admin/accounts —— 创建账号（写操作已由入口闸要求 admin.write）
    if (urlPath === '/api/juzhu/admin/accounts' && req.method === 'POST') {
      const body = await readBody(req);
      const wp = req.principal;
      const out = await authCenter.createAccount(body, {
        accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
        ip: wp && wp.ip, ua: wp && wp.ua,
      });
      if (out.error) return jsonReply(res, { error: out.error }, 400);
      return jsonReply(res, out, 201);
    }

    // PUT /api/juzhu/admin/accounts/:id —— 改资料/状态/角色/密码（密码或停用会吊销全部会话）
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/accounts\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const wp = req.principal;
        const out = await authCenter.updateAccount(parseInt(m[1], 10), body, {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        if (out.error) return jsonReply(res, { error: out.error }, out.error === '账号不存在' ? 404 : 400);
        return jsonReply(res, out);
      }
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/accounts\/(\d+)\/api-key$/);
      if (m && req.method === 'POST') {
        const wp = req.principal;
        const out = await authCenter.issueApiKey(parseInt(m[1], 10), {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        if (out.error) return jsonReply(res, { error: out.error }, 404);
        return jsonReply(res, out);
      }
    }

    // ===== 账号中心管理面（B5）：permissions / overview / roles / orgs / sessions =====
    // （各路由权限已由入口闸按 perm_registry 校验，见 ROUTES IAM 管理面段）

    // GET /admin/permissions —— 权限点目录 + 角色赋值矩阵（账号中心「功能权限」页数据源）
    if (urlPath === '/api/juzhu/admin/permissions' && req.method === 'GET') {
      const roles = await authCenter.listRoles();
      return jsonReply(res, {
        perms: permRegistry.PERMS,
        roles: roles.map((r) => ({ role_code: r.role_code, name: r.name, builtin: r.builtin, account_count: r.account_count, permissions: r.permissions })),
      });
    }

    // GET /admin/iam/overview —— 总览卡片
    if (urlPath === '/api/juzhu/admin/iam/overview' && req.method === 'GET') {
      return jsonReply(res, await authCenter.iamOverview());
    }

    // 角色 CRUD
    if (urlPath === '/api/juzhu/admin/roles' && req.method === 'GET') {
      return jsonReply(res, await authCenter.listRoles());
    }
    if (urlPath === '/api/juzhu/admin/roles' && req.method === 'POST') {
      const body = await readBody(req);
      const wp = req.principal;
      const out = await authCenter.createRole(body, {
        accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
        ip: wp && wp.ip, ua: wp && wp.ua,
      });
      if (out.error) return jsonReply(res, { error: out.error }, 400);
      return jsonReply(res, out);
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/roles\/([^/]+)$/);
      if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
        const body = req.method === 'PUT' ? await readBody(req) : {};
        const wp = req.principal;
        const ctx = {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        };
        const out = req.method === 'PUT'
          ? await authCenter.updateRole(decodeURIComponent(m[1]), body, ctx)
          : await authCenter.deleteRole(decodeURIComponent(m[1]), ctx);
        if (out.error) return jsonReply(res, { error: out.error }, 400);
        return jsonReply(res, out);
      }
    }

    // orgs：数据权限配置的机构下拉 + city_ids 维护
    if (urlPath === '/api/juzhu/admin/orgs' && req.method === 'GET') {
      const orgs = await authCenter.listOrgs();
      return jsonReply(res, orgs.map((o) => Object.assign(o, { city_ids: (() => { try { return JSON.parse(o.city_ids || '[]'); } catch (_) { return []; } })() })));
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/orgs\/(\d+)$/);
      if (m && req.method === 'PUT') {
        const body = await readBody(req);
        const wp = req.principal;
        // org.write 非平台主体（有 org 绑定）只能维护本机构
        const isPlatform = wp && wp.type === 'account' && (authCenter.hasPermission(wp, '*') ||
          (!wp.account.org_id && !wp.account.vendor_id));
        if (wp && wp.type === 'account' && !isPlatform && Number(wp.account.org_id) !== parseInt(m[1], 10)) {
          return jsonReply(res, { error: 'forbidden', message: '只能维护本机构信息' }, 403);
        }
        const out = await authCenter.updateOrg(parseInt(m[1], 10), body, {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        if (out.error) return jsonReply(res, { error: out.error }, 400);
        return jsonReply(res, out);
      }
    }

    // 会话管理：列表 / 全部下线 / 单会话下线
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/accounts\/(\d+)\/sessions$/);
      if (m && req.method === 'GET') return jsonReply(res, await authCenter.listSessions(parseInt(m[1], 10)));
      if (m && req.method === 'DELETE') {
        const wp = req.principal;
        const out = await authCenter.revokeAccountSessions(parseInt(m[1], 10), {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        return jsonReply(res, out);
      }
    }
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/sessions\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const wp = req.principal;
        const out = await authCenter.revokeSessionByJti(decodeURIComponent(m[1]), {
          accountId: wp && wp.account && wp.account.id, principalType: 'account', roles: wp && wp.roles,
          ip: wp && wp.ip, ua: wp && wp.ua,
        });
        return jsonReply(res, out);
      }
    }

    // GET /api/juzhu/admin/audit?limit=&action=&account_id=&resource=&result=&from=&to=&ip=&before_id=
    // （权限已由入口闸按 perm_registry 校验：audit.read）
    if (urlPath === '/api/juzhu/admin/audit' && req.method === 'GET') {
      const qp = new URLSearchParams(qs);
      const limit = Math.min(parseInt(qp.get('limit') || '100', 10) || 100, 500);
      const where = [];
      const params = [];
      if (qp.get('action')) { where.push('action LIKE ?'); params.push(qp.get('action') + '%'); }
      if (qp.get('account_id')) { where.push('account_id=?'); params.push(parseInt(qp.get('account_id'), 10)); }
      if (qp.get('resource')) { where.push('resource=?'); params.push(qp.get('resource')); }
      if (qp.get('result')) { where.push('result=?'); params.push(qp.get('result')); }
      if (qp.get('ip')) { where.push('ip=?'); params.push(qp.get('ip')); }
      if (qp.get('from')) { where.push('created_at>=?'); params.push(qp.get('from')); }
      if (qp.get('to')) { where.push('created_at<=?'); params.push(qp.get('to')); }
      if (qp.get('before_id')) { where.push('id<?'); params.push(parseInt(qp.get('before_id'), 10)); }
      const rows = await queryRows(
        `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`,
        params
      );
      return jsonReply(res, rows);
    }

    // --- from app.js L5932-6015 ---
    // GET /api/juzhu/admin/districts（admin 前缀，需鉴权）
    if (urlPath === '/api/juzhu/admin/districts' && req.method === 'GET') {
      if (!(await requireApiKey(req, res))) return;
      const rows = await queryRows('SELECT * FROM districts ORDER BY sort_order');
      return jsonReply(res, rows);
    }

    // POST /api/juzhu/admin/ratings/:code/review
    {
      const m = urlPath.match(/^\/api\/juzhu\/admin\/ratings\/([^/]+)\/review$/);
      if (m && req.method === 'POST') {
        if (!(await requireApiKey(req, res))) return;
        const code = decodeURIComponent(m[1]);
        const idMatch = code.match(/-(\d+)$/);
        if (!idMatch) return jsonReply(res, { error: 'invalid code' }, 400);
        const pid = parseInt(idMatch[1]);
        const body = await readBody(req);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [rows] = await conn.execute('SELECT * FROM projects WHERE id=? AND rating_status=?', [pid, 'pending']);
          if (!rows.length) return jsonReply(res, { error: 'not found or not pending' }, 404);
          const action = body.action === 'pass' ? 'passed' : 'rejected';
          const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          let rating = {};
          try { rating = JSON.parse(rows[0].rating || '{}'); } catch (_) {}
          if (body.dims) rating.dims = body.dims;
          if (body.total != null) rating.total = body.total;
          await conn.execute(
            'UPDATE projects SET rating=?, rating_status=?, rating_reviewed_at=?, rating_note=? WHERE id=?',
            [JSON.stringify(rating), action, now, body.note || null, pid]
          );
          await conn.commit();
          const [updated] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
          let proj = updated[0] || null;
          // 3.1 审核通过自动上架（商家诉求 2026-09-22）：商家经 projects/create|update 配 ext.auto_publish=true 时，
          // 平台复核通过即自动推 online——复用商家开放接口同一套上架闸与图片抽检（housingProjectsStatus），
          // 闸不过保持 draft，原因随响应体与 rating.reviewed webhook 带回；未配置 flag 行为不变。
          let autoPub = null;
          if (action === 'passed' && proj) {
            let extObj = {};
            try { extObj = JSON.parse(proj.ext || '{}') || {}; } catch (_) { extObj = {}; }
            autoPub = { enabled: extObj.auto_publish === true };
            if (autoPub.enabled) {
              autoPub.attempted = true;
              const vapi = vendorApi || require('./vendor_api.cjs');
              const r = await vapi.housingProjectsStatus(conn, { id: pid, status: 'online' }, proj.owner_vendor_id);
              const d = (r && r.data) || {};
              if (r && r.status === 200) {
                autoPub.result = 'published';
                if (d.warnings && d.warnings.length) autoPub.warnings = d.warnings;
                const [r2] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);   // 回读，响应体反映自动上架后的状态
                proj = r2[0] || proj;
              } else {
                autoPub.result = 'blocked';
                autoPub.reason = d.message || '上架闸未通过';
              }
              try {
                await authCenter.audit({
                  accountId: (req.principal && req.principal.account && req.principal.account.id) || null,
                  principalType: 'user', action: 'project.auto_publish', resource: 'projects', resourceId: String(pid),
                  after: autoPub, result: autoPub.result === 'published' ? 'ok' : 'fail',
                });
              } catch (_) {}
            }
          }
          // 3.2 评级审核结果 webhook（webhook_url 未配置 = 不推送；5s 超时，重试 5s/30s/120s）
          if (proj) {
            let ratingCode = null;
            try { ratingCode = (JSON.parse(proj.rating || '{}') || {}).code || null; } catch (_) {}
            notifyVendorEvent(proj.owner_vendor_id, 'rating.reviewed', {
              project_id: pid,
              code: ratingCode,
              channel: proj.channel,
              rating_status: action,
              rating_note: body.note || null,
              reviewed_at: now,
              auto_publish: autoPub,
            });
          }
          return jsonReply(res, { ok: true, project: proj, ...(autoPub ? { auto_publish: autoPub } : {}) });
        } finally { await conn.end(); }
      }
    }


    return false;
  };
}

module.exports = { createAdminRouter };
