/** 对齐根目录 lvju-app-config.js：只控制展示，不改业务数据。 */
const DEFAULTS = Object.freeze({
  caibei: false,
  stayProtection: false,
});

export function featureEnabled(name) {
  if (typeof window !== 'undefined' && typeof window.lvjuFeatureEnabled === 'function') {
    return window.lvjuFeatureEnabled(name) === true;
  }
  return DEFAULTS[name] === true;
}

export function features() {
  if (typeof window !== 'undefined' && window.LVJU_FEATURES) {
    return window.LVJU_FEATURES;
  }
  return DEFAULTS;
}
