import type { CapacitorConfig } from "@capacitor/cli";

/** 远程站点：WebView 直接加载线上旅居首页 */
const REMOTE_URL =
  process.env.CAP_SERVER_URL || "https://xjz.ke.com/lvju-app-home-demo.html";

/**
 * Capacitor 壳配置。
 * - 默认 server.url 指向旅居 App 首页 demo
 * - 本地调试：CAP_SERVER_URL=http://10.0.2.2:8080/... npm run cap:sync
 * - 离线壳：注释 server.url，改用 www/ 本地静态资源
 */
const config: CapacitorConfig = {
  appId: "com.beike.lvju",
  appName: "贝壳旅居",
  webDir: "www",
  server: {
    url: REMOTE_URL,
    cleartext: REMOTE_URL.startsWith("http://"),
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#2563eb",
      showSpinner: false,
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#2563eb",
    },
  },
};

export default config;
