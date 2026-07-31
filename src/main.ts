// Songloft-LX 插件 — 主入口
// LX音乐桥接：连接lxserver与MIoT插件，实现小爱音响零成本语音点歌

/// <reference types="@songloft/plugin-sdk" />

import { createRouter } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';

import { ConfigManager } from './config/manager';
import { LXServerClient } from './lxserver/client';
import { MIoTBridge } from './bridge/miot';
import { SearchAdapter } from './bridge/search';
import { PlayerController } from './player/controller';
import { registerHandlers } from './handlers/routes';
import { INDEX_HTML } from './html_content';

// ── 创建路由 ──
const router = createRouter();

// ── 插件 token（注入到 HTML 中，供前端 API 调用认证）──
let pluginToken: string = '';

// ── 首页路由（注入 token 到 HTML）──
function serveHome(): HTTPResponse {
  // 在 </body> 前注入 token
  const html = INDEX_HTML.replace(
    '</body>',
    '<script>window.__PLUGIN_TOKEN__ = ' + JSON.stringify(pluginToken) + ';</script>\n</body>'
  );
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
}
router.get('/', () => serveHome());
router.get('/index.html', () => serveHome());

// ── 全局服务实例与业务路由 ──
// 构造函数均无异步副作用，因此在模块加载阶段先完成路由注册。
// 即使 onInit 后续恢复外部状态失败，后台配置与诊断接口仍然可用。
const configManager = new ConfigManager();
const lxClient = new LXServerClient(configManager);
const miotBridge = new MIoTBridge();
const searchAdapter = new SearchAdapter(lxClient, configManager, miotBridge);
const playerController = new PlayerController(miotBridge, configManager);
registerHandlers(router, configManager, lxClient, miotBridge, searchAdapter, playerController);

// ── 插件初始化 ──
async function onInit(): Promise<void> {
  songloft.log.info('========================================');
  songloft.log.info('  Songloft-LX 插件启动中...');
  songloft.log.info('  版本: 2.5.1');
  songloft.log.info('========================================');

  songloft.log.info('[Init] HTTP routes registered before async initialization');

  try {
    await lxClient.init();
    songloft.log.info('[Init] LXServer client state restored');
  } catch (e: any) {
    songloft.log.warn('[Init] LXServer client initialization failed: ' + String(e));
  }

  try {
    await playerController.init();
    songloft.log.info('[Init] Player state restored');
  } catch (e: any) {
    songloft.log.warn('[Init] Player initialization failed: ' + String(e));
  }

  try {
    pluginToken = await songloft.plugin.getToken();
    songloft.log.info('[Init] Plugin token obtained');
  } catch (e: any) {
    songloft.log.warn('[Init] Failed to get plugin token: ' + String(e));
  }

  // 纯增强注册：让新版 MIoT 配置页识别 LX音乐桥，不阻塞插件启动。
  miotBridge.registerSearchProvider();

  // 异步任务：检测 MIoT 插件（不阻塞路由）
  miotBridge.checkMIoTInstalled().then(miotStatus => {
    if (!miotStatus.installed) {
      songloft.log.warn('[Init] ⚠ MIoT 插件未安装！插件需要MIoT才能控制音箱');
      songloft.log.warn('[Init] 请前往 Songloft 插件市场安装"智能音箱"插件');
    } else {
      songloft.log.info(
        '[Init] ✅ MIoT 插件已安装 (v' + miotStatus.version + ')' +
        (miotStatus.configured ? ' 已配置' : ' 未配置')
      );
    }
  }).catch(e => {
    songloft.log.warn('[Init] MIoT检测失败: ' + String(e));
  });

  // 异步任务：尝试自动登录 lxserver（不阻塞）
  configManager.getConfig().then(config => {
    if (config.host && config.username && config.password) {
      lxClient.login().then(() => {
        songloft.log.info('[Init] ✅ LXServer 已连接: ' + config.host);

        // 自动配置 MIoT 搜索端点（登录成功后）
        return miotBridge.configureSearchEndpoint();
      }).then(configured => {
        if (configured) {
          songloft.log.info('[Init] ✅ MIoT 搜索端点已自动配置');
        }
      }).catch(e => {
        songloft.log.warn('[Init] ⚠ LXServer 自动连接/配置失败: ' + String(e));
      });
    } else {
      songloft.log.info('[Init] ℹ️ LXServer 未配置，等待用户在Web UI中配置');
    }
  }).catch(e => {
    songloft.log.warn('[Init] LXServer config load failed: ' + String(e));
  });

  songloft.log.info('========================================');
  songloft.log.info('  Songloft-LX 插件启动完成 🎵');
  songloft.log.info('========================================');
}

// ── 插件卸载 ──
async function onDeinit(): Promise<void> {
  songloft.log.info('[Deinit] Songloft-LX 插件停止...');
  try {
    await miotBridge.unregisterSearchProvider();
  } catch {
    // 静默清理
  }
  // 清理缓存 token
  try {
    await configManager.clearLXToken();
  } catch {
    // 静默清理
  }
  songloft.log.info('[Deinit] 插件已停止');
}

// ── HTTP 请求处理 ──
async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  try {
    return await router.handle(req);
  } catch (e: any) {
    songloft.log.error('[HTTP] 请求处理错误: ' + String(e));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ success: false, error: '内部错误: ' + e.message }),
    };
  }
}

// ── 导出全局函数（QuickJS 需要显式声明）──
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
