// Songloft-LX 插件 — 诊断中心服务
// 汇总插件、lxserver、自定义源、MIoT、平台冷却与缓存状态，并生成脱敏诊断报告。
// 默认只访问状态或配置接口，不搜索歌曲、不解析音频 URL、不播放、不控制音箱。
/// <reference types="@songloft/plugin-sdk" />

import type { ConfigManager } from '../config/manager';
import type { LXServerClient } from '../lxserver/client';
import type { MIoTBridge } from '../bridge/miot';
import type { PlayerController } from '../player/controller';
import type { DiagnosticsOverview, HealthCheckItem, HealthLevel } from './types.ts';
import { classifyFailureMessage, getErrorCategoryLabel, summarizeFailures } from './error-summary.ts';
import { redactText } from './redact.ts';
import { buildReportText } from './report.ts';

export interface VoiceLogEntry {
  time: number;
  type: string;
  action: string;
  detail: string;
  result: string | null;
  extra?: any;
}

export interface PlaybackTrackEntry {
  time: number;
  keyword: string;
  source: string;
  songTitle: string;
  songArtist: string;
  songUrl: string;
  urlPrefix: string;
  platform: string;
}

export interface DiagnosticsDeps {
  version: string;
  configManager: ConfigManager;
  lxClient: LXServerClient;
  miotBridge: MIoTBridge;
  playerController: PlayerController;
  getVoiceLogs: () => VoiceLogEntry[];
  getPlaybackTracker: () => PlaybackTrackEntry[];
}

const LX_PROBE_TTL_MS = 15000;

interface LXProbeResult {
  connected: boolean;
  message: string;
}

export class DiagnosticsService {
  private deps: DiagnosticsDeps;
  private lxProbeCache: { at: number; result: LXProbeResult } | null = null;

  constructor(deps: DiagnosticsDeps) {
    this.deps = deps;
  }

  async gatherOverview(): Promise<DiagnosticsOverview> {
    const generatedAt = Date.now();
    const { configManager, lxClient, miotBridge, playerController } = this.deps;
    const checks: HealthCheckItem[] = [];

    // ── lxserver 配置 ──
    let config: any = {};
    try {
      config = await configManager.getConfig();
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] config read failed: ' + String(e));
    }
    const configured = !!(config.host && config.username);
    checks.push({
      id: 'lxserver_config',
      label: 'lxserver 配置',
      level: configured ? 'ok' : 'warn',
      detail: configured ? '已配置' : '未配置',
    });

    // ── lxserver 连接（带缓存，避免重复登录探测）──
    let connected: boolean | null = null;
    let connectMessage = '未检查';
    if (!configured) {
      connectMessage = '等待配置 lxserver';
    } else {
      const probe = await this.probeLxserver();
      connected = probe.connected;
      connectMessage = probe.message;
    }
    const safeConnectMessage = connected === true
      ? '连接成功'
      : connected === false
        ? '连接失败（' + getErrorCategoryLabel(classifyFailureMessage(connectMessage)) + '）'
        : connectMessage;
    checks.push({
      id: 'lxserver_connection',
      label: 'lxserver 连接',
      level: connected === true ? 'ok' : connected === false ? 'error' : 'warn',
      detail: safeConnectMessage,
    });

    // ── 登录令牌 ──
    let tokenValid = false;
    try {
      tokenValid = !!(await configManager.getLXToken());
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] token check failed: ' + String(e));
    }
    checks.push({
      id: 'lx_token',
      label: '登录令牌',
      level: tokenValid ? 'ok' : 'warn',
      detail: tokenValid ? '有效' : '无有效令牌',
    });

    // ── 自定义源 ──
    let customSources: any[] = [];
    let customSourceError = '';
    if (configured) {
      try {
        customSources = await lxClient.getCustomSources();
      } catch (e: any) {
        customSourceError = String((e && e.message) || e);
      }
    }
    const customEnabled = customSources.filter(function(source) {
      return source && source.enabled !== false;
    }).length;
    checks.push({
      id: 'custom_sources',
      label: '自定义源',
      level: customSourceError ? 'error' : 'ok',
      detail: customSourceError
        ? '读取失败（' + getErrorCategoryLabel(classifyFailureMessage(customSourceError)) + '）'
        : (configured
          ? customSources.length + ' 个（启用 ' + customEnabled + '）'
          : '未配置 lxserver'),
    });

    // ── MIoT 插件 ──
    let miotStatus: { installed: boolean; version?: string; configured: boolean } =
      { installed: false, configured: false };
    try {
      miotStatus = await miotBridge.checkMIoTInstalled();
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] MIoT check failed: ' + String(e));
    }
    checks.push({
      id: 'miot',
      label: 'MIoT 插件',
      level: miotStatus.installed ? (miotStatus.configured ? 'ok' : 'warn') : 'error',
      detail: miotStatus.installed
        ? '已安装' + (miotStatus.version ? '（v' + redactText(miotStatus.version) + '）' : '')
          + (miotStatus.configured ? '，已配置' : '，未配置')
        : '未安装',
    });

    // ── MIoT 设备 ──
    let devices: any[] = [];
    try {
      devices = await miotBridge.getDevices();
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] device list failed: ' + String(e));
    }
    const onlineDeviceCount = devices.filter(function(device) {
      return device && device.online === true;
    }).length;

    // ── 当前选中设备（仅展示名称，不出现在报告中）──
    let selectedDeviceName: string | null = null;
    try {
      const current = playerController.getCurrentDevice();
      if (current && current.device_name) selectedDeviceName = String(current.device_name);
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] current device read failed: ' + String(e));
    }

    // ── 平台冷却 ──
    let cooldowns: Record<string, { blockedAt: number; expiresAt: number }> = {};
    try {
      cooldowns = await configManager.getPlatformCooldowns();
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] cooldown read failed: ' + String(e));
    }
    const now = Date.now();
    const activeCooldowns: Array<{ platform: string; remainingSeconds: number }> = [];
    for (const platform of Object.keys(cooldowns)) {
      if (platform === '__global__') continue;
      const entry = cooldowns[platform];
      if (entry && entry.expiresAt > now) {
        activeCooldowns.push({
          platform: platform,
          remainingSeconds: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
        });
      }
    }
    activeCooldowns.sort(function(a, b) { return a.remainingSeconds - b.remainingSeconds; });
    const globalEntry = cooldowns.__global__;
    const globalActive = !!(globalEntry && globalEntry.expiresAt > now);
    const globalRemainingSeconds = globalActive
      ? Math.max(0, Math.round((globalEntry.expiresAt - now) / 1000))
      : 0;

    // ── 缓存概况 ──
    let historyCount = 0;
    try {
      historyCount = (await configManager.getPlayHistory(200)).length;
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] history count failed: ' + String(e));
    }
    let fallbackLogs: any[] = [];
    try {
      fallbackLogs = await configManager.getFallbackLogs(50);
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] fallback log read failed: ' + String(e));
    }
    let blacklistCount = 0;
    try {
      blacklistCount = Object.keys(await configManager.getQualityBlacklist()).length;
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] blacklist read failed: ' + String(e));
    }
    let customSourceStatCount = 0;
    try {
      customSourceStatCount = Object.keys(await configManager.getCustomSourceStats()).length;
    } catch (e: any) {
      songloft.log.warn('[Diagnostics] custom source stats read failed: ' + String(e));
    }

    // ── 最近活动 ──
    const voiceLogs = this.deps.getVoiceLogs();
    const playbackTracker = this.deps.getPlaybackTracker();
    const voiceFailures = voiceLogs.filter(function(log) {
      return log.result === 'fail' || log.result === '❌';
    }).length;

    const bySource: Record<string, number> = {};
    for (const track of playbackTracker) {
      const key = track.source || 'unknown';
      bySource[key] = (bySource[key] || 0) + 1;
    }

    const recentFallback = fallbackLogs.map(function(record) {
      const parsed = record && record.timestamp ? new Date(record.timestamp).getTime() : 0;
      const rawReason = record && record.downgradeReason ? String(record.downgradeReason) : '';
      return {
        time: Number.isFinite(parsed) ? parsed : 0,
        finalSource: record && record.finalSource ? String(record.finalSource) : '',
        finalQuality: record && record.finalQuality ? String(record.finalQuality) : '',
        reason: rawReason ? getErrorCategoryLabel(classifyFailureMessage(rawReason)) : '',
      };
    });

    // ── 错误分类（仅取已记录的失败事件，脱敏后用于计数）──
    const failureMessages: string[] = [];
    for (const log of voiceLogs) {
      if (log.result === 'fail' || log.result === '❌') {
        failureMessages.push(String(log.detail || ''));
      }
    }
    const errorSummary = summarizeFailures(failureMessages);

    // ── 整体健康状态 ──
    const overall: HealthLevel =
      checks.some(function(check) { return check.level === 'error'; }) ? 'error'
        : checks.some(function(check) { return check.level === 'warn'; }) ? 'warn'
          : 'ok';

    const version = this.deps.version;

    return {
      version,
      generatedAt,
      health: { overall, checks },
      plugin: { status: 'running', version },
      lxserver: {
        configured,
        hostSet: !!(config.host && String(config.host).trim()),
        usernameSet: !!(config.username && String(config.username).trim()),
        passwordSet: !!(config.password && String(config.password)),
        webPlayerConfigured: !!(config.webPlayerUrl && String(config.webPlayerUrl).trim()),
        defaultQuality: String(config.defaultQuality || '320k'),
        sourcePriority: Array.isArray(config.sourcePriority) ? config.sourcePriority.map(String) : [],
        searchTimeout: Number(config.searchTimeout) || 3,
        enableCustomSources: config.enableCustomSources !== false,
        enableFuzzyMatch: config.enableFuzzyMatch !== false,
        allowQualityDowngrade: config.allowQualityDowngrade !== false,
        tokenValid,
        connected,
        connectMessage: safeConnectMessage,
      },
      customSources: {
        total: customSources.length,
        enabled: customEnabled,
        names: customSources
          .map(function(source) { return source && source.name ? String(source.name) : ''; })
          .filter(Boolean),
      },
      miot: {
        installed: miotStatus.installed,
        configured: miotStatus.configured,
        version: redactText(miotStatus.version || ''),
        deviceCount: devices.length,
        onlineDeviceCount,
        selectedDeviceName,
      },
      platformCooldowns: {
        global: globalActive,
        globalRemainingSeconds,
        active: activeCooldowns,
      },
      cache: {
        historyCount,
        fallbackLogCount: fallbackLogs.length,
        blacklistCount,
        customSourceStatCount,
      },
      recent: {
        fallback: recentFallback,
        voice: { total: voiceLogs.length, failures: voiceFailures },
        playback: { total: playbackTracker.length, bySource },
      },
      errorSummary,
    };
  }

  async buildReport(): Promise<string> {
    const overview = await this.gatherOverview();
    return buildReportText(overview);
  }

  private async probeLxserver(): Promise<LXProbeResult> {
    const now = Date.now();
    if (this.lxProbeCache && now - this.lxProbeCache.at < LX_PROBE_TTL_MS) {
      return this.lxProbeCache.result;
    }
    let result: LXProbeResult = { connected: false, message: '连接测试失败' };
    try {
      const probe = await this.deps.lxClient.testConnection();
      result = {
        connected: probe.success === true,
        message: probe.message ? String(probe.message) : (probe.success ? '连接成功' : '连接失败'),
      };
    } catch (e: any) {
      result = { connected: false, message: String((e && e.message) || e) };
    }
    this.lxProbeCache = { at: now, result };
    return result;
  }
}
