/** 家政类目 Landing · 共享渲染（4 页 data-type 驱动） */
(function(){
  var PAGES = {
    cleaning: {
      cls: 'cleaning', name: '保洁', ek: 'CLEANING · 白名单商家',
      slogan: '随叫随到 · 不满意重做',
      sub: '沈阳 5km 内 · 30 分钟极速上门',
      live: '今日已有 <b>127</b> 位业主预订',
      badges: ['🛡 百万保障', '✓ 白名单商家', '⚡ 不满意重做'],
      strip: ['<b>30min</b>极速上门', '<b>4.9</b>服务评分', '<b>金牌</b>认证', '<b>7×12</b>客服'],
      subs: [
        { icon:'🧹', name:'日常保洁', price:'¥45/小时起', sub:'日常保洁' },
        { icon:'✨', name:'深度清洁', price:'¥268/次起', sub:'深度清洁' },
        { icon:'🏠', name:'开荒保洁', price:'¥198/次起', sub:'开荒保洁' },
        { icon:'🪟', name:'玻璃清洗', price:'¥15/㎡起', sub:'玻璃清洗' },
        { icon:'💨', name:'油烟机清洗', price:'¥89/台起', sub:'油烟机清洗' },
        { icon:'📦', name:'收纳整理', price:'¥99/小时起', sub:'收纳整理' }
      ],
      trust: [
        { ic:'🔍', nm:'平台背调', sub:'全员持证' },
        { ic:'💎', nm:'百万保障', sub:'中国人保' },
        { ic:'🏷', nm:'价格透明', sub:'无隐形消费' },
        { ic:'🔁', nm:'不满意重做', sub:'7天无理由' }
      ],
      hot: [
        { pic:'🧹', tag:'热销 TOP1', title:'日常保洁 2小时', meta:'上门除尘 · 死无死角', rate:'4.7 · 已订 5.3万', price:'¥45', unit:'/小时起', orig:'¥80', sub:'日常保洁' },
        { pic:'✨', tag:'超值', tagAlt:true, title:'深度清洁 4小时', meta:'3人团队 · 含厨卫去污', rate:'4.8 · 已订 1.6万', price:'¥268', unit:'/次起', orig:'¥580', sub:'深度清洁' },
        { pic:'💨', tag:'', title:'油烟机深度清洗', meta:'拆装深度 · 高温蒸汽', rate:'4.9 · 已订 8.2万', price:'¥89', unit:'/台起', orig:'¥180', sub:'油烟机清洗' },
        { pic:'🏠', tag:'', title:'新房开荒保洁', meta:'含甲醛检测 · 入住无忧', rate:'4.6 · 已订 1.2万', price:'¥198', unit:'/次起', orig:'¥380', sub:'开荒保洁' }
      ],
      ctaHint: '今日 127 位业主已预订',
      ctaPri: '立即匹配 3 家报价'
    },
    repair: {
      cls: 'repair', name: '维修', ek: 'REPAIR · 白名单商家',
      slogan: '急速上门 · 30 分钟响应',
      sub: '持证电工 / 水工 / 家电维修',
      live: '今日已有 <b>86</b> 位业主呼叫',
      badges: ['🔧 持证上岗', '⏱ 30分钟响应', '💎 90天保修'],
      strip: ['<b>30min</b>响应', '<b>持证</b>师傅', '<b>先报价</b>再施工', '<b>90天</b>保修'],
      subs: [
        { icon:'📺', name:'家电维修', price:'¥89/次起', sub:'家电维修' },
        { icon:'🚽', name:'管道疏通', price:'¥99/次起', sub:'管道疏通' },
        { icon:'💡', name:'灯具电路', price:'¥69/次起', sub:'灯具电路' },
        { icon:'🚪', name:'门窗维修', price:'¥79/次起', sub:'门窗维修' },
        { icon:'❄️', name:'空调维修', price:'¥128/次起', sub:'空调维修' },
        { icon:'🚰', name:'水管维修', price:'¥89/次起', sub:'水管维修' }
      ],
      trust: [
        { ic:'🔍', nm:'平台背调', sub:'全员持证' },
        { ic:'🛡', nm:'90天保修', sub:'同故障免费' },
        { ic:'🏷', nm:'价格透明', sub:'先报价再施工' },
        { ic:'⏱', nm:'极速上门', sub:'30分钟响应' }
      ],
      hot: [
        { pic:'📺', tag:'热销 TOP1', title:'家电维修 · 30分钟', meta:'空调/冰箱/洗衣机', rate:'4.6 · 已订 2.3万', price:'¥89', unit:'/次起', orig:'¥200', sub:'家电维修' },
        { pic:'🚽', tag:'极速', tagAlt:true, title:'管道疏通 · 当天通', meta:'30分钟上门 · 不通不收费', rate:'4.7 · 已订 5.6万', price:'¥99', unit:'/次起', orig:'¥220', sub:'管道疏通' },
        { pic:'❄️', tag:'', title:'空调清洗 · 挂机', meta:'高温蒸汽 · 拆装深度', rate:'4.8 · 已订 3.1万', price:'¥89', unit:'/台起', orig:'¥180', sub:'空调维修' },
        { pic:'💡', tag:'', title:'灯具电路检修', meta:'跳闸/短路/灯具安装', rate:'4.5 · 已订 1.2万', price:'¥69', unit:'/次起', orig:'¥150', sub:'灯具电路' }
      ],
      ctaHint: '今日 86 位业主已呼叫维修',
      ctaPri: '立即呼叫师傅'
    },
    moving: {
      cls: 'moving', name: '搬家', ek: 'MOVING · 白名单商家',
      slogan: '正规车队 · 损坏全赔',
      sub: '沈阳同城 / 跨省长途 / 钢琴搬运',
      live: '本月已完成 <b>2,316</b> 次搬运',
      badges: ['🚚 正规车队', '💰 损坏全赔', '📋 合同保障'],
      strip: ['<b>正规</b>车队', '<b>5万</b>损坏赔付', '<b>合同</b>保障', '<b>迟到</b>全免'],
      subs: [
        { icon:'🏠', name:'居民搬家', price:'¥299/车起', sub:'居民搬家' },
        { icon:'🛣', name:'长途搬家', price:'¥2.5/公里起', sub:'长途搬家' },
        { icon:'🎹', name:'钢琴搬运', price:'¥499/台起', sub:'钢琴搬运' },
        { icon:'🎌', name:'日式搬家', price:'¥888/次起', sub:'日式搬家' }
      ],
      trust: [
        { ic:'🚚', nm:'正规车队', sub:'工商注册' },
        { ic:'💰', nm:'损坏全赔', sub:'最高5万/车' },
        { ic:'📋', nm:'合同保障', sub:'白纸黑字' },
        { ic:'⏰', nm:'准时到达', sub:'迟到全免' }
      ],
      hot: [
        { pic:'🏠', tag:'热销 TOP1', title:'居民搬家 · 同城', meta:'4.2米厢车 · 2人搬运', rate:'4.7 · 已订 5.6千', price:'¥299', unit:'/车起', orig:'¥580', sub:'居民搬家' },
        { pic:'🛣', tag:'', title:'跨省长途搬家', meta:'全国直达 · 上门提货', rate:'4.5 · 已订 1.2千', price:'¥2.5', unit:'/公里起', orig:'', sub:'长途搬家' },
        { pic:'🎹', tag:'专业', tagAlt:true, title:'钢琴专业搬运', meta:'立式/三角钢琴 · 专业团队', rate:'4.9 · 已订 380', price:'¥499', unit:'/台起', orig:'¥800', sub:'钢琴搬运' },
        { pic:'🎌', tag:'', title:'日式精细搬家', meta:'打包+搬运+还原 · 全包', rate:'4.8 · 已订 260', price:'¥888', unit:'/次起', orig:'¥1500', sub:'日式搬家' }
      ],
      ctaHint: '本月已完成 2,316 次搬运',
      ctaPri: '免费上门估价'
    },
    nanny: {
      cls: 'nanny', name: '保姆', ek: 'NANNY · 白名单商家',
      slogan: '持证月嫂 · 1 对 1 服务',
      sub: '住家 / 不住家 / 26 天 / 42 天',
      live: '本月已签约 <b>168</b> 位月嫂',
      badges: ['🎓 持证上岗', '👩‍⚕ 医护背景', '🔁 不满意换人'],
      strip: ['<b>100%</b>背调', '<b>医护</b>背景', '<b>7天</b>换人', '<b>百万</b>保险'],
      subs: [
        { icon:'🏠', name:'住家育儿嫂', price:'¥6800/月起', sub:'住家育儿嫂' },
        { icon:'🤱', name:'月嫂 26天', price:'¥12800/期起', sub:'月嫂26天' },
        { icon:'👶', name:'月嫂 42天', price:'¥19800/期起', sub:'月嫂42天' },
        { icon:'☀️', name:'不住家月嫂', price:'¥8800/月起', sub:'不住家月嫂' },
        { icon:'⏰', name:'钟点工', price:'¥45/小时起', sub:'钟点工' },
        { icon:'👵', name:'老人陪护', price:'¥5500/月起', sub:'老人陪护' }
      ],
      trust: [
        { ic:'🎓', nm:'持证月嫂', sub:'高级育婴师' },
        { ic:'🏥', nm:'医护背景', sub:'三甲经验' },
        { ic:'🔁', nm:'不满意换人', sub:'7天内免费' },
        { ic:'💎', nm:'百万保险', sub:'中国人保' }
      ],
      hot: [
        { pic:'🤱', tag:'热销 TOP1', title:'金牌月嫂 26天', meta:'8年以上经验 · 医护背景', rate:'4.9 · 已订 580', price:'¥12.8K', unit:'/期', orig:'¥18K', sub:'月嫂26天' },
        { pic:'🏠', tag:'', title:'住家育儿嫂', meta:'0-3岁 · 辅食/早教', rate:'4.7 · 已订 1.2千', price:'¥6.8K', unit:'/月起', orig:'¥9K', sub:'住家育儿嫂' },
        { pic:'👶', tag:'尊享', tagAlt:true, title:'尊享月嫂 42天', meta:'医护双证 · 催乳师', rate:'5.0 · 已订 360', price:'¥19.8K', unit:'/期', orig:'¥28K', sub:'月嫂42天' },
        { pic:'⏰', tag:'', title:'育儿嫂钟点工', meta:'4小时/天 · 接送+做饭', rate:'4.6 · 已订 2.1千', price:'¥45', unit:'/小时起', orig:'¥80', sub:'钟点工' }
      ],
      ctaHint: '本月已签约 168 位月嫂',
      ctaPri: '免费匹配月嫂'
    }
  };

  function listUrl(type, sub){
    return 'juzhu-jiazheng-list.html?type='+encodeURIComponent(type)+(sub ? '&sub='+encodeURIComponent(sub) : '');
  }

  function render(){
    var type = document.body.dataset.type;
    var p = PAGES[type];
    if (!p) return;

    document.title = p.name + ' · 家政服务 · 贝壳';

    var html =
      '<div class="appbar ghost" style="position:absolute;z-index:10;">'+
        '<a class="bk" href="juzhu-channel-v3-grid.html">‹</a>'+
        '<div class="ttl">'+p.name+'<small>家政 · 沈阳</small></div>'+
        '<div class="act"><span>🔍</span></div>'+
      '</div>'+

      '<div class="jzl-hero '+p.cls+'">'+
        '<div class="bg"></div>'+
        '<div class="in">'+
          '<div class="ek">'+p.ek+'</div>'+
          '<h1>'+p.slogan+'</h1>'+
          '<p>'+p.sub+'</p>'+
          '<div class="loc">沈阳 · 东博专区 <a href="javascript:;">更换地址</a></div>'+
          '<div class="badges">'+p.badges.map(function(b){ return '<span>'+b+'</span>'; }).join('')+'</div>'+
        '</div>'+
      '</div>'+

      '<div class="jzl-strip">'+p.strip.map(function(s){ return '<span>'+s+'</span>'; }).join('')+'</div>'+

      '<div class="sec-h" style="margin-top:8px;"><span class="bar"></span><h2>选择子类</h2>'+
        '<span class="more">'+p.subs.length+' 项 ›</span></div>'+
      '<div class="jzl-sub-grid '+p.cls+'">'+
        p.subs.map(function(s,i){
          return '<a href="'+listUrl(type, s.sub)+'">'+
            '<div class="ic">'+s.icon+'</div>'+
            '<div class="nm">'+s.name+'</div>'+
            '<div class="pr">'+s.price+'</div></a>';
        }).join('')+
      '</div>'+

      '<div class="sec-h"><span class="bar"></span><h2>服务保障</h2></div>'+
      '<div class="jzl-trust">'+
        p.trust.map(function(t){
          return '<div class="it"><div class="ic">'+t.ic+'</div><span class="nm">'+t.nm+'</span><span class="sub">'+t.sub+'</span></div>';
        }).join('')+
      '</div>'+

      '<div class="sec-h"><span class="bar"></span><h2>近期热销</h2>'+
        '<a class="more" href="'+listUrl(type)+'">查看全部 ›</a></div>'+
      '<div class="jzl-hot-scroll">'+
        p.hot.map(function(h){
          var tag = h.tag ? '<span class="tag'+(h.tagAlt?' alt':'')+'">'+h.tag+'</span>' : '';
          var orig = h.orig ? '<s>'+h.orig+'</s>' : '';
          return '<a class="jzl-hot-card '+p.cls+'" href="'+listUrl(type, h.sub)+'">'+
            '<div class="top"><div class="pic">'+h.pic+'</div>'+tag+'</div>'+
            '<b>'+h.title+'</b>'+
            '<div class="meta">'+h.meta+'</div>'+
            '<div class="rate"><em>★</em> '+h.rate+'</div>'+
            '<div class="foot"><div class="pr">'+h.price+orig+'<small style="font-size:10px;font-family:var(--font);color:var(--muted)">'+h.unit+'</small></div>'+
            '<span class="go">预订</span></div></a>';
        }).join('')+
      '</div>'+

      '<div class="banner" style="margin:8px 18px 16px;">'+
        '<span class="bi">🛡</span>'+
        '<div class="bt"><b>平台保障 · 白名单商家</b><p>'+p.live.replace(/<\/?b>/g,'')+' · 中台背调 · 持证上岗</p></div>'+
      '</div>';

    document.getElementById('jzlScr').innerHTML = html;

    document.getElementById('jzlFoot').innerHTML =
      '<div style="position:relative;flex:1;display:flex;gap:10px;width:100%;">'+
        '<div class="hint">'+p.ctaHint+'</div>'+
        '<a class="sec" href="javascript:;">💬 客服</a>'+
        '<a class="pri" href="'+listUrl(type)+'">'+p.ctaPri+'</a>'+
      '</div>';
  }

  render();
})();
