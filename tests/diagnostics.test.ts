import assert from 'node:assert/strict';
import test from 'node:test';

import { redactText } from '../src/diagnostics/redact.ts';
import {
  classifyFailureMessage,
  summarizeFailures,
} from '../src/diagnostics/error-summary.ts';
import { buildReportText } from '../src/diagnostics/report.ts';
import { DiagnosticsService } from '../src/diagnostics/diagnostics-center.ts';
import type { DiagnosticsDeps } from '../src/diagnostics/diagnostics-center.ts';
import type { DiagnosticsOverview } from '../src/diagnostics/types.ts';
import type { ConfigManager } from '../src/config/manager.ts';
import type { LXServerClient } from '../src/lxserver/client.ts';
import type { MIoTBridge } from '../src/bridge/miot.ts';
import type { PlayerController } from '../src/player/controller.ts';

(globalThis as Record<string, unknown>).songloft = {
  log: { info() {}, warn() {}, error() {} },
};

// ===== 脱敏 =====

test('redactText removes urls, ip addresses, absolute paths and secrets', () => {
  assert.equal(redactText('http://192.0.2.10:58091/audio.mp3'), '[url]');
  assert.equal(redactText('请求来自 192.0.2.10'), '请求来自 [ip]');
  assert.equal(redactText('token=abc123'), 'token=[redacted]');
  assert.equal(redactText('authorization: Bearer xyz'), 'authorization:[redacted]');
  assert.equal(redactText('Bearer abc.def.ghi'), '[redacted]');
  assert.equal(redactText('password=supersecret'), 'password=[redacted]');
  assert.equal(redactText('C:\\Users\\foo\\bar\\config.json'), '[path]');
  assert.equal(redactText('C:\\Users\\Foo Bar\\config.json'), '[path]');
  assert.equal(redactText('连接 lx.local:9527 失败'), '连接 [host] 失败');
  assert.equal(redactText('账号 user@example.com'), '账号 [account]');
  assert.equal(redactText('地址 fd00:1:2:3:4:5:6:7'), '地址 [ip]');
});

test('redactText keeps ordinary safe text unchanged', () => {
  assert.equal(redactText('连接成功'), '连接成功');
  assert.equal(redactText('已配置'), '已配置');
});

// ===== 错误分类 =====

test('classifyFailureMessage matches conservative categories', () => {
  assert.equal(classifyFailureMessage('block ip'), 'platform_block');
  assert.equal(classifyFailureMessage('token 无效'), 'auth_config');
  assert.equal(classifyFailureMessage('lxserver 地址未配置'), 'auth_config');
  assert.equal(classifyFailureMessage('invalid url returned'), 'invalid_url');
  assert.equal(classifyFailureMessage('请求超时'), 'timeout');
  assert.equal(classifyFailureMessage('网络错误'), 'network');
  assert.equal(classifyFailureMessage('未找到可播放的歌曲版本'), 'no_result');
  assert.equal(classifyFailureMessage('一些随机内容'), 'unknown');
  assert.equal(classifyFailureMessage(''), 'unknown');
});

test('classifyFailureMessage handles real failure texts from client.ts', () => {
  assert.equal(classifyFailureMessage('LXServer 登录失败: HTTP 401'), 'auth_config');
  assert.equal(classifyFailureMessage('LXServer 登录失败: 用户名或密码错误'), 'auth_config');
  assert.equal(classifyFailureMessage('Token验证失败: HTTP 401'), 'auth_config');
  assert.equal(classifyFailureMessage('Token验证失败: 响应格式无效'), 'auth_config');
  assert.equal(classifyFailureMessage('Token验证失败: LXServer 未确认登录有效'), 'auth_config');
  assert.equal(classifyFailureMessage('连接失败: fetch failed'), 'network');
  assert.equal(classifyFailureMessage('连接失败: getaddrinfo ENOTFOUND lx.local'), 'network');
  assert.equal(classifyFailureMessage('连接失败: 网络错误'), 'network');
  assert.equal(classifyFailureMessage('DNS解析失败'), 'network');
  assert.equal(classifyFailureMessage('全局block ip冷却'), 'platform_block');
  assert.equal(classifyFailureMessage('候选均不可用'), 'no_result');
  assert.equal(classifyFailureMessage('10秒预算耗尽'), 'unknown');
  assert.equal(classifyFailureMessage('8次URL解析预算耗尽'), 'unknown');
});

test('summarizeFailures counts only non-empty messages', () => {
  const summary = summarizeFailures(['block ip', 'block ip', '请求超时', '']);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byCategory, [
    { category: 'platform_block', count: 2 },
    { category: 'timeout', count: 1 },
  ]);
});

// ===== 报告生成 =====

function sampleOverview(): DiagnosticsOverview {
  return {
    version: '2.5.2',
    generatedAt: 1785600000000,
    health: {
      overall: 'warn',
      checks: [
        { id: 'lxserver_config', label: 'lxserver 配置', level: 'ok', detail: '已配置' },
        { id: 'lxserver_connection', label: 'lxserver 连接', level: 'ok', detail: '连接成功' },
        { id: 'lx_token', label: '登录令牌', level: 'ok', detail: '有效' },
        { id: 'custom_sources', label: '自定义源', level: 'ok', detail: '2 个（启用 1）' },
        { id: 'miot', label: 'MIoT 插件', level: 'ok', detail: '已安装（v2026.7.13），已配置' },
      ],
    },
    plugin: { status: 'running', version: '2.5.2' },
    lxserver: {
      configured: true,
      hostSet: true,
      usernameSet: true,
      passwordSet: true,
      webPlayerConfigured: false,
      defaultQuality: '320k',
      sourcePriority: ['kg', 'tx', 'wy'],
      searchTimeout: 3,
      enableCustomSources: true,
      enableFuzzyMatch: true,
      allowQualityDowngrade: true,
      tokenValid: true,
      connected: true,
      connectMessage: '连接成功',
    },
    customSources: { total: 2, enabled: 1, names: ['srcA'] },
    miot: {
      installed: true,
      configured: true,
      version: '2026.7.13',
      deviceCount: 2,
      onlineDeviceCount: 1,
      selectedDeviceName: '客厅音箱',
    },
    platformCooldowns: {
      global: false,
      globalRemainingSeconds: 0,
      active: [{ platform: 'kg', remainingSeconds: 812 }],
    },
    cache: {
      historyCount: 12,
      fallbackLogCount: 3,
      blacklistCount: 2,
      customSourceStatCount: 1,
    },
    recent: {
      fallback: [
        {
          time: 1785600000000,
          finalSource: 'kg',
          finalQuality: '320k',
          reason: '搜索: 内置平台(kg,tx) → ✓ 成功: kg/320k',
        },
      ],
      voice: { total: 5, failures: 2 },
      playback: { total: 3, bySource: { 'miot-voice': 2, 'web-ui': 1 } },
    },
    errorSummary: {
      total: 2,
      byCategory: [
        { category: 'no_result', count: 1 },
        { category: 'platform_block', count: 1 },
      ],
    },
  };
}

test('buildReportText contains all required sections', () => {
  const report = buildReportText(sampleOverview());
  assert.ok(report.indexOf('系统诊断报告') !== -1);
  assert.ok(report.indexOf('插件版本: v2.5.2') !== -1);
  assert.ok(report.indexOf('1. 健康检查结果') !== -1);
  assert.ok(report.indexOf('2. 平台冷却概况') !== -1);
  assert.ok(report.indexOf('3. 最近降级 / 播放摘要') !== -1);
  assert.ok(report.indexOf('4. 错误分类') !== -1);
  assert.ok(report.indexOf('5. 缓存概况') !== -1);
  assert.ok(report.indexOf('kg: 剩余 812 秒') !== -1);
  assert.ok(report.indexOf('no_result') === -1, '原始分类 key 不应直接出现在报告');
});

test('buildReportText never leaks sensitive fields', () => {
  const report = buildReportText(sampleOverview());
  assert.ok(report.indexOf('客厅音箱') === -1, '设备名称不应出现');
  assert.ok(report.indexOf('http://') === -1, 'URL 不应出现');
  assert.ok(report.indexOf('192.168') === -1, '内网地址不应出现');
  assert.ok(/password/i.test(report) === false, 'password 不应出现');
  assert.ok(report.indexOf('周杰伦') === -1, '歌曲名不应出现');
  assert.ok(report.indexOf('C:') === -1 && report.indexOf('/Users/') === -1, '绝对路径不应出现');
});

// ===== 诊断服务（依赖注入）=====

function createFakeDeps(): DiagnosticsDeps {
  const configManager = {
    getConfig: async () => ({
      host: 'http://lx.local:9527',
      username: 'user',
      password: 'secret-pass',
      webPlayerUrl: '',
      defaultQuality: '320k',
      sourcePriority: ['kg', 'tx', 'wy'],
      searchTimeout: 3,
      enableCustomSources: true,
      enableFuzzyMatch: true,
      allowQualityDowngrade: true,
    }),
    getLXToken: async () => ({ token: 'cached-token', expiry: Date.now() + 600000 }),
    getPlayHistory: async (limit: number) =>
      Array.from({ length: 12 }, (_, i) => ({
        songId: 's' + i,
        title: '歌' + i,
        artist: '艺' + i,
        source: 'kg',
        quality: '320k',
        playedAt: '',
      })).slice(0, limit),
    getFallbackLogs: async () => [
      {
        query: '一些歌',
        finalSource: 'kg',
        finalQuality: '320k',
        downgradeReason: '歌曲周杰伦请求 lx.local:9527 超时',
        timestamp: new Date().toISOString(),
      },
    ],
    getQualityBlacklist: async () => ({ a: { urlHash: 'x' }, b: { urlHash: 'y' } }),
    getCustomSourceStats: async () => ({ 'src:kg': { successCount: 2, failCount: 1 } }),
    getPlatformCooldowns: async () => ({
      kg: { blockedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 },
    }),
  } as unknown as ConfigManager;

  const lxClient = {
    getCustomSources: async () => [
      { name: 'srcA', enabled: true },
      { name: 'srcB', enabled: false },
    ],
    testConnection: async () => ({ success: true, message: '连接成功' }),
  } as unknown as LXServerClient;

  const miotBridge = {
    checkMIoTInstalled: async () => ({ installed: true, version: '2026.7.13', configured: true }),
    getDevices: async () => [
      { account_id: 'a1', device_id: 'd1', device_name: '客厅音箱', model: 'm1', alias: '', online: true },
      { account_id: 'a1', device_id: 'd2', device_name: '卧室音箱', model: 'm2', alias: '', online: false },
    ],
  } as unknown as MIoTBridge;

  const playerController = {
    getCurrentDevice: () => ({
      account_id: 'a1',
      device_id: 'd1',
      device_name: '客厅音箱',
      model: 'm1',
      alias: '',
      online: true,
    }),
  } as unknown as PlayerController;

  return {
    version: '2.5.2',
    configManager,
    lxClient,
    miotBridge,
    playerController,
    getVoiceLogs: () => [
      { time: Date.now(), type: 'voice', action: '语音搜索', detail: '想听周杰伦', result: null },
      { time: Date.now(), type: 'voice', action: '搜索结果', detail: '未找到可播放的歌曲版本', result: 'fail' },
    ],
    getPlaybackTracker: () => [
      {
        time: Date.now(),
        keyword: 'xxx',
        source: 'miot-voice',
        songTitle: '歌曲甲',
        songArtist: '歌手甲',
        songUrl: 'http://x/y.mp3',
        urlPrefix: 'http://x',
        platform: 'kg',
      },
    ],
  };
}

test('DiagnosticsService.gatherOverview computes expected snapshot', async () => {
  const service = new DiagnosticsService(createFakeDeps());
  const overview = await service.gatherOverview();

  assert.equal(overview.version, '2.5.2');
  assert.equal(overview.lxserver.configured, true);
  assert.equal(overview.lxserver.connected, true);
  assert.equal(overview.lxserver.tokenValid, true);
  assert.equal(overview.customSources.total, 2);
  assert.equal(overview.customSources.enabled, 1);
  assert.equal(overview.miot.installed, true);
  assert.equal(overview.miot.deviceCount, 2);
  assert.equal(overview.miot.onlineDeviceCount, 1);
  assert.equal(overview.cache.historyCount, 12);
  assert.equal(overview.cache.blacklistCount, 2);
  assert.equal(overview.recent.fallback.length, 1);
  assert.equal(overview.recent.fallback[0].reason, '请求超时');
  assert.equal(overview.recent.voice.total, 2);
  assert.equal(overview.recent.voice.failures, 1);
  assert.equal(overview.recent.playback.total, 1);
  assert.equal(overview.recent.playback.bySource['miot-voice'], 1);
  assert.equal(overview.errorSummary.total, 1);
  assert.equal(overview.errorSummary.byCategory[0].category, 'no_result');
  assert.equal(overview.platformCooldowns.active.length, 1);
  assert.equal(overview.platformCooldowns.active[0].platform, 'kg');
  assert.ok(overview.platformCooldowns.active[0].remainingSeconds > 0);
});

test('DiagnosticsService.buildReport is sanitized and complete', async () => {
  const service = new DiagnosticsService(createFakeDeps());
  const report = await service.buildReport();

  assert.ok(report.indexOf('LX音乐桥 系统诊断报告') !== -1);
  assert.ok(report.indexOf('v2.5.2') !== -1);
  assert.ok(report.indexOf('192.168') === -1);
  assert.ok(report.indexOf('http://') === -1);
  assert.ok(report.indexOf('secret-pass') === -1);
  assert.ok(report.indexOf('cached-token') === -1);
  assert.ok(report.indexOf('客厅音箱') === -1);
  assert.ok(report.indexOf('周杰伦') === -1);
  assert.ok(report.indexOf('d1') === -1, '设备 ID 不应出现');
  assert.ok(report.indexOf('lx.local') === -1, '内网主机不应出现');
  assert.ok(report.indexOf('歌曲周杰伦') === -1, '原始降级文本不应出现');
});

test('DiagnosticsService tolerates a failing lxserver probe', async () => {
  const deps = createFakeDeps();
  (deps.lxClient as unknown as { testConnection: () => Promise<{ success: boolean; message: string }> }).testConnection =
    async () => ({ success: false, message: 'Token验证失败: HTTP 401 from lx.local:9527 user=user@example.com' });
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(overview.lxserver.connected, false);
  assert.equal(overview.lxserver.connectMessage, '连接失败（认证或配置错误）');
  assert.ok(overview.health.checks.every(check => check.detail.indexOf('lx.local') === -1));
  assert.ok(overview.health.overall === 'error' || overview.health.overall === 'warn');
});

test('DiagnosticsService handles unconfigured lxserver without probing', async () => {
  const deps = createFakeDeps();
  (deps.configManager as unknown as { getConfig: () => Promise<Record<string, unknown>> }).getConfig =
    async () => ({ host: '', username: '', password: '' });
  let probed = false;
  (deps.lxClient as unknown as { testConnection: () => Promise<{ success: boolean; message: string }> }).testConnection =
    async () => { probed = true; return { success: true, message: '连接成功' }; };
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(probed, false, '未配置时应跳过连接探测');
  assert.equal(overview.lxserver.configured, false);
  assert.equal(overview.lxserver.connected, null);
  assert.equal(overview.lxserver.connectMessage, '等待配置 lxserver');
  assert.equal(overview.lxserver.hostSet, false);
  assert.equal(overview.lxserver.usernameSet, false);
  assert.ok(overview.health.checks.some(check => check.id === 'lxserver_config' && check.level === 'warn'));
});

test('DiagnosticsService handles MIoT not installed', async () => {
  const deps = createFakeDeps();
  (deps.miotBridge as unknown as { checkMIoTInstalled: () => Promise<{ installed: boolean; configured: boolean }> }).checkMIoTInstalled =
    async () => ({ installed: false, configured: false });
  (deps.miotBridge as unknown as { getDevices: () => Promise<unknown[]> }).getDevices = async () => [];
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(overview.miot.installed, false);
  assert.equal(overview.miot.version, '');
  assert.equal(overview.miot.deviceCount, 0);
  const miotCheck = overview.health.checks.find(check => check.id === 'miot');
  assert.ok(miotCheck && miotCheck.level === 'error');
  assert.equal(miotCheck.detail, '未安装');
});

test('DiagnosticsService tolerates empty logs and empty cooldowns', async () => {
  const deps = createFakeDeps();
  (deps as unknown as { getVoiceLogs: () => unknown[] }).getVoiceLogs = () => [];
  (deps as unknown as { getPlaybackTracker: () => unknown[] }).getPlaybackTracker = () => [];
  (deps.configManager as unknown as { getFallbackLogs: () => Promise<unknown[]> }).getFallbackLogs = async () => [];
  (deps.configManager as unknown as { getPlatformCooldowns: () => Promise<Record<string, unknown>> }).getPlatformCooldowns =
    async () => ({});
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(overview.recent.fallback.length, 0);
  assert.equal(overview.recent.voice.total, 0);
  assert.equal(overview.recent.voice.failures, 0);
  assert.equal(overview.recent.playback.total, 0);
  assert.deepEqual(overview.recent.playback.bySource, {});
  assert.equal(overview.platformCooldowns.global, false);
  assert.equal(overview.platformCooldowns.active.length, 0);
  assert.equal(overview.errorSummary.total, 0);
});

test('DiagnosticsService reports global cooldown separately and skips it in active list', async () => {
  const deps = createFakeDeps();
  (deps.configManager as unknown as { getPlatformCooldowns: () => Promise<Record<string, unknown>> }).getPlatformCooldowns =
    async () => ({
      __global__: { blockedAt: Date.now() - 1000, expiresAt: Date.now() + 120000 },
      kg: { blockedAt: Date.now() - 1000, expiresAt: Date.now() - 100 },
    });
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(overview.platformCooldowns.global, true);
  assert.ok(overview.platformCooldowns.globalRemainingSeconds > 0);
  assert.equal(overview.platformCooldowns.active.length, 0, '过期的平台冷却不应计入活动列表');
  const report = await service.buildReport();
  assert.ok(report.indexOf('全局冷却: 是') !== -1);
});

test('DiagnosticsService tolerates throwing dependency methods', async () => {
  const deps = createFakeDeps();
  (deps.lxClient as unknown as { getCustomSources: () => Promise<unknown[]> }).getCustomSources =
    async () => { throw new Error('custom sources boom'); };
  (deps.miotBridge as unknown as { getDevices: () => Promise<unknown[]> }).getDevices =
    async () => { throw new Error('device boom'); };
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.equal(overview.lxserver.configured, true);
  assert.equal(overview.miot.deviceCount, 0);
  const customCheck = overview.health.checks.find(check => check.id === 'custom_sources');
  assert.ok(customCheck && customCheck.detail.indexOf('读取失败') !== -1);
  assert.equal(overview.health.overall, 'error');
});

test('DiagnosticsService classifies downgrade reason containing a song name as a generic label', async () => {
  const deps = createFakeDeps();
  (deps.configManager as unknown as { getFallbackLogs: () => Promise<unknown[]> }).getFallbackLogs =
    async () => [{
      query: '求一首歌',
      finalSource: 'tx',
      finalQuality: '128k',
      downgradeReason: '⚠ 片段: 稻香 - 周杰伦 (实际3s vs 标注4:30, 120KB)',
      timestamp: new Date().toISOString(),
    }];
  const service = new DiagnosticsService(deps);
  const overview = await service.gatherOverview();
  assert.ok(overview.recent.fallback[0].reason.length > 0);
  assert.ok(overview.recent.fallback[0].reason.indexOf('稻香') === -1, '歌名不应出现在 reason');
  assert.ok(overview.recent.fallback[0].reason.indexOf('周杰伦') === -1, '歌手名不应出现在 reason');
  const report = await service.buildReport();
  assert.ok(report.indexOf('稻香') === -1);
  assert.ok(report.indexOf('周杰伦') === -1);
});
