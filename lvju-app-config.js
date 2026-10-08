/* 旅居 C 端全局功能开关。只控制展示，不改变评级、保险等业务数据。 */
(function (w, d) {
  'use strict';

  var flags = {
    caibei: false,
    stayProtection: false
  };

  w.LVJU_FEATURES = Object.freeze(flags);
  w.lvjuFeatureEnabled = function (name) { return flags[name] === true; };

  var style = d.createElement('style');
  style.id = 'lvju-feature-flags';
  style.textContent = Object.keys(flags).map(function (name) {
    return flags[name] === true
      ? '[data-lvju-feature-off~="' + name + '"]{display:none!important;}'
      : '[data-lvju-feature~="' + name + '"]{display:none!important;}';
  }).join('');
  d.head.appendChild(style);
})(window, document);
