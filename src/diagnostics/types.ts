// Songloft-LX 插件 — 诊断中心数据类型定义
// 本模块仅用于诊断数据汇总与脱敏报告，不改变任何播放或降级流程。

export type HealthLevel = 'ok' | 'warn' | 'error';

export interface HealthCheckItem {
  id: string;
  label: string;
  level: HealthLevel;
  detail: string;
}

export interface LXServerHealth {
  configured: boolean;
  hostSet: boolean;
  usernameSet: boolean;
  passwordSet: boolean;
  webPlayerConfigured: boolean;
  defaultQuality: string;
  sourcePriority: string[];
  searchTimeout: number;
  enableCustomSources: boolean;
  enableFuzzyMatch: boolean;
  allowQualityDowngrade: boolean;
  tokenValid: boolean;
  connected: boolean | null;
  connectMessage: string;
}

export interface CustomSourceOverview {
  total: number;
  enabled: number;
  names: string[];
}

export interface MIoTHealth {
  installed: boolean;
  configured: boolean;
  version: string;
  deviceCount: number;
  onlineDeviceCount: number;
  selectedDeviceName: string | null;
}

export interface PlatformCooldownOverview {
  global: boolean;
  globalRemainingSeconds: number;
  active: Array<{ platform: string; remainingSeconds: number }>;
}

export interface CacheOverview {
  historyCount: number;
  fallbackLogCount: number;
  blacklistCount: number;
  customSourceStatCount: number;
}

export interface RecentFallbackRecord {
  time: number;
  finalSource: string;
  finalQuality: string;
  reason: string;
}

export interface RecentActivity {
  fallback: RecentFallbackRecord[];
  voice: { total: number; failures: number };
  playback: { total: number; bySource: Record<string, number> };
}

export interface DiagnosticsOverview {
  version: string;
  generatedAt: number;
  health: {
    overall: HealthLevel;
    checks: HealthCheckItem[];
  };
  plugin: {
    status: 'running';
    version: string;
  };
  lxserver: LXServerHealth;
  customSources: CustomSourceOverview;
  miot: MIoTHealth;
  platformCooldowns: PlatformCooldownOverview;
  cache: CacheOverview;
  recent: RecentActivity;
  errorSummary: {
    total: number;
    byCategory: Array<{ category: string; count: number }>;
  };
}
