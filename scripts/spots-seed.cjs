#!/usr/bin/env node
/**
 * 周边玩法维度 seed/clean（规则 17：spots 字典 + 项目绑定）
 * 背景：C 端 lvju-app-detail「周边玩法」为读库渲染的杂志区块；点开进小红书式笔记详情页
 *       （lvju-app-spot-post.html，消费 body/photos/address/duration/ticket 字段）。
 *       本脚本灌贵阳（含全省通用）样例：25 地点（景区/商圈/美食/咖啡）+ 旅居 8 项目绑定，
 *       每组按「本地景区 + 本地商圈/美食 + 远途一日」编排。
 * 用法：node scripts/spots-seed.cjs seed|clean
 * 规则12/14：只用 Node + mysql2；凭证只读环境变量（juzhu/.env.local → JUZHU_DB_* / MYSQL_*）
 * 约束：幂等（spots 按 slug 判重后 INSERT/UPDATE；绑定先删本脚本涉及的 spot_id 再插）；
 *       clean 只删本脚本 slug 清单内的 spots 与绑定行，不动手工新建的地点。
 *       图集/封面只用 assets/lvju 已提交图（缩略图管线自动出 .t240/.t640）。
 */
const path = require('path');
const fs = require('fs');
// 手动加载 env（不覆盖语义=先到先得，.env.local 最先加载）——同 lvju-stay-seed.cjs
for (const f of ['juzhu/.env.local', '.env', 'runtime.env']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim().replace(/^export /, '');
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
const mysql = require('mysql2/promise');

const CITY_SLUG = 'guiyang';
const A = 'assets/lvju/';
// city_id=null = 全省通用（跨市目的地，任何项目可绑）；link 只挂已有 spot-detail 词条的 slug
const SPOTS = [
  // ── 景区（scenic）──
  { slug: 'qingyan-ancient-town', name: '青岩古镇', type: 'scenic', city: CITY_SLUG, icon: '🏮',
    cover: A + 'qingyan.jpg', sort: 10, tags: ['5A 级', '明清石巷', '古城墙'], link: null,
    address: '贵阳市花溪区青岩镇（本店步行 5 分钟）', duration: '半天', ticket: '古镇免费 · 联票 ¥60 可选',
    summary: '六百年的石头城。背街的青石板被岁月磨出包浆，状元蹄的酱香和玫瑰糖的甜混在烟火里；傍晚登城墙，万家灯火次第亮起，是青岩最温柔的一刻。',
    body: '青岩适合用半天慢慢走：北门进，沿背街的青石板一路走到古城墙，再从南门出来，刚好一个环线。\n\n背街是出片的地方——石板路被六百年的脚步磨出包浆，两侧是层层叠叠的石片墙，下午四点的斜光打过来最好看。\n\n傍晚一定要登一次城墙。万家灯火次第亮起的时候，你会明白为什么本地人说「夜青岩比日间更温柔」。',
    photos: [A + 'zhaoxing-dong.jpg', A + 'food-snack.jpg'] },
  { slug: 'xijiang-miao-village', name: '西江千户苗寨', type: 'scenic', city: null, icon: '⛰',
    cover: A + 'xijiang-night.jpg', sort: 20, tags: ['5A 景区', '民族村寨', '万家灯火'],
    link: null,   // 笔记详情页为 C 端主深链（spot.link 仅作 admin 覆写逃生口）
    address: '黔东南州雷山县（本店车程约 2.5 小时）', duration: '建议住一晚', ticket: '¥90（观光车另计）',
    summary: '上千座吊脚楼从谷底一直铺到云端，入夜灯火如银河倾泻。长桌宴的敬酒歌从水面升上来，观景台的日落值得提前一小时去占位。',
    body: '西江要看两次：白天看层层叠叠的吊脚楼，晚上看万家灯火。\n\n观景台的日落位要提前一小时去占，灯是一盏一盏亮起来的，等到最后一片山头也亮了，整条山谷就是一条银河。\n\n长桌宴别错过——敬酒歌一起，高山流水下来，你就是苗寨的贵客。',
    photos: [A + 'stilt-miao.jpg', A + 'food-banquet.jpg'] },
  { slug: 'huangguoshu-falls', name: '黄果树瀑布', type: 'scenic', city: null, icon: '🌊',
    cover: A + 'huangguoshu.jpg', sort: 30, tags: ['5A 景区', '大瀑布', '水帘洞'],
    link: null,   // 笔记详情页为 C 端主深链（spot.link 仅作 admin 覆写逃生口）
    address: '安顺市镇宁县（本店车程约 1.5 小时）', duration: '一天', ticket: '¥160（旺季，含观光车）',
    summary: '宽 101 米的水幕砸进犀牛潭，水声先于瀑布抵达。穿水帘洞而行，从瀑布背后看世界——旺季水量最盛，记得备一件一次性雨衣。',
    body: '黄果树是那种「先听见、再看见」的瀑布——人还在半公里外，水声就先到了。\n\n最妙的是水帘洞：从瀑布背后穿行，伸手就能摸到飞驰的水幕，这是全世界少有的体验。\n\n建议早出发，旅行团十点半以后才到；雨衣景区门口 ¥5 一件，别嫌土，真的有用。',
    photos: [A + 'guiyang-river.jpg'] },
  { slug: 'xiaoqikong', name: '荔波小七孔', type: 'scenic', city: null, icon: '💚',
    cover: A + 'xiaoqikong.jpg', sort: 40, tags: ['世界遗产', '喀斯特', '水上森林'],
    link: null,   // 笔记详情页为 C 端主深链（spot.link 仅作 admin 覆写逃生口）
    address: '黔南州荔波县（高铁约 1.5 小时）', duration: '建议两日', ticket: '¥110（淡旺季浮动）',
    summary: '七孔古桥横卧碧水，68 级跌水一路向下，卧龙潭蓝得不真实。沿水上森林走到鞋袜全湿，是孩子们最开心的一段。',
    body: '小七孔的蓝是分层的——卧龙潭是宝石蓝，鸳鸯湖是翡翠绿，68 级跌水又是另一种透亮的浅蓝。\n\n水上森林那段记得穿防滑鞋，根须盘错的小路就贴着溪水走，鞋袜全湿是这段路的正确打开方式。\n\n景区很大，摆渡车一定要坐；把体力留给步行最美的一段，才不亏。',
    photos: [A + 'countryside.jpg'] },
  { slug: 'fanjingshan', name: '梵净山', type: 'scenic', city: null, icon: '☁',
    cover: A + 'fanjingshan.jpg', sort: 50, tags: ['世界遗产', '红云金顶', '云海'],
    link: null,   // 笔记详情页为 C 端主深链（spot.link 仅作 admin 覆写逃生口）
    address: '铜仁市江口县（本店车程约 2.5 小时）', duration: '一天', ticket: '¥110 + 索道 ¥140（需线上预约）',
    summary: '武陵之巅。缆车穿出云层的一瞬，红云金顶孤零零立在云海上；蘑菇石前风很大，日出前的半小时最安静，也最值得。',
    body: '梵净山要看运气，也要看本事——运气是云海，本事是早起。\n\n缆车穿出云层的那一瞬间，红云金顶孤零零立在云海上，整节车厢都会安静下来。\n\n金顶的爬梯近乎垂直，手脚并用十分钟，顶上的两座庙和一脚跨两亿的观感，值。',
    photos: [A + 'wanfenglin.jpg'] },
  { slug: 'guanshanhu-park', name: '观山湖公园', type: 'scenic', city: CITY_SLUG, icon: '🌿',
    cover: A + 'countryside.jpg', sort: 60, tags: ['城市绿肺', '环湖跑道', '亲子'], link: null,
    address: '贵阳市观山湖区（本店步行 12 分钟）', duration: '2 小时', ticket: '免费',
    summary: '环湖 5 公里，清晨有白鹭贴着水面飞。租一辆共享单车绕一圈，湖对岸的楼群刚从薄雾里露出轮廓，是市区难得的深呼吸。',
    body: '本地人的晨练圣地——环湖 5 公里，前半段是开阔湖面，后半段钻进林荫道，跑完一身舒爽。\n\n清晨六七点有白鹭贴着水面飞；租一辆共享单车绕一圈，湖对岸的楼群刚从薄雾里露出轮廓。\n\n带娃的话，湖心的黑天鹅和沿岸的游乐区足够消磨一个下午。',
    photos: [A + 'guiyang-river.jpg'] },
  { slug: 'nanjiang-canyon', name: '南江大峡谷', type: 'scenic', city: CITY_SLUG, icon: '🛶',
    cover: A + 'guiyang-river.jpg', sort: 70, tags: ['峡谷', '漂流', '栈道'], link: null,
    address: '贵阳市开阳县南江乡（本店车程约 25 分钟）', duration: '半天', ticket: '¥78 · 漂流另计',
    summary: '开阳的绿色地缝。栈道贴着峭壁一路往谷底走，瀑布从头顶泼下来；夏天漂流是重头戏，两个多小时的清凉，上岸后一碗豆花面最熨帖。',
    body: '南江大峡谷是一条绿色的地缝——栈道贴着峭壁悬空而建，瀑布从头顶泼下来，走到谷底浑身都是水汽。\n\n夏天来就是为了漂流：两个多小时冲下来，平缓段打水仗，险滩段抓紧扶手尖叫就好。\n\n上岸别急着走，景区口的豆花面是开阳一绝，辣鸡臊子给得毫不手软。',
    photos: [A + 'countryside.jpg', A + 'xiaoqikong.jpg'] },
  { slug: 'xifeng-hot-spring', name: '息烽温泉', type: 'scenic', city: CITY_SLUG, icon: '♨',
    cover: A + 'xiaoqikong.jpg', sort: 80, tags: ['温泉', '康养', '四季皆宜'], link: null,
    address: '贵阳市息烽县温泉镇（本店步行 8 分钟）', duration: '半天', ticket: '住客享协议价',
    summary: '西南名泉，水温常年五十多度，泡完皮肤滑得像缎子。山林间一圈汤池，冬天雪夜泡汤最妙；住客出发前问前台拿优惠。',
    body: '息烽温泉是正经的「西南名泉」，水温常年五十多度，含氡——泡完皮肤滑得像缎子，这不是我说的，是每个泡过的人说的。\n\n汤池散在山林间，冬天最妙：头顶是雾气，肩上是雪，泡到指尖发红再上岸。\n\n住我们汤院的话，出发前问前台拿协议价；记得自带泳衣，现场买贵。',
    photos: [A + 'countryside.jpg'] },
  { slug: 'hongfeng-hu', name: '红枫湖', type: 'scenic', city: CITY_SLUG, icon: '🛥',
    cover: A + 'wanfenglin.jpg', sort: 90, tags: ['高原湖泊', '候鸟', '日落'], link: null,
    address: '贵阳市清镇市（本店步行 6 分钟）', duration: '半天', ticket: '免费 · 游船另计',
    summary: '高原上的一面镜子，湖心小岛像散落的棋子。清晨湖面起雾时最美，坐一趟游船，黄昏在湖畔等红枫倒影，秋冬还有候鸟抵达。',
    body: '红枫湖是高原上的一面镜子，湖心的小岛像散落的棋子。\n\n清晨湖面起雾的时候最美，渔船的剪影从雾里出来，随手一拍都是水墨画；黄昏再来一次，等红枫的倒影把湖面染透。\n\n秋冬是候鸟季，带长焦的摄影爱好者请早占湖畔东侧的观鸟位。',
    photos: [A + 'countryside.jpg', A + 'guiyang-river.jpg'] },
  { slug: 'taoyuanhe', name: '桃源河', type: 'scenic', city: CITY_SLUG, icon: '🚣',
    cover: A + 'xiaoqikong.jpg', sort: 100, tags: ['漂流', '溯溪', '山野'], link: null,
    address: '贵阳市修文县（本店步行 4 分钟）', duration: '半天', ticket: '漂流 ¥168（季节性开放）',
    summary: '修文人夏天的集合地。漂流从山上冲下来一路尖叫，平缓段可以打水仗；不漂流的季节沿河谷徒步，野趣十足。',
    body: '桃源河是修文人夏天的集合地——漂流从山上冲下来，落差一个接一个，一路尖叫到终点。\n\n平缓段适合打水仗，本地小孩的战斗力不容小觑，建议先发制人。\n\n不漂流的季节也有意思：沿河谷徒步，水潭碧绿，石头缝里全是螃蟹洞，野趣十足。',
    photos: [A + 'countryside.jpg'] },
  { slug: 'yangming-culture-park', name: '阳明文化园', type: 'scenic', city: CITY_SLUG, icon: '📖',
    cover: A + 'guiyang-river.jpg', sort: 110, tags: ['阳明洞', '古建筑', '人文'], link: null,
    address: '贵阳市修文县龙场镇（本店车程约 25 分钟）', duration: '2 小时', ticket: '免费',
    summary: '王阳明龙场悟道的地方。古柏参天，洞内清凉，碑刻一路读过去，半小时就能静下来；园子不大，适合下午慢慢逛。',
    body: '「龙场悟道」就发生在这里——王阳明被贬到修文的那个夜晚，彻底想通了心学的核心命题。\n\n阳明洞比想象中朴素，古柏参天，洞内清凉；碑刻一路读过去，字都是熟悉的意思，心会慢慢静下来。\n\n园子不大，两小时足够；建议下午去，出来后在县城吃碗牛肉粉，一天都很完整。',
    photos: [A + 'zhaoxing-dong.jpg'] },
  { slug: 'shilihetan-wetland', name: '十里河滩湿地公园', type: 'scenic', city: CITY_SLUG, icon: '🌾',
    cover: A + 'countryside.jpg', sort: 120, tags: ['湿地', '城市绿肺', '骑行'], link: null,
    address: '贵阳市花溪区（本店步行 3 分钟）', duration: '2 小时', ticket: '免费',
    summary: '花溪的城市绿肺，河滩湿地一路铺开。清晨有白鹭，傍晚有放风筝的孩子；沿栈道走到花溪公园，是本地人最日常的散步路线。',
    body: '花溪人的日常从这里开始——十里河滩，河滩湿地沿着花溪河铺开，栈道、芦苇、水车，一步一景。\n\n清晨有白鹭贴着水面飞，傍晚有放风筝的孩子和写生的学生；租一辆单车骑到花溪公园，是本地人最日常的散步路线。\n\n出片机位：水车附近的花田，和任何一段逆光的木栈道。',
    photos: [A + 'guiyang-river.jpg'] },
  { slug: 'xiangzhigou', name: '香纸沟', type: 'scenic', city: CITY_SLUG, icon: '🎋',
    cover: A + 'zhaoxing-dong.jpg', sort: 130, tags: ['古法造纸', '竹海', '溪谷'], link: null,
    address: '贵阳市乌当区（本店步行 15 分钟进山）', duration: '半天', ticket: '¥35',
    summary: '乌当山里的竹海溪谷，至今还留着古法造纸的作坊。沿着水碾房一路走，竹荫把夏天隔在外面；带孩子来体验抄纸最合适。',
    body: '香纸沟的名字来自纸——山里的竹海溪谷间，至今还留着古法造纸的作坊，竹料在水碾房里被打成浆。\n\n沿着溪谷一路走，竹荫把夏天整个隔在外面，溪水凉得刺骨。\n\n带娃强烈推荐：亲手抄一张纸带回家，比任何研学课都直观。',
    photos: [A + 'countryside.jpg', A + 'stilt-miao.jpg'] },

  // ── 商圈（biz）──
  { slug: 'qingyan-north-market', name: '青岩古镇北门集市', type: 'biz', city: CITY_SLUG, icon: '🧺',
    cover: A + 'food-snack.jpg', sort: 10, tags: ['集市', '玫瑰糖', '伴手礼'], link: null,
    address: '青岩古镇北门内（本店步行 6 分钟）', duration: '1 小时', ticket: '免费',
    summary: '北门进来一路是摊：糕粑稀饭冒着热气，鸡辣角论勺卖，玫瑰糖现熬现切。老板娘会掰一块塞给你先尝，甜得理直气壮。',
    body: '北门进来一路全是摊：糕粑稀饭冒着热气，鸡辣角论勺卖，玫瑰糖现熬现切，甜香能飘半条街。\n\n这里的规矩是先尝后买——老板娘会掰一块玫瑰糖直接塞给你，甜得理直气壮。\n\n伴手礼在这里解决最合适：玫瑰糖、鸡辣角、血豆腐，真空包装都能带上高铁。',
    photos: [A + 'food-sourfish.jpg', A + 'qingyan.jpg'] },
  { slug: 'qingyan-food-lane', name: '青岩南门美食巷', type: 'biz', city: CITY_SLUG, icon: '🍲',
    cover: A + 'food-sourfish.jpg', sort: 20, tags: ['酸汤鱼', '长桌宴', '夜宵'], link: null,
    address: '青岩古镇南门（本店步行 8 分钟）', duration: '晚餐', ticket: '人均 ¥50-80',
    summary: '巷口那家酸汤鱼开了二十年，红酸汤是用毛辣果发酵出来的，酸得发亮。配一份糯米饭和折耳根蘸水，宵夜就这么解决了。',
    body: '巷口那家酸汤鱼开了二十年——红酸汤用毛辣果自然发酵，酸得发亮，鱼是现捞的稻花鲤。\n\n点单口诀：酸汤鱼 + 糯米饭 + 折耳根蘸水，本地人三件套。\n\n夏天夜里坐在巷子里的矮桌上，风吹过灯笼，比任何网红店都惬意。',
    photos: [A + 'food-banquet.jpg', A + 'qingyan.jpg'] },
  { slug: 'guiyang-qingyun-market', name: '青云市集', type: 'biz', city: CITY_SLUG, icon: '🌃',
    cover: A + 'guiyang-city.jpg', sort: 30, tags: ['夜市', '在地小吃', '市集'], link: null,
    address: '贵阳市南明区青云路（车程约 40 分钟）', duration: '晚餐 + 宵夜', ticket: '人均 ¥40-60',
    summary: '老厂房改的市集，晚上七点以后最好逛：烤豆腐、冰浆、烙锅一路吃过去，摊主都愿意跟你聊两句。周末有现场乐队。',
    body: '老厂房改的市集，晚上七点以后才真正醒来——烤豆腐、冰浆、烙锅、洋芋粑，一路吃过去不用¥60。\n\n摊主都很愿意跟你聊两句，聊着聊着就多送你一块豆腐。\n\n周末有现场乐队，坐在露天位喝一杯冰浆，是贵阳年轻人的周末样本。',
    photos: [A + 'food-noodle.jpg', A + 'food-banquet.jpg'] },
  { slug: 'kaixian-food-street', name: '开阳县城食街', type: 'biz', city: CITY_SLUG, icon: '🍜',
    cover: A + 'food-noodle.jpg', sort: 40, tags: ['豆花面', '县城烟火', '夜宵'], link: null,
    address: '开阳县城（本店车程约 30 分钟）', duration: '晚餐', ticket: '人均 ¥25-40',
    summary: '县城的烟火气都在这条街上：豆花面、烤豆腐、素粉从早开到晚，价格实在得很。赶集天更热闹，周边乡镇的人都进城来。',
    body: '县城的烟火气都集中在这条街上：豆花面、烤豆腐、素粉，从早开到晚，价格实在得很。\n\n赶集天（逢农历三、八）最热闹，周边乡镇的人都进城来，街两边的摊子能摆出去一公里。\n\n豆花面认准老店——豆花要嫩，辣鸡臊子要给得大方。',
    photos: [A + 'food-snack.jpg'] },
  { slug: 'xifeng-food-street', name: '息烽县城食街', type: 'biz', city: CITY_SLUG, icon: '🍲',
    cover: A + 'food-banquet.jpg', sort: 50, tags: ['阳朗辣子鸡', '县城烟火', '宵夜'], link: null,
    address: '息烽县城（本店车程约 15 分钟）', duration: '晚餐', ticket: '人均 ¥45-70',
    summary: '来息烽不能错过阳朗辣子鸡，县城里做得最地道。一锅端上来滋滋作响，配一杯本地苞谷酒，是汤池泡完后的最佳收尾。',
    body: '息烽的名片除了温泉就是阳朗辣子鸡——糍粑辣椒炒出来的鸡块，滋滋作响地上桌，越煮越香。\n\n县城里做得最地道的几家都在这条街上，配一杯本地苞谷酒，是泡完汤之后的最佳收尾。\n\n辣度可以选，但本地人会说：不辣的辣子鸡是没有灵魂的。',
    photos: [A + 'food-sourfish.jpg'] },
  { slug: 'shiqing-guizhou', name: '时光贵州', type: 'biz', city: CITY_SLUG, icon: '🏘',
    cover: A + 'qingyan.jpg', sort: 60, tags: ['仿古镇', '夜景', '小吃'], link: null,
    address: '贵阳市清镇市（本店车程约 15 分钟）', duration: '傍晚 + 晚餐', ticket: '免费',
    summary: '清镇的仿古镇街区，晚上灯一亮最好看。小吃摊、咖啡馆、小酒馆混在一起，本地年轻人周末聚点，散步消食正合适。',
    body: '仿古镇街区，白天平平无奇，晚上灯一亮就换了人间——民国风的楼体打上暖光，比想象中出片。\n\n小吃摊、咖啡馆、小酒馆混在一起，是清镇本地年轻人的周末聚点。\n\n适合饭后来散步消食，走累了随便钻一家小店坐下，都不踩雷。',
    photos: [A + 'guiyang-city.jpg'] },

  // ── 美食（food）──
  { slug: 'qingyan-zhuangyuan-ti', name: '青岩状元蹄老铺', type: 'food', city: CITY_SLUG, icon: '🍖',
    cover: A + 'food-banquet.jpg', sort: 70, tags: ['状元蹄', '老字号', '伴手礼'], link: null,
    address: '青岩古镇内（本店步行 7 分钟）', duration: '堂食 / 打包', ticket: '¥35-45 / 只',
    summary: '青岩的状元蹄讲究「卤得透、皮弹肉糯」，老铺的卤锅二十年了没换过底汤。趁热啃一只，再打包两只路上吃。',
    body: '状元蹄是青岩的头号招牌——传说是当年给进京赶考的书生饯行的菜，所以叫「状元」蹄。\n\n老铺的卤锅二十年没换过底汤，卤得透、皮弹肉糯，筷子一夹就骨肉分离。\n\n趁热在店里啃一只，再打包两只路上吃；真空包装的放三天没问题。',
    photos: [A + 'food-snack.jpg', A + 'food-sourfish.jpg'] },
  { slug: 'huaxi-beef-noodle', name: '花溪牛肉粉老店', type: 'food', city: CITY_SLUG, icon: '🍜',
    cover: A + 'food-noodle.jpg', sort: 80, tags: ['牛肉粉', '早餐信仰', '老字号'], link: null,
    address: '贵阳市花溪区（本店车程约 12 分钟）', duration: '早餐 / 午餐', ticket: '¥15-25 / 碗',
    summary: '花溪人的早餐信仰：清汤牛肉粉。牛肉是当天现宰的黄牛肉，汤要用牛骨熬足六个小时，撒一把糊辣椒和薄荷，才算正经。',
    body: '花溪人的早餐信仰就是这一碗清汤牛肉粉——牛肉是当天现宰的黄牛肉，汤用牛骨熬足六个小时。\n\n正确吃法：先喝一口原汤，再加糊辣椒和薄荷，最后把牛肉吃完再嗦粉。\n\n早上七点到九点是高峰，本地人端着碗站在路边吃，才是这碗粉的正确姿势。',
    photos: [A + 'food-snack.jpg'] },
  { slug: 'guiyang-siwawa', name: '贵阳丝娃娃小馆', type: 'food', city: CITY_SLUG, icon: '🥬',
    cover: A + 'food-banquet.jpg', sort: 90, tags: ['丝娃娃', '蘸水', '在地小吃'], link: null,
    address: '贵阳市区（车程约 30 分钟）', duration: '午餐 / 晚餐', ticket: '人均 ¥40-60',
    summary: '丝娃娃是贵阳人的「满汉全席」：十几二十个小碟围着薄面皮，想包什么全凭自己。灵魂是那勺酸汤蘸水，一口下去满嘴清爽。',
    body: '丝娃娃是贵阳人的「满汉全席」——十几二十个小碟围着薄如纸的面皮，酸萝卜、折耳根、海带丝、脆臊……想包什么全凭自己。\n\n灵魂是最后那勺酸汤蘸水，从面皮口灌进去，一口下去满嘴清爽。\n\n新手提示：面皮要摊开在手心，菜别贪多，包成小口袋才不会散。',
    photos: [A + 'food-snack.jpg', A + 'food-noodle.jpg'] },
  { slug: 'kaixian-douhua-noodle', name: '开阳豆花面老店', type: 'food', city: CITY_SLUG, icon: '🍳',
    cover: A + 'food-snack.jpg', sort: 100, tags: ['豆花面', '辣鸡臊子', '县城味道'], link: null,
    address: '开阳县城（本店车程约 28 分钟）', duration: '早餐 / 午餐', ticket: '¥12-18 / 碗',
    summary: '豆花要嫩到筷子夹不起来，辣鸡臊子要给得大方——开阳人的早晨从一碗豆花面开始，出了这个县就吃不到这个味。',
    body: '开阳人的早晨从一碗豆花面开始：豆花要嫩到筷子夹不起来，辣鸡臊子要给得大方，蘸水要另外配。\n\n正确吃法是把面条和豆花一起捞进蘸水碗里，让每一根面条都裹上辣鸡的香。\n\n出了这个县就吃不到这个味，所以本地人在外地打工，回家第一件事就是来这儿。',
    photos: [A + 'food-noodle.jpg'] },

  // ── 咖啡（cafe）──
  { slug: 'qingyan-cafe', name: '青岩·南城门院落咖啡', type: 'cafe', city: CITY_SLUG, icon: '☕',
    cover: A + 'countryside.jpg', sort: 70, tags: ['院落咖啡', '古镇慢时光', '手冲'], link: null,
    address: '青岩古镇南门附近（本店步行 4 分钟）', duration: '1-2 小时', ticket: '人均 ¥35-50',
    summary: '古镇里难得的安静院子：石片墙下喝一杯贵州产地手冲，阳光从屋檐斜进来，猫在门口打盹。逛累古镇的最佳充电点。',
    body: '古镇里难得的安静院子——石片墙、老木门，院子里一株石榴树，猫在门口打盹。\n\n咖啡单以贵州产地手冲为主（普安红、遵义都有豆单），不喝咖啡的也有好几种本地草本茶。\n\n逛累古镇的最佳充电点：阳光从屋檐斜进来，什么都不干地坐一小时，就是旅居该有的样子。',
    photos: [A + 'qingyan.jpg', A + 'countryside.jpg'] },
  { slug: 'taipinglu-cafe', name: '太平路咖啡老街', type: 'cafe', city: CITY_SLUG, icon: '🫘',
    cover: A + 'food-snack.jpg', sort: 80, tags: ['咖啡一条街', '老街漫步', '周末去哪'], link: null,
    address: '贵阳市云岩区太平路（车程约 35 分钟）', duration: '半天', ticket: '人均 ¥30-55',
    summary: '贵阳的咖啡一条街：一条坡道上挤着十几家独立咖啡馆，家家有自己的豆单和脾气。挑一家窗边的位子，看老街人来人往。',
    body: '太平路是贵阳的咖啡一条街——一条坡道上挤着十几家独立咖啡馆，家家有自己的豆单和脾气。\n\n不用做攻略，凭眼缘推门就好：想安静挑窗边的位子，想聊天就坐门口的长凳。\n\n把这里和文昌阁、电台街串成一条徒步线，是认识老贵阳最好的方式。',
    photos: [A + 'guiyang-city.jpg'] },
];

// 项目绑定（note = 编辑行文：步程/车程 + 推荐理由；sort_order 决定封面故事卡与分组内顺序）
const BINDINGS = [
  { project: 'shanshe-qingyan', spots: [
    ['qingyan-ancient-town', 10, '步行 5 分钟 · 古镇北门'],
    ['qingyan-zhuangyuan-ti', 20, '步行 7 分钟 · 状元蹄发源老铺'],
    ['qingyan-north-market', 30, '步行 6 分钟 · 出巷即到'],
    ['qingyan-food-lane', 40, '步行 8 分钟 · 营业至 23:00'],
    ['qingyan-cafe', 50, '步行 4 分钟 · 院落里喝一杯'],
    ['xijiang-miao-village', 60, '车程约 2.5 小时 · 建议住一晚看夜景'],
    ['huangguoshu-falls', 70, '车程约 1.5 小时 · 建议早出发'],
  ] },
  { project: 'shanshe-forest', spots: [
    ['guanshanhu-park', 10, '步行 12 分钟 · 环湖跑道'],
    ['guiyang-qingyun-market', 20, '车程约 18 分钟 · 晚饭后正合适'],
    ['xiaoqikong', 30, '高铁约 1.5 小时 · 建议两日'],
    ['fanjingshan', 40, '车程约 2.5 小时 · 需提前线上预约'],
  ] },
  // lvju-stay-seed 六套区县旅居（2026-09-06 补绑；0747 加美食/咖啡）
  { project: 'shanshe-nanjiang', spots: [
    ['nanjiang-canyon', 10, '车程约 25 分钟 · 峡谷漂流与栈道'],
    ['kaixian-douhua-noodle', 20, '车程约 28 分钟 · 出山后第一碗'],
    ['kaixian-food-street', 30, '车程约 30 分钟 · 赶集天最热闹'],
    ['xijiang-miao-village', 40, '车程约 2 小时 · 顺路住一晚看夜景'],
  ] },
  { project: 'shanshe-xifeng-wenquan', spots: [
    ['xifeng-hot-spring', 10, '步行 8 分钟 · 汤院住客享优惠'],
    ['xifeng-food-street', 20, '车程约 15 分钟 · 晚饭去县城'],
    ['huangguoshu-falls', 30, '车程约 2 小时 · 建议早出发'],
  ] },
  { project: 'shanshe-hongfenghu', spots: [
    ['hongfeng-hu', 10, '步行 6 分钟 · 湖畔日出机位'],
    ['shiqing-guizhou', 20, '车程约 15 分钟 · 仿古街晚饭与小吃'],
    ['guiyang-qingyun-market', 30, '车程约 40 分钟 · 周末夜市'],
  ] },
  { project: 'shanshe-taoyuanhe', spots: [
    ['taoyuanhe', 10, '步行 4 分钟 · 漂流季下船即到家'],
    ['yangming-culture-park', 20, '车程约 25 分钟 · 阳明洞与碑刻'],
    ['guiyang-qingyun-market', 30, '车程约 50 分钟 · 进城逛夜市'],
  ] },
  { project: 'shanshe-shilihetan', spots: [
    ['shilihetan-wetland', 10, '步行 3 分钟 · 出门即湿地栈道'],
    ['huaxi-beef-noodle', 20, '车程约 12 分钟 · 花溪人的早餐信仰'],
    ['qingyan-ancient-town', 30, '车程约 15 分钟 · 傍晚登城墙'],
    ['qingyan-food-lane', 40, '车程约 15 分钟 · 酸汤鱼老店'],
    ['guiyang-siwawa', 50, '车程约 30 分钟 · 蘸水是一绝'],
    ['taipinglu-cafe', 60, '车程约 35 分钟 · 咖啡一条街'],
    ['guiyang-qingyun-market', 70, '车程约 35 分钟 · 夜市收尾'],
  ] },
  // ⚠️ 该项目现库 slug 为中文名（migrate-housing-channels 早期灌入，非 lvju-stay-seed 的
  // 'shanshe-xiangzhigou'），按库内实际值解析；若日后改 slug 这里会 strict-fail 提示同步
  { project: '山舍·香纸沟山林小筑', spots: [
    ['xiangzhigou', 10, '步行 15 分钟 · 古法造纸作坊群'],
    ['guiyang-qingyun-market', 20, '车程约 40 分钟 · 周末夜市'],
    ['xijiang-miao-village', 30, '车程约 2.5 小时 · 建议住一晚'],
  ] },
];

async function conn() {
  const c = await mysql.createConnection({
    host: process.env.JUZHU_DB_HOST || process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.JUZHU_DB_PORT || process.env.MYSQL_PORT || '3306', 10),
    user: process.env.JUZHU_DB_USER || process.env.MYSQL_USER || 'root',
    password: process.env.JUZHU_DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.JUZHU_DB_NAME || process.env.MYSQL_DB || 'juzhu',
    charset: 'utf8mb4',
  });
  return c;
}

async function resolveRefs(db) {
  const [city] = await db.execute('SELECT id FROM cities WHERE slug=? LIMIT 1', [CITY_SLUG]);
  if (!city.length) throw new Error('找不到城市 ' + CITY_SLUG);
  return { cityId: city[0].id };
}

async function seed(db) {
  const { cityId } = await resolveRefs(db);
  const spotIds = {};
  let nNew = 0, nUpd = 0;
  for (const s of SPOTS) {
    const city_id = s.city ? cityId : null;
    const [ex] = await db.execute('SELECT id FROM spots WHERE slug=? LIMIT 1', [s.slug]);
    if (ex.length) {
      await db.execute(
        `UPDATE spots SET type=?, name=?, city_id=?, icon=?, cover_image=?, summary=?, body=?, photos=?,
         address=?, duration=?, ticket=?, tags=?, link=?, sort_order=?, enabled=1 WHERE id=?`,
        [s.type, s.name, city_id, s.icon, s.cover, s.summary, s.body || null,
         JSON.stringify(s.photos || []), s.address || null, s.duration || null, s.ticket || null,
         JSON.stringify(s.tags), s.link, s.sort, ex[0].id]);
      spotIds[s.slug] = ex[0].id;
      nUpd++;
      continue;
    }
    const [r] = await db.execute(
      `INSERT INTO spots(city_id,type,name,slug,icon,cover_image,summary,body,photos,address,duration,ticket,tags,link,sort_order,enabled)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [city_id, s.type, s.name, s.slug, s.icon, s.cover, s.summary, s.body || null,
       JSON.stringify(s.photos || []), s.address || null, s.duration || null, s.ticket || null,
       JSON.stringify(s.tags), s.link, s.sort]);
    spotIds[s.slug] = r.insertId;
    nNew++;
  }
  console.log(`seed: spots 新增 ${nNew} / 更新 ${nUpd}`);

  let nBind = 0;
  for (const b of BINDINGS) {
    const [p] = await db.execute('SELECT id FROM projects WHERE slug=? LIMIT 1', [b.project]);
    if (!p.length) throw new Error(`找不到项目 ${b.project}（先跑 migrate-housing-channels / lvju-stay-seed）`);
    const pid = p[0].id;
    const ids = b.spots.map((x) => spotIds[x[0]]);
    const ph = ids.map(() => '?').join(',');
    await db.execute(`DELETE FROM project_spots WHERE project_id=? AND spot_id IN (${ph})`, [pid, ...ids]);
    for (const [slug, sort, note] of b.spots) {
      await db.execute('INSERT INTO project_spots(project_id,spot_id,note,sort_order) VALUES (?,?,?,?)',
        [pid, spotIds[slug], note, sort]);
      nBind++;
    }
    console.log(`seed: #${pid} ${b.project} 绑定 ${b.spots.length} 处（首卡 = ${b.spots[0][0]}）`);
  }
  console.log(`seed 完成：绑定 ${nBind} 条`);
}

async function clean(db) {
  const slugs = SPOTS.map((s) => s.slug);
  const ph = slugs.map(() => '?').join(',');
  const [rows] = await db.execute(`SELECT id, slug FROM spots WHERE slug IN (${ph})`, slugs);
  if (!rows.length) { console.log('clean: 无本脚本地点，跳过'); return; }
  const ids = rows.map((r) => r.id);
  const iph = ids.map(() => '?').join(',');
  const [b] = await db.execute(`SELECT COUNT(*) AS c FROM project_spots WHERE spot_id IN (${iph})`, ids);
  await db.execute(`DELETE FROM project_spots WHERE spot_id IN (${iph})`, ids);
  await db.execute(`DELETE FROM spots WHERE id IN (${iph})`, ids);
  console.log(`clean 完成：删除 spots ${ids.length} 个、绑定 ${b[0].c} 条（仅本脚本 slug 清单）`);
}

(async () => {
  const mode = process.argv[2] || '';
  if (!['seed', 'clean'].includes(mode)) {
    console.error('用法: node scripts/spots-seed.cjs seed|clean');
    process.exit(1);
  }
  const db = await conn();
  try {
    if (mode === 'seed') await seed(db);
    else await clean(db);
  } finally {
    await db.end();
  }
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
