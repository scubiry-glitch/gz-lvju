/* 旅居 C 端价格展示（2026-09）。口径单一数据源 = 服务端 stay_config.priceDisplayOf，
 * 随 catalog / 项目详情 / units 接口下发三件套：
 *   price_from_display  数值（最低可售单夜价 或 起价）| null
 *   price_unit          'night' | 'month' | null（null = 该频道不适用，走 price_total）
 *   price_note          无价时的文案：'暂无可订'（按晚扫不到可售）/ '价格面议'（按月未配起价）
 * 页面一律读这里，不得再用 price_from 自行折算或硬编码「/月起」「/晚起」。 */
(function (w) {
  'use strict';
  var UNIT_TEXT = { night: '/晚起', month: '/月起' };

  function parts(p) {
    p = p || {};
    var v = p.price_from_display;
    v = (v == null || !(Number(v) > 0)) ? null : Number(v);
    return { value: v, unit: p.price_unit || null, note: p.price_note || '价格面议' };
  }

  w.LVJU_PRICE = {
    parts: parts,
    /** 单位后缀（'/晚起' / '/月起'）；无价返回 null，此时用 noteText(p) 的文案 */
    unitText: function (p) { var r = parts(p); return r.value == null ? null : (UNIT_TEXT[r.unit] || ''); },
    /** 无价文案（'暂无可订' / '价格面议'） */
    noteText: function (p) { return parts(p).note; },
    /** 户型默认单夜价：服务端随 unit 下发的 default_night_price（含户型夜价 > 月租折算 > 起价折算），
     *  老数据/老进程缺字段时回落 rent_monthly/30，保证详情页与下单页取数同源。 */
    unitNight: function (u) {
      u = u || {};
      if (u.default_night_price != null) return Number(u.default_night_price) || 0;
      return u.rent_monthly ? Math.max(1, Math.round(u.rent_monthly / 30)) : 0;
    }
  };
})(window);
