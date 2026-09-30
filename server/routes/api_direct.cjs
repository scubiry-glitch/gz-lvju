'use strict';
/**
 * /api/juzhu/* 直连处理器（从 app.js handleApiDirect 整块拆出）。
 * 内部仍转发 booking / jiazheng / admin 子路由；本文件保留其余公开/商家/运营路由。
 *
 *   const handle = createApiDirectRouter(deps);
 *   await handle(urlPath, qs, req, res);
 */
function createApiDirectRouter(deps) {
  // 周边玩法类型枚举（与 admin 路由同口径；C 端公开读也用）
  const SPOT_TYPES = ['scenic', 'biz', 'food', 'cafe'];
  const SPOT_TYPE_LABELS = { scenic: '景区', biz: '商圈', food: '美食', cafe: '咖啡' };

  return async function handleApiDirect(urlPath, qs, req, res) {
    const {
      ADMIN_PREFIX, INSURANCE_KEYS, assertAdminAuthorized, assertApiAuthorized,
      auditIfAccount, authCenter, bcrypt, beikeAuth,
      bookableOf, bookingPaymentExpired, buildStayMonth, cancelPolicyOf,
      cancelPolicyTextOf, catalogMemoGet, catalogMemoSet, connExec,
      crypto, ensureSchema, expireBooking, getDbConfig,
      getVendorConfig, grOrders, grUserQuery, guardRatingSubmit,
      guardedPostJson, handleAdminRoutes, handleBookingRoutes, handleJiazhengRoutes,
      hmacAuth, housingCities, housingHydrateCoverFields, housingParseJsonField,
      imgThumbs, isCEndPublicApi, isProduction, jsonReply,
      maskPhoneStd, minStayNightsOf, mysql2, nextEmpNo,
      normalizeCancelPolicyInput, outboundJson, parseExtObj, parseJsonFields,
      parseSkuJsonFields, permRegistry, photoCfg, projectPublishEligibility,
      queryRows, readBody, releaseStayQty, requestSession,
      requireAnyPerm, requireApiKey, requirePerm, resetVendorConfigCache, stayCfg,
      stayConfigOf, stripContactPhone, stripVendorSecrets, validateStaff,
      vendorApi, vendorRate, verifyVendorLoginToken, webhookSign,
      wholeHousePriceUnit, withStayRules,
    } = deps;

    try {
      // /api/juzhu/admin/* 全方法强制 API Key（与 juzhu/server.py 对齐；auth/login|check 除外）
      if (!(await assertAdminAuthorized(urlPath, req, res))) return;
      if (!(await assertApiAuthorized(urlPath, req, res))) return;

      // 家政 C 端 /api/juzhu/jiazheng/* → server/routes/jiazheng.cjs（不含 /vendor HMAC）
      if (urlPath.startsWith('/api/juzhu/jiazheng') && !urlPath.startsWith('/api/juzhu/jiazheng/vendor/')) {
        if ((await handleJiazhengRoutes(urlPath, qs, req, res)) !== false) return;
        return jsonReply(res, { error: 'not found' }, 404);
      }


      // ── 账号中心权限闸（perm_registry.cjs 单一数据源）：admin 域按路由细粒度校验 + 细粒度审计 ──
      // 写操作不再一刀切 admin.write（project.update / account.create / settings.update ...），
      // GET 亦收口（dictionary/cities/projects 等此前对旧全局 key 无任何权限要求）。
      if (urlPath.startsWith(ADMIN_PREFIX)) {
        const rule = permRegistry.match(urlPath, req.method);
        if (rule && rule.guard === 'ratingSubmit') {
          // 评级提交双通道：账号主体按权限点，旧 vendor 会话由处理器内 owner_vendor_id 把关
          if (!(await guardRatingSubmit(req, res))) return;
        } else if (rule && !rule.exempt) {
          if (!(await requirePerm(req, res, rule.perm, permRegistry.labelOf(rule.perm)))) return;
          if (req.method !== 'GET') {
            const p = req.principal;
            if (p && p.type === 'account') {
              const m = urlPath.match(new RegExp(rule.re));
              await authCenter.audit({
                accountId: p.account.id, principalType: 'account', roles: p.roles,
                action: rule.act || rule.perm, resource: rule.res || 'admin',
                resourceId: rule.idGroup != null && m ? m[rule.idGroup] : null,
                scopeLevel: authCenter.bestScopeLevel(p), ip: p.ip, ua: p.ua,
              });
            }
          }
        } else if (!rule && req.method !== 'GET') {
          // 未注册写路由回退旧行为：账号主体 + admin.write（新路由必须先进 perm_registry.ROUTES）
          const wp = await authCenter.principalOf(req).catch(() => null);
          if (!wp || wp.type === 'legacy') {
            return jsonReply(res, {
              error: 'forbidden',
              message: '旧全局 API Key 对管理域只读；请用管理员账号登录（POST /api/auth/login → Authorization: Bearer <token>）',
            }, 403);
          }
          if (!authCenter.hasPermission(wp, authCenter.P.ADMIN_WRITE)) {
            return jsonReply(res, { error: 'forbidden', message: '当前账号无管理写权限（admin.write）' }, 403);
          }
          req.principal = wp;
          await authCenter.audit({
            accountId: wp.account.id, principalType: 'account', roles: wp.roles,
            action: 'admin.write', resource: urlPath, scopeLevel: authCenter.bestScopeLevel(wp),
            ip: wp.ip, ua: wp.ua,
          });
        }
      }

      // GET /api/juzhu/auth/beike-config —— 纯配置、不连库（须在 ensureSchema 之前，DB 慢/挂时仍能出登录链）
      if (urlPath === '/api/juzhu/auth/beike-config' && req.method === 'GET') {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
        const domainEnv = /\.lianjia\.com$/i.test(host) ? 'lianjia.com' : 'ke.com';
        const isTestHost = /\.tt[abc]\.test\.ke\.com$/i.test(host)
          || /\.test\.ke\.com$/i.test(host)
          || /localhost|127\.0\.0\.1/i.test(host)
          || !isProduction();
        const prefix = isTestHost ? 'test-' : '';
        const loginBase = (process.env.BEIKE_H5_LOGIN_URL || '').trim().replace(/\/$/, '')
          || (`https://${prefix}clogin.${domainEnv}`);
        const serviceBase = (process.env.BEIKE_H5_SERVICE_URL || '').trim().replace(/\/$/, '')
          || (`https://${prefix}m.${domainEnv}/my/checklogin`);
        return jsonReply(res, {
          ok: true,
          login_base: loginBase,
          service_base: serviceBase,
          type: 2,
          https_required: true,
        });
      }

      await ensureSchema();

      // 管理域 /api/juzhu/admin/*（+ 公开 GET /api/juzhu/settings）→ server/routes/admin.cjs
      if (urlPath.startsWith(ADMIN_PREFIX) || (urlPath === '/api/juzhu/settings' && req.method === 'GET')) {
        if ((await handleAdminRoutes(urlPath, qs, req, res)) !== false) return;
        if (urlPath.startsWith(ADMIN_PREFIX)) return jsonReply(res, { error: 'not found' }, 404);
      }


      // ===== 商家 HMAC 开放接口（api_doc.md：家政 /api/juzhu/jiazheng/vendor/*；房源 /api/juzhu/housing/vendor/*）=====
      if (req.method === 'POST' && (urlPath === '/api/juzhu/callback' || urlPath.startsWith('/api/juzhu/jiazheng/vendor/') || urlPath.startsWith('/api/juzhu/housing/vendor/'))) {
        if (!vendorApi) return jsonReply(res, { code: 500, message: 'vendor_api module missing' }, 500);
        const body = await readBody(req);
        const vendors = await getVendorConfig();
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const out = await vendorApi.handleRequest(urlPath, body, conn, vendors);
          return jsonReply(res, out.data, out.status);
        } catch (e) {
          return jsonReply(res, { code: 500, message: String(e.message || e) }, 500);
        } finally {
          await conn.end();
        }
      }

      // ===== 商家入驻申请（服务认证中台受理）：公开提交 + 进度查询 + admin 受理（权限点 vendor.onboarding.review）=====

      // POST /api/juzhu/onboarding/apply —— 公开提交（申请人尚无凭据；白名单见 isCEndPublicApi）
      if (urlPath === '/api/juzhu/onboarding/apply' && req.method === 'POST') {
        await ensureSchema();
        const body = await readBody(req);
        const company = String(body.company || '').trim();
        const contact = String(body.contact || '').trim();
        const phone = String(body.phone || '').trim();
        if (!company || !contact || !phone) return jsonReply(res, { error: 'bad request', message: '企业名称 / 联系人 / 手机号 必填' }, 400);
        if (company.length > 160 || contact.length > 64 || phone.length > 32) return jsonReply(res, { error: 'bad request', message: '字段超长' }, 400);
        const channels = String(body.channels || 'rental').split(',').map(s => s.trim()).filter(s => ['rental', 'minsu'].includes(s)).join(',') || 'rental';
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const [r] = await conn.execute(
            `INSERT INTO vendor_onboarding
               (apply_no, company, contact, phone, license_no, license_valid, permit_type,
                channels, category_scope, house_count, settle_bank, settle_account, deposit_tier, status, rate_base)
             VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 10.00)`,
            [company, contact, phone,
             String(body.license_no || '').slice(0, 64), String(body.license_valid || '').slice(0, 32),
             String(body.permit_type || '').slice(0, 32), channels,
             String(body.category_scope || '').slice(0, 255),
             Math.max(0, Math.min(9999, parseInt(body.house_count, 10) || 0)),
             String(body.settle_bank || '').slice(0, 120), String(body.settle_account || '').slice(0, 64),
             String(body.deposit_tier || '').slice(0, 32)]
          );
          const applyNo = 'GZ-RZ-' + new Date().getFullYear() + '-' + String(r.insertId).padStart(5, '0');
          await conn.execute('UPDATE vendor_onboarding SET apply_no=? WHERE id=?', [applyNo, r.insertId]);
          return jsonReply(res, { apply_no: applyNo, status: 'pending', message: '已受理登记，资料齐全后 T+2 出审核结果' }, 200);
        } catch (e) {
          return jsonReply(res, { error: 'server error', message: String(e.message || e) }, 500);
        } finally {
          await conn.end();
        }
      }

      // GET /api/juzhu/onboarding/status?no=&phone= —— 进度查询（须单号+手机号双匹配，防枚举）
      if (urlPath === '/api/juzhu/onboarding/status' && req.method === 'GET') {
        await ensureSchema();
        const qp = new URLSearchParams(qs);
        const no = (qp.get('no') || '').trim();
        const phone = (qp.get('phone') || '').trim();
        if (!no || !phone) return jsonReply(res, { error: 'bad request', message: '请提供申请单号与手机号' }, 400);
        const rows = await queryRows(
          'SELECT apply_no, company, status, channels, review_note, reviewer, reviewed_at, created_at FROM vendor_onboarding WHERE apply_no=? AND phone=? LIMIT 1',
          [no, phone]
        );
        if (!rows.length) return jsonReply(res, { error: 'not found', message: '未找到匹配的申请单（请核对单号与手机号）' }, 404);
        return jsonReply(res, rows[0]);
      }

      // ===== 项目虚拟号接口 =====

      // GET /api/juzhu/projects/:id/virtual-phone
      {
        const m = urlPath.match(/^\/api\/juzhu\/projects\/(\d+)\/virtual-phone$/);
        if (m && req.method === 'GET') {
          const pid = parseInt(m[1]);
          const rows = await queryRows('SELECT id, contact_phone, name FROM projects WHERE id=?', [pid]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          const realPhone = (rows[0].contact_phone || '').trim();
          if (!realPhone) return jsonReply(res, { error: '未配置联系电话' }, 400);

          const tpBase = (process.env.TP_BASE || 'http://tp-test.lianjia.com').replace(/\/$/, '');
          const tpAppId = (process.env.TP_APP_ID || '').trim();
          const tpAppKey = (process.env.TP_APP_KEY || '').trim();
          if (!tpAppId || !tpAppKey) {
            return jsonReply(res, { error: 'TP_APP_ID/TP_APP_KEY 未配置' }, 400);
          }

          // MD5 签名（与 tp_client.py generate_sign 对齐）
          const params = {
            app_id: tpAppId,
            ts: String(Math.floor(Date.now() / 1000)),
            number: realPhone,
            app_call_id: `juzhu-project-${pid}`,
          };
          const signStr = Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('&') + `&app_key=${tpAppKey}`;
          const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
          params.sign = sign;

          const tpQs = new URLSearchParams(params).toString();
          const tpUrl = `${tpBase}/bundling/alloc?${tpQs}`;

          try {
            const tpRes = await new Promise((resolve, reject) => {
              const tpLib = tpUrl.startsWith('https') ? require('https') : require('http');
              const tpReq = tpLib.get(tpUrl, { headers: { 'Accept': 'application/json' } }, tpResp => {
                let body = '';
                tpResp.on('data', d => body += d);
                tpResp.on('end', () => {
                  try { resolve(JSON.parse(body)); }
                  catch (e) { reject(new Error('TP invalid JSON')); }
                });
              });
              tpReq.on('error', reject);
              tpReq.setTimeout(20000, () => { tpReq.destroy(); reject(new Error('TP timeout')); });
            });

            if (tpRes.errno !== 0 && tpRes.errno !== '0' && tpRes.errno != null) {
              return jsonReply(res, { error: tpRes.errmsg || `话务错误 errno=${tpRes.errno}` }, 502);
            }
            const tpData = tpRes.data || [];
            const tpItem = Array.isArray(tpData) ? tpData[0] : tpData;
            const rawVirtual = (tpItem && (tpItem.virtual_phone_number || tpItem.virtual_phone)) || '';
            if (!rawVirtual) return jsonReply(res, { error: '话务未返回虚拟号' }, 502);

            // 格式化虚拟号（与 tp_client.py format_virtual_phone 对齐）
            const [vMain, vExt] = rawVirtual.split('-');
            const mainDigits = (vMain || '').replace(/\D/g, '');
            const extDigits = (vExt || '').replace(/\D/g, '');
            const displayMain = mainDigits.length >= 10
              ? `${mainDigits.slice(0,3)} ${mainDigits.slice(3,6)} ${mainDigits.slice(6)}`
              : (mainDigits || vMain);
            const display = displayMain + (extDigits ? ` 转 ${extDigits}` : '');
            const tel = 'tel:' + mainDigits + (extDigits ? `,${extDigits}` : '');
            return jsonReply(res, { virtual_phone: rawVirtual, display, tel });
          } catch (e) {
            return jsonReply(res, { error: '暂时无法接通，请稍后重试' }, 502);
          }
        }
      }

      // ===== 公开 C 端读接口 =====

      // GET /api/juzhu/cities
      if (urlPath === '/api/juzhu/cities' && req.method === 'GET') {
        const rows = await queryRows('SELECT * FROM cities ORDER BY id');
        rows.forEach((r) => { r.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(r.hidden_home_tabs) : []; });
        return jsonReply(res, rows);
      }

      // GET /api/juzhu/catalog?city=shenyang —— C 端保租房整包（替代 data.json）
      // lite=1：首页首屏只要城市/区/项目封面与统计，不下发户型与全量 photos
      if (urlPath === '/api/juzhu/catalog' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        const cityKey = (qp.get('city') || '').trim();
        const lite = qp.get('lite') === '1' || qp.get('lite') === 'true';
        const qpChannel = (qp.get('channel') || '').trim();
        const qpTopic = (qp.get('topic') || '').trim();
        const memoKey = (lite ? 'L:' : 'F:') + (cityKey || '_')
          + (qpChannel ? `|c=${qpChannel}` : '') + (qpTopic ? `|t=${qpTopic}` : '');
        const cached = catalogMemoGet(memoKey);
        if (cached) return jsonReply(res, cached);
        let cities = [];
        if (cityKey) {
          cities = await queryRows('SELECT * FROM cities WHERE slug=? OR name=? ORDER BY id LIMIT 1', [cityKey, cityKey]);
        }
        if (!cities.length) {
          cities = await queryRows("SELECT * FROM cities WHERE slug='shenyang' ORDER BY id LIMIT 1");
        }
        if (!cities.length) {
          cities = await queryRows('SELECT * FROM cities ORDER BY id LIMIT 1');
        }
        if (!cities.length) return jsonReply(res, { error: 'no city' }, 404);
        const city = cities[0];
        city.hidden_home_tabs = housingCities ? housingCities.parseHiddenHomeTabs(city.hidden_home_tabs) : [];
        // channel / topic 过滤（topic 定义存 settings KV：topic_<slug>；qpChannel/qpTopic 已在上方解析）
        let projSql = "SELECT * FROM projects WHERE city_id=? AND status='online' AND rating_status='passed'";
        const projParams = [city.id];
        let topicMeta = null;
        if (qpTopic) {
          const kvRows = await queryRows('SELECT value FROM settings WHERE `key`=?', [`topic_${qpTopic}`]);
          if (!kvRows.length) return jsonReply(res, { error: `unknown topic: ${qpTopic}` }, 404);
          let crit = {};
          try { crit = JSON.parse(kvRows[0].value || '{}'); } catch (_) { crit = {}; }
          // 专题下架 = crit.enabled === false（后台「内容」tab 可配），对外与 unknown topic 同响应，不泄露存在性
          if (crit.enabled === false) return jsonReply(res, { error: `unknown topic: ${qpTopic}` }, 404);
          topicMeta = { topic: qpTopic, label: crit.label || qpTopic, desc: crit.desc || '' };
          if (crit.channel) { projSql += ' AND channel=?'; projParams.push(String(crit.channel)); }
          for (const t of (crit.tags || [])) {
            projSql += ' AND JSON_CONTAINS(tags, ?)';
            projParams.push(JSON.stringify(t));
          }
        } else if (qpChannel) {
          projSql += ' AND channel=?';
          projParams.push(qpChannel);
        }
        projSql += ' ORDER BY channel, sort_order, id';
        const allChannels = await queryRows('SELECT * FROM channels WHERE enabled=1 ORDER BY sort_order, id');
        const citySlug = city.slug || '';
        let channels = allChannels.filter((ch) => {
          if (!ch.hidden_cities) return true;
          try {
            const hiddenList = JSON.parse(ch.hidden_cities);
            return !hiddenList.includes(citySlug);
          } catch (_) { return true; }
        });
        const [districts, projects] = await Promise.all([
          queryRows('SELECT * FROM districts WHERE city_id=? ORDER BY sort_order, id', [city.id]),
          queryRows(projSql, projParams),
        ]);
        const hiddenHomeTabs = new Set(city.hidden_home_tabs);
        channels = channels.filter((channel) => !hiddenHomeTabs.has(String(channel.id)));
        const projectIds = projects.map((p) => p.id);
        let units = [];
        if (!lite && projectIds.length) {
          units = await queryRows(
            `SELECT * FROM units WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY sort_order, id`,
            projectIds
          );
        }
        const unitIds = units.map((u) => u.id);
        const districtIds = districts.map((d) => d.id);
        const photoClauses = [];
        const photoParams = [];
        if (!lite) {
          if (districtIds.length) {
            photoClauses.push(`(entity_type='district' AND entity_id IN (${districtIds.map(() => '?').join(',')}))`);
            photoParams.push(...districtIds);
          }
          if (projectIds.length) {
            photoClauses.push(`(entity_type='project' AND entity_id IN (${projectIds.map(() => '?').join(',')}))`);
            photoParams.push(...projectIds);
          }
          if (unitIds.length) {
            photoClauses.push(`(entity_type='unit' AND entity_id IN (${unitIds.map(() => '?').join(',')}))`);
            photoParams.push(...unitIds);
          }
        }
        let photos = [];
        if (photoClauses.length) {
          photos = photoCfg.photosOut(await queryRows(
            `SELECT id, entity_type, entity_id, file_path, is_cover, sort_order, category, external_id FROM photos WHERE ${photoClauses.join(' OR ')} ORDER BY entity_type, entity_id, sort_order, id`,
            photoParams
          ));
        }
        const parse = housingParseJsonField || ((v) => v);
        const mapRows = (rows, keys) => rows.map((r) => {
          const o = Object.assign({}, r);
          keys.forEach((k) => { o[k] = parse(o[k]); });
          return o;
        });
        // 卡片展示价（2026-09）：单位按 A″（minsu / 带「旅居」tag 的 rental 按晚，其余按月）；
        // 按晚的走最低可售单夜价扫描。lite 首屏也要出价，故只补最小列，不整表拉户型。
        let priceUnits = units;
        if (lite && projectIds.length) {
          priceUnits = await queryRows(
            `SELECT id, project_id, rent_monthly, total_qty, ext FROM units
             WHERE project_id IN (${projectIds.map(() => '?').join(',')})`, projectIds);
        }
        const priceLows = await stayCfg.priceDisplayScan(queryRows, projects, priceUnits);
        const projById = new Map(projects.map((p) => [p.id, p]));
        const catalog = {
          city,
          channels,
          districts: mapRows(districts, ['tags']),
          projects: mapRows(projects, ['tags', 'rating', 'ext']).map((p) =>
            Object.assign(stripContactPhone(p), stayConfigOf(p), stayCfg.priceDisplayOf(p, priceLows.get(p.id)))),
          units: mapRows(units, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext'])
            .map((u) => withStayRules(u, projById.get(u.project_id))),
          photos,
          topic: topicMeta,
          stats: {
            district_count: districts.length,
            project_count_rental: projects.filter((p) => p.channel === 'rental').length,
            project_count_bzf: projects.filter((p) => p.channel === 'rental').length, // 旧字段别名
            project_count_trade: projects.filter((p) => p.channel === 'trade').length,
            // 房源量 = 租赁住宿项目在管套数合计（不是户型条数）
            unit_count: projects
              .filter((p) => p.channel === 'rental' || p.channel === 'minsu')
              .reduce((sum, p) => sum + (Number(p.managed_unit_count != null ? p.managed_unit_count : p.unit_count) || 0), 0),
          },
        };
        if (housingHydrateCoverFields) housingHydrateCoverFields(catalog);
        imgThumbs.mapThumbsDeep(catalog, 640);   // C 端图片缩略图（原图保留，admin 端不受影响）
        catalogMemoSet(memoKey, catalog);
        return jsonReply(res, catalog);
      }

      // GET /api/juzhu/ratings（按 rating_status 列出评级；口径含 rental=好房子 / minsu=彩贝）
      if (urlPath === '/api/juzhu/ratings' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        let sql = `SELECT p.*, d.name AS district_name FROM projects p
                   LEFT JOIN districts d ON d.id=p.district_id
                   WHERE p.channel IN ('rental','minsu') AND p.rating_status IN ('pending','passed','rejected')`;
        const params = [];
        if (qp.get('status')) { sql += ' AND p.rating_status=?'; params.push(qp.get('status')); }
        if (qp.get('channel')) { sql += ' AND p.channel=?'; params.push(qp.get('channel')); }
        sql += " ORDER BY COALESCE(p.rating_submitted_at,'') DESC, p.id";
        const rows = await queryRows(sql, params);
        return jsonReply(res, rows.map(stripContactPhone));
      }

      // GET /api/juzhu/ratings/:code
      {
        const m = urlPath.match(/^\/api\/juzhu\/ratings\/([^/]+)$/);
        if (m && req.method === 'GET') {
          const code = decodeURIComponent(m[1]);
          // code 格式 <前缀>-{id}（SY-BZF-/SY-RENT-/MZ-），直接按 id 查；纯数字（含补零）也按 id 兼容（存量队列旧链接）
          const idMatch = code.match(/-(\d+)$/) || code.match(/^0*(\d+)$/);
          let proj = null;
          if (idMatch) {
            const rows = await queryRows(
              `SELECT p.*, d.name AS district_name FROM projects p
               LEFT JOIN districts d ON d.id=p.district_id WHERE p.id=?`,
              [parseInt(idMatch[1])]
            );
            if (rows.length) proj = rows[0];
          }
          if (!proj) return jsonReply(res, { error: 'not found' }, 404);
          return jsonReply(res, { project: stripContactPhone(proj) });
        }
      }

      // GET /api/juzhu/trade
      if (urlPath === '/api/juzhu/trade' && req.method === 'GET') {
        const rows = await queryRows(
          "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,price_from,is_featured,featured_rank,old_house_hint FROM projects WHERE channel='trade' ORDER BY is_featured DESC, featured_rank, sort_order"
        );
        rows.forEach(r => parseJsonFields(r, ['tags']));
        return jsonReply(res, { listings: rows });
      }

      // GET /api/juzhu/districts/:slug/projects
      {
        const m = urlPath.match(/^\/api\/juzhu\/districts\/([^/]+)\/projects$/);
        if (m && req.method === 'GET') {
          const slug = decodeURIComponent(m[1]);
          const dists = await queryRows('SELECT * FROM districts WHERE slug=?', [slug]);
          if (!dists.length) return jsonReply(res, { error: 'not found' }, 404);
          const dist = dists[0];
          const projects = await queryRows(
            "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured FROM projects WHERE district_id=? AND channel='rental' AND status='online' AND rating_status='passed' ORDER BY sort_order",
            [dist.id]
          );
          projects.forEach(r => parseJsonFields(r, ['tags']));
          return jsonReply(res, { district: dist, projects });
        }
      }

      // GET /api/juzhu/projects/:slug  （C端项目详情，slug 匹配）
      {
        const m = urlPath.match(/^\/api\/juzhu\/projects\/([^/]+)$/);
        if (m && req.method === 'GET') {
          const slug = decodeURIComponent(m[1]);
          // slug 可能是纯数字（id），兼容两种查询
          const isId = /^\d+$/.test(slug);
          const sql = isId
            ? "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating,ext,status,owner_vendor_id FROM projects WHERE id=? AND status='online' AND rating_status='passed'"
            : "SELECT id,name,slug,cover_image,address,tags,sort_order,unit_count,managed_unit_count,price_from,is_featured,channel,district_id,rating_status,rating,ext,status,owner_vendor_id FROM projects WHERE slug=? AND status='online' AND rating_status='passed'";
          const rows = await queryRows(sql, [isId ? parseInt(slug) : slug]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          parseJsonFields(rows[0], ['tags', 'rating']);
          // 周边玩法（规则 17）：随项目下发绑定的维度地点（enabled=1，景区→商圈→美食→咖啡 分组序由 SQL 排定）
          const spots = await queryRows(
            "SELECT s.id,s.type,s.name,s.slug,s.icon,s.cover_image,s.summary,s.tags,s.link,ps.note " +
            'FROM project_spots ps JOIN spots s ON s.id=ps.spot_id ' +
            'WHERE ps.project_id=? AND s.enabled=1 ' +
            "ORDER BY FIELD(s.type,'scenic','biz','food','cafe'), ps.sort_order, s.sort_order, s.id",
            [rows[0].id]
          );
          spots.forEach((r) => { parseJsonFields(r, ['tags']); r.type_label = SPOT_TYPE_LABELS[r.type] || r.type; });
          // 商家维度咨询优先展示模式（jz_vendors.consult_mode，缺省 consultant）
          const vrows = rows[0].owner_vendor_id
            ? await queryRows('SELECT consult_mode FROM jz_vendors WHERE id=?', [rows[0].owner_vendor_id])
            : [];
          // 项目级最短连住与展示价取「整栋单口径」（排序最前户型），与 /units 接口及下单闸同口径
          const [headUnit] = await queryRows(
            'SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1', [rows[0].id]);
          const disp = await stayCfg.priceDisplayScan(queryRows, [rows[0]], headUnit ? [headUnit] : []);
          return jsonReply(res, imgThumbs.mapThumbsDeep(
            Object.assign(rows[0], stayConfigOf(rows[0], headUnit),
              stayCfg.priceDisplayOf(rows[0], disp.get(rows[0].id)), {
                consult_mode: (vrows[0] && vrows[0].consult_mode) || 'consultant',
                spots
              }), 640));
        }
      }

      // ===== 内容域公开读（旅游路线 + 周边玩法列表，公网白名单）=====
      // 路线站点水合：stops JSON [{spot_id, note}] → 附 spot 摘要卡（正文仍在 spots，笔记页深链按 spot.id）
      const hydrateRouteStops = async (rows) => {
        rows.forEach((r) => { try { r.stops = r.stops ? JSON.parse(r.stops) : []; } catch (_) { r.stops = []; } });
        const ids = [];
        rows.forEach((r) => r.stops.forEach((s) => { const id = parseInt(s.spot_id, 10); if (id && ids.indexOf(id) < 0) ids.push(id); }));
        const smap = {};
        if (ids.length) {
          const sp = await queryRows('SELECT id,type,name,slug,icon,cover_image,summary,address,duration,ticket FROM spots WHERE enabled=1 AND id IN (' + ids.map(() => '?').join(',') + ')', ids);
          sp.forEach((s) => { s.type_label = SPOT_TYPE_LABELS[s.type] || s.type; smap[s.id] = s; });
        }
        rows.forEach((r) => {
          r.stop_count = r.stops.length;
          r.stops = r.stops.map((s) => ({ spot_id: parseInt(s.spot_id, 10) || 0, note: s.note || '', spot: smap[parseInt(s.spot_id, 10)] || null }));
        });
        return rows;
      };

      // GET /api/juzhu/routes?city= —— 路线列表（enabled；city 匹配或全省通用；未知城市回落通用路线不报错）
      if (urlPath === '/api/juzhu/routes' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        const cityKey = (qp.get('city') || '').trim();
        let cityId = null;
        if (cityKey) {
          const cities = await queryRows('SELECT id FROM cities WHERE slug=? OR name=? ORDER BY id LIMIT 1', [cityKey, cityKey]);
          cityId = cities.length ? cities[0].id : null;
        }
        const rows = await queryRows(
          'SELECT * FROM routes WHERE enabled=1 AND (city_id IS NULL' + (cityId ? ' OR city_id=?' : '') + ') ORDER BY sort_order, id',
          cityId ? [cityId] : []
        );
        await hydrateRouteStops(rows);
        return jsonReply(res, imgThumbs.mapThumbsDeep({ routes: rows }, 640));
      }

      // GET /api/juzhu/routes/:id —— 路线详情
      {
        const m = urlPath.match(/^\/api\/juzhu\/routes\/(\d+)$/);
        if (m && req.method === 'GET') {
          const rows = await queryRows('SELECT * FROM routes WHERE id=? AND enabled=1', [parseInt(m[1])]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          await hydrateRouteStops(rows);
          return jsonReply(res, imgThumbs.mapThumbsDeep({ route: rows[0] }, 640));
        }
      }

      // GET /api/juzhu/spots?city=&type= —— 周边玩法列表（C 端 lvju-app-spots 列表页消费；city_id NULL = 全省通用）
      if (urlPath === '/api/juzhu/spots' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        const conds = ['enabled=1'], params = [];
        if (qp.get('type')) { conds.push('type=?'); params.push(qp.get('type')); }
        const cityKey = (qp.get('city') || '').trim();
        let cityId = null;
        if (cityKey) {
          const cities = await queryRows('SELECT id FROM cities WHERE slug=? OR name=? ORDER BY id LIMIT 1', [cityKey, cityKey]);
          cityId = cities.length ? cities[0].id : null;
        }
        if (cityId) { conds.push('(city_id=? OR city_id IS NULL)'); params.push(cityId); }
        const rows = await queryRows(
          'SELECT id,type,name,slug,icon,cover_image,summary,address,duration,ticket,tags FROM spots WHERE ' + conds.join(' AND ') +
          " ORDER BY FIELD(type,'scenic','biz','food','cafe'), sort_order, id",
          params
        );
        rows.forEach((r) => { parseJsonFields(r, ['tags']); r.type_label = SPOT_TYPE_LABELS[r.type] || r.type; });
        return jsonReply(res, imgThumbs.mapThumbsDeep({ spots: rows }, 640));
      }

      // GET /api/juzhu/topics —— 房源专题公开清单（enabled；C 端找房枢纽「专题入口」消费）
      if (urlPath === '/api/juzhu/topics' && req.method === 'GET') {
        const rows = await queryRows("SELECT `key`, value FROM settings WHERE `key` LIKE 'topic\\_%'");
        const topics = rows.map((r) => {
          const slug = String(r.key).replace(/^topic_/, '');
          let crit = {};
          try { crit = JSON.parse(r.value || '{}'); } catch (_) { crit = {}; }
          return { slug, label: crit.label || slug, channel: crit.channel || null,
                   tags: Array.isArray(crit.tags) ? crit.tags : [], desc: crit.desc || '', cover_image: crit.cover_image || '' };
        }).filter((t) => t.tags.length)
          .sort((a, b) => a.slug.localeCompare(b.slug));
        return jsonReply(res, { topics });
      }

      // GET /api/juzhu/spots/:id —— 周边玩法笔记详情（公网白名单，C 端 lvju-app-spot-post 页消费）
      {
        const m = urlPath.match(/^\/api\/juzhu\/spots\/(\d+)$/);
        if (m && req.method === 'GET') {
          const sid = parseInt(m[1]);
          const rows = await queryRows('SELECT * FROM spots WHERE id=? AND enabled=1', [sid]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          parseJsonFields(rows[0], ['tags', 'photos']);
          rows[0].type_label = SPOT_TYPE_LABELS[rows[0].type] || rows[0].type;
          // 相关笔记：同类优先，不足 3 条时以同城市/全省通用补齐（不做跨类凑数误导）
          let related = await queryRows(
            'SELECT id,type,name,slug,icon,cover_image,summary,tags FROM spots WHERE enabled=1 AND id<>? AND type=? ORDER BY sort_order, id LIMIT 4',
            [sid, rows[0].type]
          );
          if (related.length < 3) {
            const extra = await queryRows(
              "SELECT id,type,name,slug,icon,cover_image,summary,tags FROM spots WHERE enabled=1 AND id<>? AND type<>? AND (city_id=? OR city_id IS NULL) ORDER BY FIELD(type,'scenic','biz','food','cafe'), sort_order, id LIMIT 4",
              [sid, rows[0].type, rows[0].city_id]
            );
            related = related.concat(extra).slice(0, 4);
          }
          related.forEach((r) => { parseJsonFields(r, ['tags']); r.type_label = SPOT_TYPE_LABELS[r.type] || r.type; });
          return jsonReply(res, imgThumbs.mapThumbsDeep({ spot: rows[0], related }, 640));
        }
      }

      // GET /api/juzhu/projects/:slug/units
      {
        const m = urlPath.match(/^\/api\/juzhu\/projects\/([^/]+)\/units$/);
        if (m && req.method === 'GET') {
          const slug = decodeURIComponent(m[1]);
          const isId = /^\d+$/.test(slug);
          const projSql = isId
            ? "SELECT * FROM projects WHERE id=? AND status='online' AND rating_status='passed'"
            : "SELECT * FROM projects WHERE slug=? AND status='online' AND rating_status='passed'";
          const projs = await queryRows(projSql, [isId ? parseInt(slug) : slug]);
          if (!projs.length) return jsonReply(res, { error: 'not found' }, 404);
          const proj = projs[0];
          const units = await queryRows('SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id', [proj.id]);
          // 图集 = 房源级 + 户型级（2026-09 商家反馈点 4：photos/sync 可只推房源级图集，
          // 此前详情页只读户型级 → 房源级图集在 C 端看不见）。房源级在前，各自按 sort_order。
          const photos = photoCfg.photosOut(await queryRows(
            `SELECT * FROM photos
              WHERE (entity_type='project' AND entity_id=?)
                 OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id=?))
              ORDER BY FIELD(entity_type,'project','unit'), entity_id, sort_order, id`,
            [proj.id, proj.id]
          ));
          parseJsonFields(proj, ['tags', 'rating']);
          // 户型级生效住宿规则（最短连住 + 取消政策，2026-09）：前端只读 unit 上的值
          units.forEach((u) => { parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']); withStayRules(u, proj); });
          // 项目级最短连住取「整栋单口径」= 排序最前户型，与下单闸同口径；展示价三件套一次算出
          const disp = await stayCfg.priceDisplayScan(queryRows, [proj], units);
          return jsonReply(res, imgThumbs.mapThumbsDeep({
            project: Object.assign(stripContactPhone(proj), stayConfigOf(proj, units[0]),
              stayCfg.priceDisplayOf(proj, disp.get(proj.id))),
            units, photos,
          }, 640));
        }
      }

      // GET /api/juzhu/projects/:id/stay-calendar?month=YYYY-MM&unit_id= —— 房态日历（公开，无 PII）
      {
        const m = urlPath.match(/^\/api\/juzhu\/projects\/(\d+)\/stay-calendar$/);
        if (m && req.method === 'GET') {
          const pid = parseInt(m[1], 10);
          const qp = new URLSearchParams(qs);
          const unitId = qp.get('unit_id') ? parseInt(qp.get('unit_id'), 10) || 0 : 0;
          const mth = /^(\d{4})-(\d{2})$/.exec((qp.get('month') || '').trim());
          const today = new Date();
          const y = mth ? parseInt(mth[1], 10) : today.getFullYear();
          const mo = mth ? (parseInt(mth[2], 10) - 1) : today.getMonth();
          const prows = await queryRows("SELECT * FROM projects WHERE id=? AND status='online' AND rating_status='passed'", [pid]);
          if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
          // units=u1,u2 批量形状：一次返回该月多个户型的房态（C 端详情页整月横滚用，省 (N-1)/N 请求）
          const unitsParam = (qp.get('units') || '').split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 10);
          if (unitsParam.length) {
            const out = [];
            for (const uid of unitsParam) {
              const us = await queryRows('SELECT * FROM units WHERE id=? AND project_id=?', [uid, pid]);
              if (!us.length) continue;
              const up = cancelPolicyOf(us[0]);   // 房型级取消政策随月历下发（C 端房型卡直接用）
              out.push(Object.assign({
                unit_id: uid, cancel_policy: up, cancel_policy_text: cancelPolicyTextOf(up),
                min_stay_nights: minStayNightsOf(prows[0], us[0]),   // 户型级生效值（2026-09）
              }, await buildStayMonth(prows[0], us[0], uid, y, mo)));
            }
            return jsonReply(res, { project_id: pid, month: `${y}-${String(mo + 1).padStart(2, '0')}`, units: out });
          }
          let unit = null;
          if (unitId) {
            const us = await queryRows('SELECT * FROM units WHERE id=? AND project_id=?', [unitId, pid]);
            if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
            unit = us[0];
          }
          // 整栋单口径（2026-09）：不指定户型时价格基准按 wholeHousePriceUnit（有起价按起价）、
          // 最短连住取「排序最前户型」，与下单闸一致；取消政策维持现状（不在本次改动面内）
          const headUnit = unit || (await queryRows(
            'SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1', [pid]))[0] || null;
          const cal = await buildStayMonth(prows[0], unit || wholeHousePriceUnit(prows[0], headUnit), unitId, y, mo);
          const unitPolicy = unit ? cancelPolicyOf(unit) : null;
          return jsonReply(res, Object.assign({
            project_id: pid,
            unit_id: unitId,
          }, cal, stayConfigOf(prows[0], headUnit), unitPolicy ? { cancel_policy: unitPolicy, cancel_policy_text: cancelPolicyTextOf(unitPolicy) } : {}));
        }
      }

      // ===== C 端登录（租客）：贝壳 SDK 默认 + 密码兜底（JIT 建档，role=user）=====

      // POST /api/juzhu/auth/tenant —— 手机号+密码；首登自动建档（真实凭证，生产可用）
      if (urlPath === '/api/juzhu/auth/tenant' && req.method === 'POST') {
        const body = await readBody(req);
        const phone = String(body.phone || '').trim();
        const password = String(body.password || '');
        const name = String(body.name || '').trim();
        if (!/^1\d{10}$/.test(phone)) return jsonReply(res, { error: '手机号格式不对' }, 400);
        if (password.length < 8) return jsonReply(res, { error: '密码至少 8 位' }, 400);
        const loginName = 'u' + phone;
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ua2 = req.headers['user-agent'] || '';
        const dup = await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [loginName]);
        if (!dup.length) {
          const created = await authCenter.createAccount({
            login_name: loginName, password, roles: ['user'], principal_type: 'user',
            phone, display_name: name || ('租客' + phone.slice(-4)),
          }, { ip, ua: ua2 });
          if (created.error) return jsonReply(res, { error: created.error }, 400);
          // 新建档即已持有本人密码，直接发会话（避免再走一次登录把一次请求计成两次失败）
          const sess = await authCenter.createSession(created.account.id, ip, ua2);
          return jsonReply(res, { ok: true, token: sess.token, role: 'user', phone_masked: maskPhoneStd(phone), display_name: created.account.display_name });
        }
        // 已有账号：校验密码（防他人抢注覆盖）；只调一次，带真实 ip/ua 保证审计与节流计数准确
        const login = await authCenter.loginWithPassword(phone, password, ip, ua2);
        if (login.error) {
          if (login.throttled) return jsonReply(res, { error: login.error, retry_after: login.retry_after }, 429);
          return jsonReply(res, { error: '该手机号已注册，密码不对' }, 401);
        }
        return jsonReply(res, { ok: true, token: login.token, role: 'user', phone_masked: maskPhoneStd(phone), display_name: login.account ? login.account.display_name : name });
      }

      // POST /api/juzhu/auth/beike —— 可选：用 lianjia_token 换短 TTL BJZ 缓存会话
      // App 内身份标准已是 X-Lianjia-Token；本接口仅作浏览器旁路/离线缓存，不信前端 uid/手机号
      if (urlPath === '/api/juzhu/auth/beike' && req.method === 'POST') {
        const body = await readBody(req);
        const ljToken = String(body.lianjia_token || body.token || '').trim();
        if (!ljToken) return jsonReply(res, { error: '缺少 lianjia_token' }, 400);
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
        const referer = (process.env.SESSION_REFERER || '').trim() || ('http://' + host + '/');
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ua = req.headers['user-agent'] || '';
        const verified = await beikeAuth.verifyMemoized(ljToken, { referer });
        if (!verified.ok) return jsonReply(res, { error: verified.error, error_code: verified.error_code }, verified.status || 502);
        const ensured = await beikeAuth.ensureBeikeAccount(verified, { queryRows, authCenter }, { ip, ua });
        if (ensured.error) return jsonReply(res, { error: ensured.error }, ensured.status || 400);
        const sess = await authCenter.createSession(ensured.accountId, ip, ua, {
          ttlSeconds: beikeAuth.BEIKE_SESSION_TTL_SECONDS,
        });
        return jsonReply(res, {
          ok: true,
          token: sess.token,
          role: 'user',
          expires_at: sess.expires_at,
          uid: ensured.ucid,
          display_name: ensured.displayName,
          phone_masked: ensured.phone ? maskPhoneStd(ensured.phone) : '',
        });
      }

      // C 端预订 / 支付确认：server/routes/booking.cjs
      if ((await handleBookingRoutes(urlPath, qs, req, res)) !== false) return;

      // GET /api/juzhu/vendor/booking/orders —— vendor 只见自己；platform 全量（可 ?status=）
      if (urlPath === '/api/juzhu/vendor/booking/orders' && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        let sql = `SELECT b.id, b.order_no, b.project_id, b.unit_id, b.channel, b.checkin, b.checkout,
                          b.nights, b.rooms, b.price_total, b.commission_rate, b.commission_fee, b.status, b.created_at,
                          b.contact_name, b.contact_phone, p.name AS project_name, p.cover_image AS project_cover
                   FROM booking_orders b LEFT JOIN projects p ON p.id=b.project_id WHERE 1=1`;
        const params = [];
        if (sess.role === 'vendor') { sql += ' AND b.owner_vendor_id=?'; params.push(sess.vendorId); }
        const bqp = new URLSearchParams(qs);
        if (bqp.get('status')) { sql += ' AND b.status=?'; params.push(bqp.get('status')); }
        sql += ' ORDER BY b.id DESC LIMIT 200';
        const rows = await queryRows(sql, params);
        return jsonReply(res, {
          role: sess.role,
          items: rows.map((o) => Object.assign({}, o, { contact_phone: maskPhoneStd(o.contact_phone) })),
        });
      }

      // POST /api/juzhu/vendor/booking/:id/status —— 商家确认/取消（owner 校验）
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/booking\/(\d+)\/status$/);
        if (m && req.method === 'POST') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const body = await readBody(req);
          const status = String(body.status || '');
          if (!['confirmed', 'cancelled'].includes(status)) return jsonReply(res, { error: 'status 须为 confirmed/cancelled' }, 400);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            await conn.beginTransaction();
            const [rows] = await conn.execute('SELECT * FROM booking_orders WHERE id=? FOR UPDATE', [parseInt(m[1], 10)]);
            if (!rows.length) { await conn.rollback(); return jsonReply(res, { error: 'not found' }, 404); }
            if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
              await conn.rollback();
              return jsonReply(res, { error: 'forbidden：非本商家订单' }, 403);
            }
            if (bookingPaymentExpired(rows[0])) {
              await expireBooking(conn, rows[0]);
              await conn.commit();
              return jsonReply(res, { error: '待支付订单已过期并释放房态' }, 400);
            }
            if (rows[0].status === 'cancelled') { await conn.rollback(); return jsonReply(res, { error: '订单已取消，不可再变更' }, 400); }
            // 在线支付单 pay_status='unpaid' 时租客未支付，不可确认生效
            if (status === 'confirmed' && rows[0].pay_status === 'unpaid') {
              await conn.rollback();
              return jsonReply(res, { error: '租客尚未支付（收银台待付），支付完成后可确认生效' }, 400);
            }
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            await conn.execute('UPDATE booking_orders SET status=?, updated_at=? WHERE id=?', [status, now, rows[0].id]);
            // 商家拒单 → 释放库存（多间口径 2026-09-10，与客户取消同 helper）；确认则保留占用
            if (status === 'cancelled') {
              await releaseStayQty(connExec(conn), {
                project_id: rows[0].project_id, unit_id: rows[0].unit_id, rooms: rows[0].rooms,
                checkin: rows[0].checkin, checkout: rows[0].checkout, now,
              });
            }
            await conn.commit();
            return jsonReply(res, { ok: true, order_no: rows[0].order_no, status });
          } finally { await conn.end(); }
        }
      }

      // ===== 商家后台（vendor-admin，账号中心会话，scope=vendor；与 /api/juzhu/vendor/* 并存）=====
      if (urlPath.startsWith('/api/juzhu/vendor-admin/')) {
        const principal = await authCenter.principalOf(req).catch(() => null);
        if (!principal || principal.type !== 'account') {
          return jsonReply(res, { error: 'unauthorized', message: '请用商家账号登录（POST /api/auth/login）' }, 401);
        }
        const sub = urlPath.slice('/api/juzhu/'.length).replace(/\/+$/, '');
        const need = {
          'vendor-admin/summary': authCenter.P.VENDOR_SUMMARY,
          'vendor-admin/orders': authCenter.P.VENDOR_ORDER_READ,
          'vendor-admin/products': authCenter.P.VENDOR_PRODUCT_READ,
        }[sub];
        if (!need || !authCenter.hasPermission(principal, need)) {
          return jsonReply(res, { error: 'forbidden', message: '当前账号无该权限' }, 403);
        }
        const vid = principal.account.vendor_id;
        if (!vid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定商家' }, 403);
        if (sub === 'vendor-admin/summary') {
          const vs = await queryRows('SELECT id, type, name, logo, rating, review_count, status, vendor_no FROM jz_vendors WHERE id=?', [vid]);
          const byStatus = await queryRows('SELECT status, COUNT(*) n FROM gr_orders WHERE vendor_id=? GROUP BY status', [vid]);
          const [pc] = await queryRows('SELECT COUNT(*) n FROM jz_products WHERE vendor_id=?', [vid]);
          const [wc] = await queryRows('SELECT COUNT(*) n FROM jz_workers WHERE vendor_id=?', [vid]);
          return jsonReply(res, {
            vendor: stripVendorSecrets(vs[0] || null),
            stats: { orders_by_status: byStatus, products: pc.n, workers: wc.n },
            permissions: [...authCenter.permissionsOf(principal)],
            scope: authCenter.bestScopeLevel(principal),
          });
        }
        if (sub === 'vendor-admin/orders') {
          const qp = new URLSearchParams(qs);
          const status = (qp.get('status') || '').trim();
          const rows = status
            ? await queryRows('SELECT * FROM gr_orders WHERE vendor_id=? AND status=? ORDER BY id DESC LIMIT 200', [vid, status])
            : await queryRows('SELECT * FROM gr_orders WHERE vendor_id=? ORDER BY id DESC LIMIT 200', [vid]);
          return jsonReply(res, rows);
        }
        if (sub === 'vendor-admin/products') {
          const rows = await queryRows('SELECT * FROM jz_products WHERE vendor_id=? ORDER BY sort_order, id LIMIT 200', [vid]);
          return jsonReply(res, rows);
        }
      }

      // ===== 服务者（S 端）接口：worker 会话，scope=self 只碰本人名下工单 =====

      // GET /api/juzhu/s/orders —— 派给我的工单（worker_json.id = 绑定 worker_id）
      if (urlPath === '/api/juzhu/s/orders' && req.method === 'GET') {
        const principal = await authCenter.principalOf(req).catch(() => null);
        if (!principal || principal.type !== 'account') {
          return jsonReply(res, { error: 'unauthorized', message: '请用服务者账号登录（POST /api/auth/login）' }, 401);
        }
        const wid = principal.account.worker_id;
        if (!wid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定服务者（worker_id）' }, 403);
        const rows = await queryRows(
          `SELECT o.id, o.sku_id, o.type, o.house, o.expect_time, o.status, o.pay_status, o.worker_json,
                  o.created_at, o.updated_at, o.log_json, s.name AS sku_name
           FROM jz_orders o LEFT JOIN jz_skus s ON s.id = o.sku_id
           WHERE o.worker_json IS NOT NULL AND JSON_VALID(o.worker_json)
             AND JSON_UNQUOTE(JSON_EXTRACT(o.worker_json, '$.id')) = ?
           ORDER BY o.created_at DESC LIMIT 200`,
          [String(wid)]
        );
        return jsonReply(res, { items: rows, worker_id: wid });
      }

      // POST /api/juzhu/s/orders/:id/advance —— 本人名下工单推进（accepted→serving→done 封顶；评价归客户）
      {
        const m = urlPath.match(/^\/api\/juzhu\/s\/orders\/([^/]+)\/advance$/);
        if (m && req.method === 'POST') {
          const principal = await authCenter.principalOf(req).catch(() => null);
          if (!principal || principal.type !== 'account') {
            return jsonReply(res, { error: 'unauthorized', message: '请用服务者账号登录' }, 401);
          }
          const wid = principal.account.worker_id;
          if (!wid) return jsonReply(res, { error: 'forbidden', message: '当前账号未绑定服务者' }, 403);
          const orderId = m[1];
          const STATUS_ORDER = ['pending', 'dispatched', 'accepted', 'serving', 'done'];
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const [rows] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
            if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
            const order = rows[0];
            // scope=self：只能推进派给自己的工单
            let mine = false;
            try { mine = order.worker_json && JSON.parse(order.worker_json) && String(JSON.parse(order.worker_json).id) === String(wid); } catch (_) {}
            if (!mine) { conn.end(); return jsonReply(res, { error: 'forbidden', message: '非派给你的工单' }, 403); }
            const curIdx = STATUS_ORDER.indexOf(order.status);
            if (curIdx === -1 || order.status === 'pending') { conn.end(); return jsonReply(res, { error: '当前状态不可推进' }, 400); }
            if (curIdx >= STATUS_ORDER.length - 1) { conn.end(); return jsonReply(res, { error: '已是最终状态' }, 400); }
            const nextStatus = STATUS_ORDER[curIdx + 1];
            const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
            let log = [];
            try { log = JSON.parse(order.log_json || '[]'); } catch (_) {}
            log.push({ at: now, action: 'advance', by: 'worker:' + wid, from: order.status, to: nextStatus });
            await conn.execute(
              'UPDATE jz_orders SET status=?, updated_at=?, log_json=? WHERE id=?',
              [nextStatus, now, JSON.stringify(log), orderId]
            );
            const [updated] = await conn.execute('SELECT * FROM jz_orders WHERE id=?', [orderId]);
            await authCenter.audit({
              accountId: principal.account.id, principalType: 'account', roles: principal.roles,
              action: 's.order.advance', resource: 'jz_orders', resourceId: String(orderId), scopeLevel: 'self',
              after: { status: nextStatus }, ip: principal.ip, ua: principal.ua,
            });
            return jsonReply(res, { ok: true, order: updated[0] });
          } finally { await conn.end(); }
        }
      }

      // ===== 持有方/机构只读视角（B 端资管；holding_viewer 只读，无任何运营动作）=====
      // GET /api/juzhu/org/report —— 资管大盘聚合（只读；按账号 scope 过滤：city 档只见授权城市，all 全量）
      if (urlPath === '/api/juzhu/org/report' && req.method === 'GET') {
        const principal = await authCenter.principalOf(req).catch(() => null);
        if (!principal || principal.type !== 'account' ||
            !(authCenter.hasPermission(principal, 'report.read') || authCenter.hasPermission(principal, '*'))) {
          return jsonReply(res, { error: 'forbidden', message: '需持有方/平台只读账号（report.read）' }, 403);
        }
        // scope 收口（规则 4）：持有方/监管按授权城市看数，不得因 report.read 看全平台
        const scope = authCenter.scopeOf(principal);
        if (scope.level !== 'all' && scope.level !== 'city') {
          return jsonReply(res, { error: 'forbidden', message: '报表按 city/all 数据范围开放（当前 ' + scope.level + ' 档）' }, 403);
        }
        const citySql = authCenter.scopeCitySql(scope, 'p.city_id');
        const citySqlPlain = authCenter.scopeCitySql(scope, 'city_id');
        const byChannel = await queryRows(
          `SELECT channel, COUNT(*) projects, COALESCE(SUM(COALESCE(managed_unit_count, unit_count)),0) units
           FROM projects WHERE 1=1${citySqlPlain.sql} GROUP BY channel ORDER BY channel`,
          citySqlPlain.params
        );
        // city 档口径：只统计在该市有项目的机构类型
        const vendorsByType = await queryRows(
          `SELECT v.type, COUNT(DISTINCT v.id) n FROM jz_vendors v
           JOIN projects p ON p.owner_vendor_id = v.id WHERE v.status='active'${citySql.sql}
           GROUP BY v.type ORDER BY n DESC`,
          citySql.params
        );
        // jz_orders 与城市/项目无直接外键（经 sku 间接归属），city 档诚实降级为空集（试点口径）
        const ordersByStatus = scope.level === 'all'
          ? await queryRows('SELECT status, COUNT(*) n FROM jz_orders GROUP BY status ORDER BY n DESC')
          : [];
        const operators = await queryRows(
          `SELECT v.id, v.name, v.type, COUNT(p.id) project_count
           FROM jz_vendors v LEFT JOIN projects p ON p.owner_vendor_id = v.id${citySql.sql}
           WHERE v.type IN ('platform','housing_operator','lvju_host','homestay')
           GROUP BY v.id, v.name, v.type ORDER BY project_count DESC LIMIT 20`,
          citySql.params
        );
        return jsonReply(res, {
          view: 'holding', readonly: true,
          scope: { level: scope.level, city_ids: scope.cityIds || null },
          generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          housing: { by_channel: byChannel },
          vendors: { by_type: vendorsByType },
          orders: scope.level === 'all' ? { by_status: ordersByStatus } : { by_status: [], note: 'city 口径暂不提供工单聚合（试点范围）' },
          operators,
        });
      }

      // ===== 商家（vendor）接口：role=vendor 会话，一律按 owner_vendor_id 隔离 =====

      // GET /api/juzhu/vendor/webhook —— webhook 配置查看（2026-09-22 自助化 + 平台代管）
      // vendor 会话：只看自己；platform 会话：全量商家清单（含各自 webhook_url），供 B 端下拉代管
      if (urlPath === '/api/juzhu/vendor/webhook' && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess || (sess.role !== 'vendor' && sess.role !== 'platform')) return jsonReply(res, { error: 'unauthorized' }, 401);
        const EVENTS = ['rating.reviewed', 'booking.created', 'booking.paid', 'booking.cancelled', 'webhook.test'];
        if (sess.role === 'vendor') {
          const vrows = await queryRows('SELECT webhook_url FROM jz_vendors WHERE id=? LIMIT 1', [sess.vendorId]);
          return jsonReply(res, { role: 'vendor', webhook_url: (vrows[0] && vrows[0].webhook_url) || '', events: EVENTS });
        }
        const vrows = await queryRows(
          "SELECT id, name, webhook_url FROM jz_vendors WHERE status='active' AND type IN ('platform','housing_operator','lvju_host','homestay','developer','agent') ORDER BY sort_order, id");
        return jsonReply(res, { role: 'platform', events: EVENTS, vendors: vrows.map((v) => ({ id: v.id, name: v.name, webhook_url: v.webhook_url || '' })) });
      }

      // POST /api/juzhu/vendor/webhook —— 配置/清除 webhook_url（vendor=自己；platform 带 vendor_id 代管）
      //（URL 仅格式校验；内网/保留地址在投递侧由 guardedPostJson 的 DNS 解析拦截——解析后重绑定也拦得住）
      if (urlPath === '/api/juzhu/vendor/webhook' && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess || (sess.role !== 'vendor' && sess.role !== 'platform')) return jsonReply(res, { error: 'unauthorized' }, 401);
        const body = await readBody(req);
        const targetVid = sess.role === 'vendor' ? sess.vendorId : (parseInt(body.vendor_id, 10) || 0);
        if (!targetVid) return jsonReply(res, { error: 'vendor_id 必填（平台代管）' }, 400);
        if (sess.role === 'platform') {
          const ex = await queryRows('SELECT id FROM jz_vendors WHERE id=? LIMIT 1', [targetVid]);
          if (!ex.length) return jsonReply(res, { error: '商家不存在' }, 404);
        }
        const url = String(body.webhook_url || '').trim();
        if (url && !/^https?:\/\//i.test(url)) return jsonReply(res, { error: 'webhook_url 须以 http:// 或 https:// 开头' }, 400);
        if (url.length > 500) return jsonReply(res, { error: 'webhook_url 过长（≤500 字符）' }, 400);
        const before = await queryRows('SELECT webhook_url FROM jz_vendors WHERE id=? LIMIT 1', [targetVid]);
        await queryRows('UPDATE jz_vendors SET webhook_url=?, updated_at=? WHERE id=?',
          [url || null, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), targetVid]);
        try {
          await authCenter.audit({
            accountId: (sess.account && sess.account.id) || null, principalType: 'user',
            action: 'vendor.webhook.update', resource: 'vendor', resourceId: String(targetVid),
            before: { webhook_url: (before[0] && before[0].webhook_url) || null },
            after: { webhook_url: url || null }, result: 'ok',
          });
        } catch (_) {}
        return jsonReply(res, { ok: true, webhook_url: url || null });
      }

      // POST /api/juzhu/vendor/access —— 商家自配接入接口 url_link / order_detail_url（2026-09-30）
      //（vendor=自己；platform 带 vendor_id 代管；webhook_url 走上一条路由；hmac_key 平台独占，只走 admin rotate）
      if (urlPath === '/api/juzhu/vendor/access' && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess || (sess.role !== 'vendor' && sess.role !== 'platform')) return jsonReply(res, { error: 'unauthorized' }, 401);
        const body = await readBody(req);
        const targetVid = sess.role === 'vendor' ? sess.vendorId : (parseInt(body.vendor_id, 10) || 0);
        if (!targetVid) return jsonReply(res, { error: 'vendor_id 必填（平台代管）' }, 400);
        if (sess.role === 'platform') {
          const ex = await queryRows('SELECT id FROM jz_vendors WHERE id=? LIMIT 1', [targetVid]);
          if (!ex.length) return jsonReply(res, { error: '商家不存在' }, 404);
        }
        const LIMIT = { url_link: 2000, order_detail_url: 2000 };
        const next = {};
        for (const f of Object.keys(LIMIT)) {
          if (!(f in body)) continue;
          const s = String(body[f] == null ? '' : body[f]).trim();
          if (s) {
            if (!/^https?:\/\//i.test(s)) return jsonReply(res, { error: f + ' 须以 http:// 或 https:// 开头' }, 400);
            if (s.length > LIMIT[f]) return jsonReply(res, { error: f + ' 过长（≤' + LIMIT[f] + ' 字符）' }, 400);
          }
          next[f] = s || null;
        }
        if (!Object.keys(next).length) return jsonReply(res, { error: '无可更新字段（url_link / order_detail_url）' }, 400);
        const beforeRows = await queryRows('SELECT url_link, order_detail_url FROM jz_vendors WHERE id=? LIMIT 1', [targetVid]);
        const before = {
          url_link: (beforeRows[0] && beforeRows[0].url_link) || null,
          order_detail_url: (beforeRows[0] && beforeRows[0].order_detail_url) || null,
        };
        const sets = [], vals = [];
        for (const f of Object.keys(next)) { sets.push(f + '=?'); vals.push(next[f]); }
        await queryRows(`UPDATE jz_vendors SET ${sets.join(', ')}, updated_at=? WHERE id=?`,
          [...vals, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), targetVid]);
        if (resetVendorConfigCache) resetVendorConfigCache();
        try {
          await authCenter.audit({
            accountId: (sess.account && sess.account.id) || null, principalType: 'user',
            action: 'vendor.access.update', resource: 'vendor', resourceId: String(targetVid),
            before, after: Object.assign({}, before, next), result: 'ok',
          });
        } catch (_) {}
        return jsonReply(res, { ok: true, vendor_id: targetVid,
          url_link: next.url_link !== undefined ? next.url_link : before.url_link,
          order_detail_url: next.order_detail_url !== undefined ? next.order_detail_url : before.order_detail_url });
      }

      // POST /api/juzhu/vendor/webhook/test —— 同步试推一次 webhook.test（单次不重试，回传送达结果）
      if (urlPath === '/api/juzhu/vendor/webhook/test' && req.method === 'POST') {
        const sess = await requestSession(req);
        if (!sess || (sess.role !== 'vendor' && sess.role !== 'platform')) return jsonReply(res, { error: 'unauthorized' }, 401);
        const body = await readBody(req);
        const targetVid = sess.role === 'vendor' ? sess.vendorId : (parseInt(body.vendor_id, 10) || 0);
        if (!targetVid) return jsonReply(res, { error: 'vendor_id 必填（平台代管）' }, 400);
        const vrows = await queryRows('SELECT webhook_url, hmac_key FROM jz_vendors WHERE id=? LIMIT 1', [targetVid]);
        const v = vrows[0];
        if (!v || !v.webhook_url) return jsonReply(res, { error: '请先保存 webhook_url' }, 400);
        if (!v.hmac_key) return jsonReply(res, { error: '商家未配置 hmac_key，无法签名' }, 400);
        const ts = Date.now();
        const data = { note: '连通性测试', at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
        const payload = { event: 'webhook.test', vendor_id: targetVid, data };
        const signed = { event: payload.event, vendor_id: targetVid, data, timestamp: ts, sign: webhookSign(v.hmac_key, payload, ts) };
        const out = await guardedPostJson(v.webhook_url, signed, 5000);
        try {
          await authCenter.audit({
            accountId: (sess.account && sess.account.id) || null, principalType: 'user',
            action: 'vendor.webhook.test', resource: 'vendor', resourceId: String(targetVid),
            after: out, result: out.ok ? 'ok' : 'fail',
          });
        } catch (_) {}
        return jsonReply(res, out.ok
          ? { ok: true, status: out.status }
          : { ok: false, error: out.error || ('HTTP ' + out.status), status: out.status || null });
      }

      // POST /api/juzhu/vendor/login —— 商家登录（2026-09-09 并入账号中心：本路由只是别名，返回体形状不变，B 端页面零改动）
      // 凭据在 accounts（vendor_id 绑定 + vendor_owner 角色，scrypt）：
      // ① accounts 有账号 → authCenter.loginWithPassword 统一链（ident+ip 双维节流 / 锁定 / bcrypt 遗留哈希懒升级 / auth.login 审计）；
      // ② 迁移未跑的兜底：jz_vendors 命中且 bcrypt 校验通过 → createAccount 建档（密码重哈希 scrypt）+ createSession；
      // ③ 旧 HMAC 自证 token（verifyVendorLoginToken）仅宽限校验至自然过期，本路由不再签发；
      // ④ jz_vendors.password_hash 冻结：仅 ② 的兜底校验读取一次。
      if (urlPath === '/api/juzhu/vendor/login' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.login_name || '').trim();
        const pwd = String(body.password || '');
        if (!name || !pwd) return jsonReply(res, { error: 'login_name/password 必填' }, 400);
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ua = req.headers['user-agent'] || '';
        // 统一收口：会话主体必须绑商家且商家在营 → 组装原形状返回体 + auth.vendor.login 审计
        const finish = async (account, token, expiresAt) => {
          if (!account || !account.vendor_id) return jsonReply(res, { error: '非商家账号，请从控制台登录' }, 403);
          const vrows = await queryRows('SELECT id, name, type, status FROM jz_vendors WHERE id=? LIMIT 1', [account.vendor_id]);
          const v = vrows[0];
          if (!v) return jsonReply(res, { error: '绑定的商家不存在' }, 403);
          if (v.status !== 'active') return jsonReply(res, { error: '商家已停用' }, 403);
          await authCenter.audit({ accountId: account.id, principalType: 'user', action: 'auth.vendor.login', resource: 'vendor', resourceId: String(v.id), result: 'ok', ip, ua });
          return jsonReply(res, { token, role: 'vendor', expires_at: expiresAt, vendor: { id: v.id, name: v.name, type: v.type } });
        };
        // ① 账号中心统一链
        const arows = await queryRows("SELECT id FROM accounts WHERE login_name=? AND principal_type='user' LIMIT 1", [name]);
        if (arows.length) {
          const lr = await authCenter.loginWithPassword(name, pwd, ip, ua);
          if (lr.throttled) return jsonReply(res, { error: lr.error, retry_after: lr.retry_after }, 429);
          if (lr.error || !lr.token) return jsonReply(res, { error: lr.error || '账号或密码错误' }, 401);
          return await finish(lr.account, lr.token, lr.expires_at);
        }
        // ② 兜底懒建档：accounts 无行但商家表命中（老凭据校验通过即并入账号中心）
        const vrows = await queryRows(
          'SELECT id, name, type, status, phone, password_hash FROM jz_vendors WHERE login_name=? LIMIT 1',
          [name]
        );
        const v = vrows[0];
        if (!v || !v.password_hash) {
          await authCenter.throttleFail('ident', name);
          return jsonReply(res, { error: '账号或密码错误' }, 401);
        }
        if (v.status !== 'active') return jsonReply(res, { error: '商家已停用' }, 403);
        let pwdOk = false;
        try { pwdOk = bcrypt.compareSync(pwd, v.password_hash); } catch (_) { pwdOk = false; }
        if (!pwdOk) {
          await authCenter.throttleFail('ident', name);
          return jsonReply(res, { error: '账号或密码错误' }, 401);
        }
        const created = await authCenter.createAccount({
          login_name: name, password: pwd, roles: ['vendor_owner'], principal_type: 'user',
          vendor_id: v.id, display_name: v.name, phone: v.phone || null,
        }, { accountId: null, ip, ua });
        if (!created || !created.account) return jsonReply(res, { error: (created && created.error) || '商家账号建档失败' }, 400);
        const sess = await authCenter.createSession(created.account.id, ip, ua);
        return await finish(created.account, sess.token, sess.expires_at);
      }

      // GET /api/juzhu/vendor/me（vendor 或 platform）
      if (urlPath === '/api/juzhu/vendor/me' && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        if (sess.role === 'platform') return jsonReply(res, { role: 'platform' });
        const vrows = await queryRows('SELECT id, name, type, city_ids, commission_housing, commission_jiazheng FROM jz_vendors WHERE id=?', [sess.vendorId]);
        if (!vrows.length) return jsonReply(res, { error: 'vendor not found' }, 404);
        // 佣金商家只读可见（规则 20）：随发生效费率与是否差异化
        const srows = await queryRows('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
          [vendorRate.defaultSettingKey('housing'), vendorRate.defaultSettingKey('jiazheng')]);
        const settingsMap = {};
        for (const r of srows) settingsMap[r.key] = r.value;
        const v = vrows[0];
        const isDef = (biz) => v['commission_' + biz] == null;
        const commission = {};
        for (const biz of vendorRate.BIZLINES) {
          commission[biz] = {
            rate: vendorRate.effectiveRateOf(v, biz, settingsMap),
            is_default: isDef(biz),
          };
        }
        return jsonReply(res, { role: 'vendor', vendor: Object.assign({}, v, { commission }) });
      }

      // GET /api/juzhu/vendor/go-live-check —— 商家上线完整性自查（vendor=只看自己；platform 可 ?vendor_id=）
      // 聚合一次算完：资质 / 在营 / 结算账户 / 费率 / 房源评级与上架 / 户型 / 交易能力 / 取消政策 /
      // 联系电话 / 开放接口密钥 / 实拍图。fail=阻塞上线；warn=建议完善（不阻塞）。
      if (urlPath === '/api/juzhu/vendor/go-live-check' && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        const qp = new URLSearchParams(qs);
        // vendor 会话一律只看自己（忽略 ?vendor_id=，杜绝越权探商家）
        const vid = sess.role === 'vendor' ? sess.vendorId : (parseInt(qp.get('vendor_id') || '', 10) || 0);
        if (!vid) return jsonReply(res, { error: 'platform 视角须带 ?vendor_id=' }, 400);
        const vrows = await queryRows(
          'SELECT id, name, type, status, review_status, reviewed_at, phone, hmac_key, commission_housing FROM jz_vendors WHERE id=?', [vid]);
        if (!vrows.length) return jsonReply(res, { error: 'vendor not found' }, 404);
        const v = vrows[0];
        const checks = [];
        const add = (key, label, ok, state, detail, hint, link) =>
          checks.push({ key, label, state: ok ? 'pass' : (state || 'fail'), detail: detail || '', hint: hint || '', link: link || '' });

        // ── 商家主体 ──
        add('qualification', '资质审核通过', v.review_status === 'approved', 'fail',
          '复审状态 ' + (v.review_status || '-') + (v.reviewed_at ? ' · ' + String(v.reviewed_at).slice(0, 10) : ''),
          v.review_status === 'approved' ? '' : '在「商家入驻受理台」完成核验/复审', 'p-vendor-onboarding.html');
        add('active', '商家在营', v.status === 'active', 'fail',
          v.status === 'active' ? 'status=active' : '商家已停用（status=' + v.status + '）',
          v.status === 'active' ? '' : '联系平台恢复在营');
        // 结算账户：入驻申请单（approved）按 phone 匹配，取最近一单
        let settle = null;
        if (v.phone) {
          const orows = await queryRows(
            "SELECT settle_bank, settle_account, deposit_tier FROM vendor_onboarding WHERE phone=? AND status='approved' ORDER BY id DESC LIMIT 1", [v.phone]);
          settle = orows[0] || null;
        }
        add('settlement', '绑定了结算账号', !!(settle && settle.settle_bank && settle.settle_account), 'fail',
          settle && settle.settle_account ? (settle.settle_bank || '-') + ' · ' + String(settle.settle_account).replace(/(.{4})(.*)(.{3})/, '$1****$3') : '未绑定结算账户',
          settle && settle.settle_account ? '' : '在入驻受理台补录对公结算账户（户名与营业执照一致）', 'p-vendor-onboarding.html');
        // 费率：差异化 = pass；按基准 = warn（基准也是有效费率，不阻塞）
        {
          const srows = await queryRows('SELECT value FROM settings WHERE `key`=?', [vendorRate.defaultSettingKey('housing')]);
          const base = vendorRate.effectiveRateOf(v, 'housing', { commission_housing_default: srows.length ? srows[0].value : '' });
          add('commission', '设置了费率', v.commission_housing != null, 'warn',
            v.commission_housing != null ? '差异化费率 ' + Number(v.commission_housing) + '%（房源预订档）' : '按全局基准 ' + base + '% 计',
            v.commission_housing != null ? '' : '如需差异化费率，请平台在「商家费率」台核定', 'p-vendor-rates.html');
        }

        // ── 房源与可售性 ──
        const projs = await queryRows(
          'SELECT id, name, channel, status, rating_status, contact_phone, ext FROM projects WHERE owner_vendor_id=?', [vid]);
        const passed = projs.filter((p) => p.rating_status === 'passed');
        const online = projs.filter((p) => p.status === 'online');
        const sellable = projs.filter((p) => p.status === 'online' && p.rating_status === 'passed');
        add('housing_approved', '房源审核通过', passed.length > 0, 'fail',
          passed.length ? passed.length + ' 个房源已通过评级审核' : '尚无房源通过评级审核（rating_status=passed）',
          passed.length ? '' : '在房源评级复核台提交/完成评级', 'p-rating-review.html');
        add('housing_online', '房源已上架', online.length > 0, 'fail',
          online.length ? online.length + ' 个房源在售（online）' : '房源未上架（draft/offline），C 端不可见',
          online.length ? '' : '在房源管理页上架', 'b-listing-mgmt.html');
        const sellIds = sellable.map((p) => p.id);
        let unitCount = 0, cancelCount = 0;
        if (sellIds.length) {
          const ph = sellIds.map(() => '?').join(',');
          const [urows] = await Promise.all([queryRows(
            `SELECT id, ext FROM units WHERE project_id IN (${ph})`, sellIds)]);
          unitCount = urows.length;
          cancelCount = urows.filter((u) => {
            try { const x = typeof u.ext === 'string' ? JSON.parse(u.ext) : (u.ext || {}); return !!(x && x.cancel_policy && x.cancel_policy.enabled); } catch (_) { return false; }
          }).length;
          add('units_complete', '户型与价格已配置', unitCount > 0, 'fail',
            unitCount ? unitCount + ' 个在售户型' : '在售房源尚未配置户型与价格',
            unitCount ? '' : '在房源管理页补户型', 'b-listing-mgmt.html');
          const bookableN = sellable.filter((p) => bookableOf(p)).length;
          add('stay_bookable', '房源交易方式已配置', bookableN > 0, 'warn',
            bookableN ? bookableN + ' 个房源支持在线预订或在线支付' : '未配置可用交易方式',
            bookableN ? '' : '在房态日历页至少开启在线预订或在线支付', 'b-stay-calendar.html');
          add('cancel_policy', '取消政策已配置', cancelCount > 0, 'warn',
            cancelCount ? cancelCount + ' 个房型已配免费取消窗口' : '未配置取消政策（客户预订成功后不可自助取消）',
            cancelCount ? '' : '在房态日历页「取消政策」卡按房型配置', 'b-stay-calendar.html');
        } else {
          add('units_complete', '户型与价格已配置', false, 'fail', '在售房源尚未配置户型与价格', '在房源管理页补户型', 'b-listing-mgmt.html');
          add('stay_bookable', '房源交易方式已配置', false, 'warn', '未配置可用交易方式', '在房态日历页至少开启在线预订或在线支付', 'b-stay-calendar.html');
          add('cancel_policy', '取消政策已配置', false, 'warn', '未配置取消政策（客户预订成功后不可自助取消）', '在房态日历页「取消政策」卡按房型配置', 'b-stay-calendar.html');
        }

        // ── 联系与开放能力 ──
        const hasContact = !!(v.phone || projs.some((p) => p.contact_phone));
        add('contact', '联系电话可拨', hasContact, 'warn',
          hasContact ? 'C 端拨号走虚拟号（TP 实时绑号，双方号码不外泄）' : '商家与房源均未登记联系电话',
          hasContact ? '' : '在房源上配置咨询电话', 'b-listing-mgmt.html');
        add('hmac', '开放接口密钥', !!v.hmac_key, 'warn',
          v.hmac_key ? 'HMAC 密钥已配置（可对接开放接口）' : '未接入商家开放接口（密钥由平台线下发放）',
          v.hmac_key ? '' : '对接文档见开放平台', 'property-intake-api.html');
        let photoCount = 0;
        if (sellIds.length) {
          const ph = sellIds.map(() => '?').join(',');
          const prows = await queryRows(
            `SELECT COUNT(*) AS n FROM photos WHERE (entity_type='project' AND entity_id IN (${ph}))
               OR (entity_type='unit' AND entity_id IN (SELECT id FROM units WHERE project_id IN (${ph})))`,
            [...sellIds, ...sellIds]);
          photoCount = prows[0] ? Number(prows[0].n) : 0;
        }
        add('photos', '实拍图充足', photoCount >= 8, 'warn',
          photoCount + ' 张实拍图（手册口径 ≥8 张）', photoCount >= 8 ? '' : '房源详情补足实拍图（AI 查重会拦截盗图）', 'b-listing-mgmt.html');

        const failed = checks.filter((c) => c.state === 'fail');
        const warns = checks.filter((c) => c.state === 'warn');
        return jsonReply(res, {
          role: sess.role,
          vendor: { id: v.id, name: v.name, type: v.type, status: v.status, review_status: v.review_status },
          ready: failed.length === 0,
          required_count: checks.filter((c) => c.state !== 'warn').length,
          failed_count: failed.length,
          warn_count: warns.length,
          checks,
        });
      }

      // GET /api/juzhu/vendor/projects（vendor 只见自己；platform 可 ?vendor_id= 过滤或全量）
      if (urlPath === '/api/juzhu/vendor/projects' && req.method === 'GET') {
        const sess = await requestSession(req);
        if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
        let sql = `SELECT p.*, d.name AS district_name, v.name AS vendor_name
                   FROM projects p
                   LEFT JOIN districts d ON d.id=p.district_id
                   LEFT JOIN jz_vendors v ON v.id=p.owner_vendor_id
                   WHERE 1=1`;
        const params = [];
        if (sess.role === 'vendor') { sql += ' AND p.owner_vendor_id=?'; params.push(sess.vendorId); }
        const vqp = new URLSearchParams(qs);
        if (vqp.get('vendor_id')) { sql += ' AND p.owner_vendor_id=?'; params.push(parseInt(vqp.get('vendor_id'), 10)); }
        if (vqp.get('channel')) { sql += ' AND p.channel=?'; params.push(vqp.get('channel')); }
        if (vqp.get('city_id')) { sql += ' AND p.city_id=?'; params.push(parseInt(vqp.get('city_id'), 10)); }
        sql += ' ORDER BY p.channel, p.sort_order, p.id';
        const projects = await queryRows(sql, params);
        const projectIds = projects.map((p) => p.id);
        let units = [];
        if (projectIds.length) {
          units = await queryRows(
            `SELECT * FROM units WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY sort_order, id`,
            projectIds
          );
        }
        const projById = new Map(projects.map((p) => [p.id, p]));
        units.forEach((u) => { parseJsonFields(u, ['tags', 'amenities', 'keeper', 'rent_detail', 'ext']); withStayRules(u, projById.get(u.project_id)); });
        const disp = await stayCfg.priceDisplayScan(queryRows, projects, units);
        return jsonReply(res, {
          role: sess.role,
          projects: projects.map((p) => Object.assign(stripContactPhone(parseJsonFields(p, ['ext'])), stayConfigOf(p),
            stayCfg.priceDisplayOf(p, disp.get(p.id)))),
          units,
        });
      }

      // POST /api/juzhu/vendor/projects/:id/status（下架/上架：status online|offline|draft）
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/projects\/(\d+)\/status$/);
        if (m && req.method === 'POST') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const pid = parseInt(m[1], 10);
          const body = await readBody(req);
          const status = String(body.status || '');
          if (!['online', 'offline', 'draft'].includes(status)) {
            return jsonReply(res, { error: 'status 须为 online/offline/draft' }, 400);
          }
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const [rows] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
            if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
            if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
              conn.end();
              return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
            }
            let pubWarnings = [];
            if (status === 'online') {
              const eligibility = await projectPublishEligibility(conn, pid, sess.role === 'vendor' ? sess.vendorId : null);
              if (!eligibility.ok) return jsonReply(res, { error: eligibility.error }, eligibility.status || 400);
              pubWarnings = eligibility.warnings || [];
            }
            await conn.execute('UPDATE projects SET status=? WHERE id=?', [status, pid]);
            await conn.commit();
            const [updated] = await conn.execute('SELECT id, name, status FROM projects WHERE id=?', [pid]);
            return jsonReply(res, { ok: true, project: updated[0], ...(pubWarnings.length ? { warnings: pubWarnings } : {}) });
          } finally { await conn.end(); }
        }
      }

      // PUT /api/juzhu/vendor/units/:id（商家调价/改户型：限自己项目下的户型，且仅价格展示字段）
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/units\/(\d+)$/);
        if (m && req.method === 'PUT') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const uid = parseInt(m[1], 10);
          const body = await readBody(req);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const [rows] = await conn.execute(
              'SELECT u.id, u.ext, u.project_id, p.owner_vendor_id, p.channel AS channel FROM units u JOIN projects p ON p.id=u.project_id WHERE u.id=?',
              [uid]
            );
            if (!rows.length) { conn.end(); return jsonReply(res, { error: 'not found' }, 404); }
            if (sess.role === 'vendor' && rows[0].owner_vendor_id !== sess.vendorId) {
              conn.end();
              return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
            }
            const sets = [], vals = [];
            const put = (col, val) => { sets.push(`${col}=?`); vals.push(val); };
            for (const col of ['rent_monthly', 'promo_price', 'layout_label', 'unit_spec', 'sort_order']) {
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
            // ext 合并：各键（ext 整包 / cancel_policy / min_stay_nights）合并到同一份 ext 后一次性写回，
            // 避免多次 put('ext') 生成重复赋值互相覆盖（后者会把前者的改动丢掉）
            let extCur = null;
            let extTouched = false;
            const extOf = () => { if (extCur == null) extCur = parseExtObj(rows[0].ext); return extCur; };
            if ('ext' in body) { extCur = body.ext != null ? Object.assign({}, parseExtObj(body.ext)) : {}; extTouched = true; }
            if ('cancel_policy' in body) {
              // 取消政策只合并 ext.cancel_policy 一键（保留 price_night 等既有键），口径单一数据源 stay_config.cjs；
              // null = 清除（视为未开通，不可取消）
              const ext = extOf();
              if (body.cancel_policy === null) delete ext.cancel_policy;
              else {
                try { ext.cancel_policy = normalizeCancelPolicyInput(body.cancel_policy); }
                catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
              }
              extTouched = true;
            }
            if ('min_stay_nights' in body) {
              // 最短连住（2026-09 下放户型）：只合并 ext.min_stay_nights 一键，保留 price_night / cancel_policy；
              // null/'' = 清除（回落房源级，再落频道默认）
              const ext = extOf();
              if (body.min_stay_nights === null || body.min_stay_nights === '') delete ext.min_stay_nights;
              else {
                try { ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(body.min_stay_nights, rows[0].channel); }
                catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
              }
              extTouched = true;
            }
            if ('default_closed' in body) {
              // 默认关房（2026-09 方案 B 配套）：只合并 ext.default_closed 一键；true 才落库，false/null 清除
              const ext = extOf();
              if (body.default_closed === null || body.default_closed === '') delete ext.default_closed;
              else {
                try {
                  if (stayCfg.normalizeDefaultClosedInput(body.default_closed)) ext.default_closed = true;
                  else delete ext.default_closed;
                } catch (e) { conn.end(); return jsonReply(res, { error: e.message }, 400); }
              }
              extTouched = true;
            }
            if (extTouched) put('ext', extCur && Object.keys(extCur).length ? JSON.stringify(extCur) : null);
            if (!sets.length) { conn.end(); return jsonReply(res, { error: '无可更新字段' }, 400); }
            vals.push(uid);
            await conn.execute(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, vals);
            await conn.commit();
            const [updated] = await conn.execute('SELECT * FROM units WHERE id=?', [uid]);
            // 回显生效值（最短连住 + 来源 / 默认夜价 / 取消政策文案），B 端住宿规则卡直接用它对齐
            const [prow] = await conn.execute('SELECT * FROM projects WHERE id=?', [rows[0].project_id]);
            return jsonReply(res, { ok: true, unit: withStayRules(updated[0], prow[0] || { channel: rows[0].channel }) });
          } finally { await conn.end(); }
        }
      }

      // GET /api/juzhu/vendor/stay-calendar?project_id=&unit_id=&month= —— 商家房态日历（owner 校验）
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/stay-calendar$/);
        if (m && req.method === 'GET') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const vqp = new URLSearchParams(qs);
          const pid = parseInt(vqp.get('project_id') || '', 10);
          if (!pid) return jsonReply(res, { error: 'project_id 必填' }, 400);
          const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
          if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
          if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
            return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
          }
          const unitId = vqp.get('unit_id') ? (parseInt(vqp.get('unit_id'), 10) || 0) : 0;
          const mth = /^(\d{4})-(\d{2})$/.exec((vqp.get('month') || '').trim());
          const today = new Date();
          const y = mth ? parseInt(mth[1], 10) : today.getFullYear();
          const mo = mth ? (parseInt(mth[2], 10) - 1) : today.getMonth();
          let unit = null;
          if (unitId) {
            const us = await queryRows('SELECT * FROM units WHERE id=? AND project_id=?', [unitId, pid]);
            if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
            unit = us[0];
          }
          // 整栋单口径（2026-09）：不指定户型时价格基准按 wholeHousePriceUnit、最短连住取「排序最前户型」
          const headUnit = unit || (await queryRows(
            'SELECT * FROM units WHERE project_id=? ORDER BY sort_order, id LIMIT 1', [pid]))[0] || null;
          const cal = await buildStayMonth(prows[0], unit || wholeHousePriceUnit(prows[0], headUnit), unitId, y, mo);
          return jsonReply(res, Object.assign({
            role: sess.role,
            project_id: pid,
            project_name: prows[0].name,
            unit_id: unitId,
            writable: true,
          }, cal, stayConfigOf(prows[0], headUnit)));
        }
      }

      // POST /api/juzhu/vendor/stay-calendar —— 批量设置房态/夜价/放出间数
      // body: { project_id, unit_id?, dates: ['YYYY-MM-DD'...], status: 'open'|'blocked',
      //         price_night?: number|null, qty?: number|null }
      //   blocked=关房（该晚须无占用）；open + price/qty=设覆盖；open 无 price 无 qty=恢复默认
      //   （删纯差异行；有占用的行保留计数、清 price/qty 回默认）。多间口径 2026-09-10。
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/stay-calendar$/);
        if (m && req.method === 'POST') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const body = await readBody(req);
          const pid = parseInt(body.project_id, 10);
          const unitId = body.unit_id == null || body.unit_id === '' ? 0 : parseInt(body.unit_id, 10);
          const status = String(body.status || '');
          const rawDates = Array.isArray(body.dates) ? body.dates.map(String) : [];
          const dates = rawDates.filter((d) => stayCfg.isValidDateString(d));
          const priceRaw = body.price_night;
          const price = (priceRaw === null || priceRaw === undefined || priceRaw === '') ? null : parseInt(priceRaw, 10);
          const qtyRaw = body.qty;
          const qty = (qtyRaw === null || qtyRaw === undefined || qtyRaw === '') ? null : parseInt(qtyRaw, 10);
          // available_qty（2026-09 方案 B）：净可售绝对值，服务端记基线（见 stay_config.remainingOf）
          const availRaw = body.available_qty;
          const available = (availRaw === null || availRaw === undefined || availRaw === '') ? null : parseInt(availRaw, 10);
          if (!pid) return jsonReply(res, { error: 'project_id 必填' }, 400);
          if (!Number.isInteger(unitId) || unitId < 0) return jsonReply(res, { error: 'unit_id 须为非负整数' }, 400);
          if (!['open', 'blocked'].includes(status)) return jsonReply(res, { error: 'status 须为 open/blocked（booked 为剩余售罄的派生态，由下单占用）' }, 400);
          if (price != null && !(price >= 0)) return jsonReply(res, { error: 'price_night 须为非负整数或空' }, 400);
          if (qty != null && (!(qty >= 1) || qty > 999)) return jsonReply(res, { error: 'qty（放出间数）须为 1-999 的整数或空' }, 400);
          if (available != null && (!(available >= 0) || available > 999)) return jsonReply(res, { error: 'available_qty（净可售）须为 0-999 的整数或空' }, 400);
          if (qty != null && available != null) return jsonReply(res, { error: 'qty（放出总量）与 available_qty（净可售）语义不同，同一次调用只能传一个' }, 400);
          if ((qty != null || available != null) && !unitId) return jsonReply(res, { error: '项目级（不限房型）容量恒 1，不支持 qty / available_qty 覆盖' }, 400);
          if (!dates.length || dates.length !== rawDates.length) return jsonReply(res, { error: 'dates 必填且必须为真实有效的 YYYY-MM-DD 日期（单次 ≤ 400 天）' }, 400);
          if (dates.length > 400) return jsonReply(res, { error: '单次最多 400 天' }, 400);
          const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
          if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
          if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
            return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
          }
          if (unitId) {
            const us = await queryRows('SELECT id FROM units WHERE id=? AND project_id=?', [unitId, pid]);
            if (!us.length) return jsonReply(res, { error: 'unit not found' }, 404);
          }
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            // 已订晚保护（多间口径）：booked_qty>0 的晚不可关房（须先取消订单）；
            // 设 qty 时不得低于该晚已订间数（不能放出少于已订的量）
            const [booked] = await conn.execute(
              `SELECT stay_date, booked_qty, status FROM stay_calendar WHERE project_id=? AND unit_id IN (0, ?)
               AND (booked_qty>0 OR status='booked') AND stay_date IN (${dates.map(() => '?').join(',')})`,
              [pid, unitId, ...dates]
            );
            if (status === 'blocked' && booked.length) {
              return jsonReply(res, { error: `以下日期已有预订占用，须先取消订单：${booked.map((r) => r.stay_date).join('、')}` }, 400);
            }
            if (qty != null) {
              const over = booked.filter((r) => Math.max(parseInt(r.booked_qty, 10) || 0, r.status === 'booked' ? 1 : 0) > qty);
              if (over.length) {
                return jsonReply(res, { error: `以下日期已订间数超过放出间数 ${qty}，须先取消订单或调高 qty：${over.map((r) => r.stay_date).join('、')}` }, 400);
              }
            }
            const marks = dates.map(() => '?').join(',');
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            let affected = 0;
            if (status === 'blocked') {
              for (const d of dates) {
                const [r] = await conn.execute(
                  `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, source, updated_at)
                   VALUES (?,?,?,'blocked',?,'vendor',?)
                   ON DUPLICATE KEY UPDATE status='blocked', source='vendor', updated_at=VALUES(updated_at)`,
                  [pid, unitId, d, price, now]
                );
                affected += r.affectedRows || 0;
              }
            } else if (price != null || qty != null || available != null) {
              // 设覆盖价 / 放出间数（彼此独立，只写传入的字段）
              // 放出量两种口径（2026-09 方案 B）：available_qty = 净可售（基线 = 该晚当前已订数）；
              // qty = 旧「放出总量」（基线重置 0）。两者整对写入 qty + qty_base，不混口径。
              const bookedByDate = new Map(booked.map((r) => [r.stay_date, parseInt(r.booked_qty, 10) || 0]));
              for (const d of dates) {
                const pushQty = available != null ? available : qty;
                const pushBase = available != null ? (bookedByDate.get(d) || 0) : null;
                const [r] = await conn.execute(
                  `INSERT INTO stay_calendar(project_id, unit_id, stay_date, status, price_night, qty, qty_base, source, updated_at)
                   VALUES (?,?,?,'open',?,?,?,'vendor',?)
                   ON DUPLICATE KEY UPDATE status='open', source='vendor',
                     ${price != null ? 'price_night=VALUES(price_night),' : ''}
                     ${pushQty != null ? 'qty=VALUES(qty), qty_base=VALUES(qty_base),' : ''}
                     updated_at=VALUES(updated_at)`,
                  [pid, unitId, d, price, pushQty, pushBase, now]
                );
                affected += r.affectedRows || 0;
              }
            } else {
              // 恢复默认：纯差异行删行；有占用的行保留计数，仅清 price/qty/qty_base 回默认（多间口径 2026-09-10）
              const [r] = await conn.execute(
                `DELETE FROM stay_calendar WHERE project_id=? AND unit_id=? AND status IN ('open','blocked')
                 AND booked_qty=0 AND stay_date IN (${marks})`,
                [pid, unitId, ...dates]
              );
              affected = r.affectedRows || 0;
              const [r2] = await conn.execute(
                `UPDATE stay_calendar SET price_night=NULL, qty=NULL, qty_base=NULL, updated_at=?
                 WHERE project_id=? AND unit_id=? AND booked_qty>0 AND stay_date IN (${marks})`,
                [now, pid, unitId, ...dates]
              );
              affected += r2.affectedRows || 0;
            }
            await conn.commit();
            return jsonReply(res, { ok: true, project_id: pid, unit_id: unitId, status, price_night: price, qty, available_qty: available, dates: dates.length, affected });
          } finally { await conn.end(); }
        }
      }

      // PUT /api/juzhu/vendor/projects/:id —— 商家配置交易能力/保障/连住规则（写 projects.ext，规则15 不加列）
      // body: { online_booking?: bool, online_payment?: bool, insurance?: [...], min_stay_nights?: ... }
      {
        const m = urlPath.match(/^\/api\/juzhu\/vendor\/projects\/(\d+)$/);
        if (m && req.method === 'PUT') {
          const sess = await requestSession(req);
          if (!sess) return jsonReply(res, { error: 'unauthorized' }, 401);
          const pid = parseInt(m[1], 10);
          const body = await readBody(req);
          const prows = await queryRows('SELECT * FROM projects WHERE id=?', [pid]);
          if (!prows.length) return jsonReply(res, { error: 'not found' }, 404);
          if (sess.role === 'vendor' && prows[0].owner_vendor_id !== sess.vendorId) {
            return jsonReply(res, { error: 'forbidden：非本商家房源' }, 403);
          }
          let ext = Object.assign({}, parseExtObj(prows[0].ext));
          if ('insurance' in body) {
            if (body.insurance === null || body.insurance === '') { ext.insurance = []; }
            else if (Array.isArray(body.insurance)) {
              ext.insurance = body.insurance.map(String).filter((k) => INSURANCE_KEYS.includes(k));
            } else return jsonReply(res, { error: 'insurance 须为标识数组：' + INSURANCE_KEYS.join('/') }, 400);
          }
          if ('min_stay_nights' in body) {
            if (body.min_stay_nights === null || body.min_stay_nights === '') { delete ext.min_stay_nights; }
            else {
              try { ext.min_stay_nights = stayCfg.normalizeMinStayNightsInput(body.min_stay_nights, prows[0].channel); }
              catch (e) { return jsonReply(res, { error: e.message }, 400); }
            }
          }
          if (!('insurance' in body) && !('min_stay_nights' in body)
            && !('online_booking' in body) && !('online_payment' in body) && !('stay_bookable' in body)) {
            return jsonReply(res, { error: '无可更新字段（online_booking / online_payment / insurance / min_stay_nights）' }, 400);
          }
          try { ext = stayCfg.applyTransactionCapabilities(ext, body, prows[0].channel); }
          catch (e) { return jsonReply(res, { error: e.message }, 400); }
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            await conn.execute('UPDATE projects SET ext=? WHERE id=?', [JSON.stringify(ext), pid]);
            await conn.commit();
            const [updated] = await conn.execute('SELECT * FROM projects WHERE id=?', [pid]);
            return jsonReply(res, { ok: true, project: Object.assign(stripContactPhone(updated[0]), stayConfigOf(updated[0])) });
          } finally { await conn.end(); }
        }
      }

      // GET /api/juzhu/gr/orders?user_id=
      if (urlPath === '/api/juzhu/gr/orders' && req.method === 'GET') {
        if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
        const qp = new URLSearchParams(qs);
        const parsed = await grUserQuery(req,qp);
        if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const data = await grOrders.listUserOrders(conn, parsed.userId, qp.get('limit'));
          return jsonReply(res, { ok: true, ...data });
        } finally {
          await conn.end();
        }
      }

      // GET /api/juzhu/gr/orders/:ref/vendor-detail
      {
        const m = urlPath.match(/^\/api\/juzhu\/gr\/orders\/([^/]+)\/vendor-detail$/);
        if (m && req.method === 'GET') {
          if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
          const orderRef = decodeURIComponent(m[1]);
          const qp = new URLSearchParams(qs);
          const parsed = await grUserQuery(req,qp);
          if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const order = await grOrders.getUserOrder(conn, orderRef, parsed.userId);
            if (!order) return jsonReply(res, { ok: false, error: '订单不存在' }, 404);
            if (!order.vendor_id) return jsonReply(res, { ok: false, error: '订单未关联商家' });
            const vendors = await getVendorConfig();
            const vendor = vendors[String(order.vendor_id)] || {};
            const detailUrl = vendor.order_detail_url || '';
            if (!detailUrl) return jsonReply(res, { ok: false, error: '商家未配置订单详情接口' });
            if (!hmacAuth || !vendor.key) {
              return jsonReply(res, { ok: false, error: `vendor_id=${order.vendor_id} 未配置 hmac_key，无法按文档带签名调用订单详情` });
            }
            // 平台 → 商家 order_detail（GET）：按 api_doc.md 把 vendor_id / timestamp / sign 一并放在 query string
            // 商家侧按相同规则（递归展平→去空→字典序→HMAC-SHA256）验签
            const signed = hmacAuth.generateSignature(vendor.key, {
              vendor_id: Number(order.vendor_id),
              order_ref: orderRef,
            });
            const qsParts = Object.entries(signed).map(([k, v]) =>
              encodeURIComponent(k) + '=' + encodeURIComponent(v)
            ).join('&');
            const sep = detailUrl.includes('?') ? '&' : '?';
            const url = detailUrl + sep + qsParts;
            const outbound = await outboundJson('GET', url, null, 5000);
            if (!outbound.json || outbound.json.code !== 200 || !outbound.json.data) {
              return jsonReply(res, { ok: false, error: '商家未返回订单详情' });
            }
            const data = outbound.json.data;
            const worker = data.worker || null;
            if (worker && worker.eta) worker.eta = grOrders.normEtaPeking(worker.eta);
            return jsonReply(res, {
              ok: true,
              detail: {
                vendor_oid: data.lailai_oid,
                status: data.status,
                fee: data.fee,
                worker,
                cancel_reason: data.cancel_reason,
              },
            });
          } finally {
            await conn.end();
          }
        }
      }

      // GET /api/juzhu/gr/orders/:ref
      {
        const m = urlPath.match(/^\/api\/juzhu\/gr\/orders\/([^/]+)$/);
        if (m && req.method === 'GET') {
          if (!grOrders) return jsonReply(res, { ok: false, error: 'gr_orders module missing' }, 500);
          const orderRef = decodeURIComponent(m[1]);
          const qp = new URLSearchParams(qs);
          const parsed = await grUserQuery(req,qp);
          if (!parsed.ok) return jsonReply(res, { ok: false, error: parsed.error }, parsed.status);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const order = await grOrders.getUserOrder(conn, orderRef, parsed.userId);
            if (!order) return jsonReply(res, { ok: false, error: '订单不存在' }, 404);
            return jsonReply(res, { ok: true, order });
          } finally {
            await conn.end();
          }
        }
      }

      // ===== /api/juzhu/jz/* 管理台接口 =====

      // GET /api/juzhu/jz/categories
      if (urlPath === '/api/juzhu/jz/categories' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        const all = qp.get('all') === '1';
        let sql = all
          ? 'SELECT * FROM jz_categories ORDER BY sort_order, id'
          : "SELECT * FROM jz_categories WHERE enabled=1 ORDER BY sort_order, id";
        const rows = await queryRows(sql);
        return jsonReply(res, { list: rows });
      }

      // GET /api/juzhu/jz/spu
      if (urlPath === '/api/juzhu/jz/spu' && req.method === 'GET') {
        const rows = await queryRows(
          `SELECT s.*, c.name AS category_name, c.icon AS category_icon,
             (SELECT COUNT(*) FROM jz_products p WHERE p.channel_sku_id=s.id) AS sku_count
           FROM jz_skus s LEFT JOIN jz_categories c ON c.id=s.category_id
           ORDER BY s.category_id, s.sort_order, s.id`
        );
        rows.forEach(r => parseSkuJsonFields(r));
        return jsonReply(res, { list: rows });
      }

      // GET /api/juzhu/jz/vendors
      if (urlPath === '/api/juzhu/jz/vendors' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        let sql = "SELECT * FROM jz_vendors WHERE status='active' ORDER BY type, sort_order, id";
        const params = [];
        if (qp.get('type')) { sql = "SELECT * FROM jz_vendors WHERE type=? AND status='active' ORDER BY sort_order, id"; params.push(qp.get('type')); }
        const vendors = await queryRows(sql, params);
        // 每个商家附带前2个上架产品
        for (const v of vendors) {
          stripVendorSecrets(v);
          v.products = await queryRows(
            "SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order, id LIMIT 2",
            [v.id]
          );
          v.products.forEach(p => parseJsonFields(p, ['service_tags']));
        }
        return jsonReply(res, { list: vendors });
      }

      // GET /api/juzhu/jz/vendors/:id
      {
        const m = urlPath.match(/^\/api\/juzhu\/jz\/vendors\/(\d+)$/);
        if (m && req.method === 'GET') {
          const rows = await queryRows('SELECT * FROM jz_vendors WHERE id=?', [parseInt(m[1])]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          const v = stripVendorSecrets(rows[0]);
          v.products = await queryRows("SELECT * FROM jz_products WHERE vendor_id=? AND status='on' ORDER BY sort_order", [v.id]);
          v.products.forEach(p => parseJsonFields(p, ['service_tags']));
          return jsonReply(res, v);
        }
      }

      // GET /api/juzhu/jz/products（B 端产品管理：对齐 Python 版 list_products 字段契约）
      if (urlPath === '/api/juzhu/jz/products' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        let sql = `SELECT p.*, v.name AS vendor_name, v.type AS vendor_type,
                     COALESCE(s.category_id, v.type) AS product_category,
                     c.name AS city_name
                   FROM jz_products p
                   LEFT JOIN jz_vendors v ON v.id=p.vendor_id
                   LEFT JOIN jz_skus s ON s.id=p.channel_sku_id
                   LEFT JOIN cities c ON c.id=p.city_id
                   WHERE 1=1`;
        const params = [];
        if (qp.get('vendor_id')) { sql += ' AND p.vendor_id=?'; params.push(parseInt(qp.get('vendor_id'))); }
        if (qp.get('type')) { sql += ' AND COALESCE(s.category_id, v.type)=?'; params.push(qp.get('type')); }
        if (qp.get('status')) { sql += ' AND p.status=?'; params.push(qp.get('status')); }
        sql += ' ORDER BY p.vendor_id, p.sort_order, p.id LIMIT 200';
        const rows = await queryRows(sql, params);
        rows.forEach(r => parseJsonFields(r, ['service_tags']));
        // 附加：引用的 SPU 名 + 绑定服务者 id 列表（对齐 Python 版 list_products）
        for (const row of rows) {
          const workerRows = await queryRows('SELECT worker_id FROM jz_sku_workers WHERE product_id=?', [row.id]);
          row.worker_ids = workerRows.map(w => w.worker_id);
          if (row.channel_sku_id) {
            const spuRows = await queryRows('SELECT name FROM jz_skus WHERE id=?', [row.channel_sku_id]);
            row.spu_name = spuRows.length ? spuRows[0].name : null;
          } else {
            row.spu_name = null;
          }
        }
        return jsonReply(res, { list: rows });
      }

      // GET /api/juzhu/jz/products/:id
      {
        const m = urlPath.match(/^\/api\/juzhu\/jz\/products\/(\d+)$/);
        if (m && req.method === 'GET') {
          const rows = await queryRows('SELECT p.*, v.name AS vendor_name FROM jz_products p LEFT JOIN jz_vendors v ON v.id=p.vendor_id WHERE p.id=?', [parseInt(m[1])]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          parseJsonFields(rows[0], ['service_tags']);
          return jsonReply(res, rows[0]);
        }
      }

      // GET /api/juzhu/jz/workers
      if (urlPath === '/api/juzhu/jz/workers' && req.method === 'GET') {
        const rows = await queryRows("SELECT * FROM jz_workers WHERE status='active' ORDER BY credit_score DESC, completed_orders DESC");
        rows.forEach(r => parseJsonFields(r, ['tags']));
        return jsonReply(res, { list: rows });
      }

      // GET /api/juzhu/jz/workers/:id
      {
        const m = urlPath.match(/^\/api\/juzhu\/jz\/workers\/(\d+)$/);
        if (m && req.method === 'GET') {
          const rows = await queryRows('SELECT * FROM jz_workers WHERE id=?', [parseInt(m[1])]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          parseJsonFields(rows[0], ['tags']);
          return jsonReply(res, rows[0]);
        }
      }

      // GET /api/juzhu/jz/orders
      if (urlPath === '/api/juzhu/jz/orders' && req.method === 'GET') {
        if (!(await requireApiKey(req, res))) return;
        const qp = new URLSearchParams(qs);
        let sql = 'SELECT o.*, s.name AS sku_name FROM jz_orders o LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE 1=1';
        const params = [];
        if (qp.get('status')) { sql += ' AND o.status=?'; params.push(qp.get('status')); }
        const limit = Math.min(parseInt(qp.get('limit') || '50'), 200);
        sql += ' ORDER BY o.created_at DESC LIMIT ' + limit; // limit 已 parseInt+封顶，内联（mysql2 预处理不接受 LIMIT 绑定）
        const rows = await queryRows(sql, params);
        return jsonReply(res, { list: rows });
      }

      // GET /api/juzhu/jz/orders/overview —— gr_orders 指标概览（漏斗 + 日/月趋势；支持 city/vendor_id/start/end 筛选；必须在 orders/:id 之前）
      if (urlPath === '/api/juzhu/jz/orders/overview' && req.method === 'GET') {
        if (!(await requireApiKey(req, res))) return;
        const STATUSES = ['pending', 'paid', 'assigned', 'serving', 'completed', 'cancelled'];
        // gr_orders.created_at 以北京时间字符串（YYYY-MM-DD HH:MM:SS）落库，分桶按北京日期（对齐 gr_orders.cjs cstParts）
        const p2 = (n) => String(n).padStart(2, '0');
        const cstDay = (offsetDays) => {
          const d = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 86400000);
          return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
        };
        const dayShift = (iso, n) => {
          const d = new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000);
          return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
        };
        const monthOf = (iso) => iso.slice(0, 7);
        const monthShift = (ym, n) => {
          const [y, m] = ym.split('-').map(Number);
          const d = new Date(Date.UTC(y, m - 1 + n, 1));
          return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`;
        };
        const blankRow = (key, val) => {
          const row = {};
          row[key] = val;
          STATUSES.forEach((s) => { row[s] = 0; });
          return row;
        };

        // 区间参数（YYYY-MM-DD 闭区间；缺省 = 今日）；ISO 日期字符串序 = 时间序
        const qp = new URLSearchParams(qs);
        const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
        let start = RE_DATE.test(qp.get('start') || '') ? qp.get('start') : cstDay(0);
        let end = RE_DATE.test(qp.get('end') || '') ? qp.get('end') : start;
        if (start > end) { const t = start; start = end; end = t; }
        // 桶上限：按日最多 92 桶（超出取区间尾段），按月最多 24 桶
        const spanDays = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
        const dailyFrom = dayShift(end, -(Math.min(spanDays, 92) - 1));
        const monthlyFrom = monthOf(start) > monthShift(monthOf(end), -23) ? monthOf(start) : monthShift(monthOf(end), -23);

        // 筛选条件（vendor_id=0 表示未关联商家的单）
        const where = ['created_at >= ?', 'created_at < ?'];
        const params = [start + ' 00:00:00', dayShift(end, 1) + ' 00:00:00'];
        const city = (qp.get('city') || '').trim();
        if (city) { where.push('city=?'); params.push(city); }
        const vendorRaw = (qp.get('vendor_id') || '').trim();
        if (vendorRaw === '0') where.push('vendor_id IS NULL');
        else if (/^\d+$/.test(vendorRaw)) { where.push('vendor_id=?'); params.push(parseInt(vendorRaw, 10)); }
        const whereSql = 'WHERE ' + where.join(' AND ');

        const funnel = {};
        STATUSES.forEach((s) => { funnel[s] = 0; });
        const daily = [];
        for (let d = dailyFrom; d <= end; d = dayShift(d, 1)) daily.push(blankRow('date', d));
        const monthly = [];
        for (let m = monthlyFrom; m <= monthOf(end); m = monthShift(m, 1)) monthly.push(blankRow('month', m));
        // created_at 为定宽字符串，LEFT() 直接分桶；三条聚合代替逐状态逐桶查询
        const buckets = await Promise.all([
          queryRows(`SELECT status, COUNT(*) AS c FROM gr_orders ${whereSql} GROUP BY status`, params),
          queryRows(`SELECT LEFT(created_at,10) AS d, status, COUNT(*) AS c FROM gr_orders ${whereSql} GROUP BY LEFT(created_at,10), status`, params),
          queryRows(`SELECT LEFT(created_at,7) AS m, status, COUNT(*) AS c FROM gr_orders ${whereSql} GROUP BY LEFT(created_at,7), status`, params),
        ]);
        buckets[0].forEach((r) => { if (funnel[r.status] != null) funnel[r.status] = r.c; });
        const dailyIdx = {};
        daily.forEach((r) => { dailyIdx[r.date] = r; });
        buckets[1].forEach((r) => { if (dailyIdx[r.d] && dailyIdx[r.d][r.status] != null) dailyIdx[r.d][r.status] = r.c; });
        const monthlyIdx = {};
        monthly.forEach((r) => { monthlyIdx[r.month] = r; });
        buckets[2].forEach((r) => { if (monthlyIdx[r.m] && monthlyIdx[r.m][r.status] != null) monthlyIdx[r.m][r.status] = r.c; });

        // 筛选下拉数据源：城市取单内实际出现值（空表回落 cities 表），商家取 jz_vendors 全量
        const cityRows = await queryRows("SELECT DISTINCT city FROM gr_orders WHERE city IS NOT NULL AND city<>'' ORDER BY city LIMIT 50");
        let cities = cityRows.map((r) => r.city);
        if (!cities.length) {
          cities = (await queryRows('SELECT name FROM cities ORDER BY id LIMIT 30')).map((r) => r.name);
        }
        const vendors = (await queryRows('SELECT id, name FROM jz_vendors ORDER BY id LIMIT 200'))
          .map((r) => ({ id: r.id, name: r.name }));
        return jsonReply(res, { funnel, daily, monthly, range: { start, end }, filter_options: { cities, vendors } });
      }

      // GET /api/juzhu/jz/orders/:id
      {
        const m = urlPath.match(/^\/api\/juzhu\/jz\/orders\/([^/]+)$/);
        if (m && req.method === 'GET') {
          if (!(await requireApiKey(req, res))) return;
          const rows = await queryRows(
            'SELECT o.*, s.name AS sku_name FROM jz_orders o LEFT JOIN jz_skus s ON s.id=o.sku_id WHERE o.id=?',
            [m[1]]
          );
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          return jsonReply(res, rows[0]);
        }
      }

      // GET /api/juzhu/jz/subcategories
      if (urlPath === '/api/juzhu/jz/subcategories' && req.method === 'GET') {
        const qp = new URLSearchParams(qs);
        let sql = "SELECT * FROM jz_subcategories WHERE status='on'";
        const params = [];
        if (qp.get('type')) { sql += ' AND parent_type=?'; params.push(qp.get('type')); }
        sql += ' ORDER BY sort_order, id';
        const rows = await queryRows(sql, params);
        return jsonReply(res, { list: rows });
      }

      // ===== 运营商员工花名册（operator_staff）=====
      // 读：org.read（持有方/机构只读）或 worker.manage（运营商管理）；写：worker.manage + audit_log
      // 行级（scope）：org 档只见自家 + 平台级（org_id IS NULL）；vendor 档同理按 vendor_id；
      // city 档无城市映射，只见平台级行；all 档全量
      if (urlPath === '/api/juzhu/staff' && req.method === 'GET') {
        if (!(await requireAnyPerm(req, res, ['org.read', 'worker.manage'], '花名册'))) return;
        const principal = req.principal;
        const scope = authCenter.scopeOf(principal);
        let where = '';
        const params = [];
        if (scope.level === 'org' && scope.orgId != null) { where = ' WHERE (org_id=? OR org_id IS NULL)'; params.push(scope.orgId); }
        else if (scope.level === 'vendor' && scope.vendorId != null) { where = ' WHERE (vendor_id=? OR vendor_id IS NULL)'; params.push(scope.vendorId); }
        else if (scope.level === 'self') { where = ' WHERE phone=? AND phone IS NOT NULL'; params.push(String((principal.account || {}).phone || '')); }
        else if (scope.level !== 'all') { where = ' WHERE org_id IS NULL AND vendor_id IS NULL'; }
        const rows = await queryRows(`SELECT * FROM operator_staff${where} ORDER BY level DESC, month_orders DESC, id ASC`, params);
        return jsonReply(res, { list: rows, scope: scope.level });
      }

      if (urlPath === '/api/juzhu/staff' && req.method === 'POST') {
        if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
        const body = await readBody(req);
        const v = validateStaff(body, { partial: false });
        if (v.error) return jsonReply(res, { error: v.error }, 400);
        const clientEmpNo = (body.emp_no || '').trim() || null;
        const conn = await mysql2.createConnection(getDbConfig());
        try {
          const now = new Date().toISOString().slice(0, 19);
          const ins = 'INSERT INTO operator_staff (emp_no,name,phone,level,`role`,station,month_orders,rating,contract_type,contract_end,status,can_extra,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
          let row = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            const empNo = clientEmpNo || (await nextEmpNo(conn));
            row = { ...v.row, emp_no: empNo, created_at: now, updated_at: now };
            try {
              const [ret] = await conn.execute(ins, [
                row.emp_no, row.name, row.phone, row.level, row.role, row.station, row.month_orders, row.rating,
                row.contract_type, row.contract_end, row.status, row.can_extra, row.note, row.created_at, row.updated_at,
              ]);
              row.id = ret.insertId;
              break;
            } catch (e) {
              if (e && e.code === 'ER_DUP_ENTRY') {
                if (clientEmpNo) return jsonReply(res, { error: '工号已存在：' + clientEmpNo }, 400);
                if (attempt === 3) return jsonReply(res, { error: '工号生成冲突，请重试' }, 500);
                continue;
              }
              throw e;
            }
          }
          await conn.commit();
          await auditIfAccount(req, 'staff.create', 'operator_staff', String(row.id), row);
          return jsonReply(res, { ok: true, staff: row }, 201);
        } finally {
          await conn.end();
        }
      }

      {
        const m = urlPath.match(/^\/api\/juzhu\/staff\/(\d+)$/);
        if (m && req.method === 'GET') {
          if (!(await requireAnyPerm(req, res, ['org.read', 'worker.manage'], '花名册'))) return;
          const rows = await queryRows('SELECT * FROM operator_staff WHERE id=?', [parseInt(m[1], 10)]);
          if (!rows.length) return jsonReply(res, { error: 'not found' }, 404);
          // 行级 scope：同列表口径（org/vendor 只见自家 + 平台级）
          const scope = authCenter.scopeOf(req.principal);
          const r = rows[0];
          if (scope.level === 'org' && scope.orgId != null && r.org_id != null && Number(r.org_id) !== scope.orgId) {
            return jsonReply(res, { error: 'forbidden', message: '超出当前账号数据范围' }, 403);
          }
          if (scope.level === 'vendor' && scope.vendorId != null && r.vendor_id != null && Number(r.vendor_id) !== scope.vendorId) {
            return jsonReply(res, { error: 'forbidden', message: '超出当前账号数据范围' }, 403);
          }
          return jsonReply(res, r);
        }
        if (m && req.method === 'PUT') {
          if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
          const id = parseInt(m[1], 10);
          const body = await readBody(req);
          const v = validateStaff(body, { partial: true });
          if (v.error) return jsonReply(res, { error: v.error }, 400);
          if (!Object.keys(v.row).length) return jsonReply(res, { error: '无可更新字段' }, 400);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const [cur] = await conn.execute('SELECT * FROM operator_staff WHERE id=?', [id]);
            if (!cur.length) return jsonReply(res, { error: 'not found' }, 404);
            const sets = [];
            const params = [];
            for (const k of Object.keys(v.row)) {
              sets.push((k === 'role' ? '`role`' : k) + '=?');
              params.push(v.row[k]);
            }
            sets.push('updated_at=?');
            params.push(new Date().toISOString().slice(0, 19));
            params.push(id);
            try {
              await conn.execute('UPDATE operator_staff SET ' + sets.join(', ') + ' WHERE id=?', params);
            } catch (e) {
              if (e && e.code === 'ER_DUP_ENTRY') return jsonReply(res, { error: '工号已存在' }, 400);
              throw e;
            }
            await conn.commit();
            const after = await queryRows('SELECT * FROM operator_staff WHERE id=?', [id]);
            await auditIfAccount(req, 'staff.update', 'operator_staff', String(id), after[0]);
            return jsonReply(res, { ok: true, staff: after[0] });
          } finally {
            await conn.end();
          }
        }
        if (m && req.method === 'DELETE') {
          if (!(await requirePerm(req, res, 'worker.manage', '花名册维护'))) return;
          const id = parseInt(m[1], 10);
          const conn = await mysql2.createConnection(getDbConfig());
          try {
            const [cur] = await conn.execute('SELECT * FROM operator_staff WHERE id=?', [id]);
            if (!cur.length) return jsonReply(res, { error: 'not found' }, 404);
            await conn.execute('DELETE FROM operator_staff WHERE id=?', [id]);
            await conn.commit();
            await auditIfAccount(req, 'staff.delete', 'operator_staff', String(id), cur[0]);
            return jsonReply(res, { ok: true, id });
          } finally {
            await conn.end();
          }
        }
      }

      // 未匹配：返回 404
      return jsonReply(res, { error: '接口不存在', path: urlPath, method: req.method }, 404);
    } catch (e) {
      return jsonReply(res, { error: 'DB 查询失败: ' + e.message }, 500);
    }

  };
}

module.exports = { createApiDirectRouter };
