// Songloft-LX 插件 — 配置管理器
/// <reference types="@songloft/plugin-sdk" />

import type { LXServerConfig, PlayHistoryItem, FallbackRecord, QualityBlacklistEntry } from '../lxserver/types';
import { DEFAULT_LX_CONFIG } from '../lxserver/types';
import {
  normalizePlatformCooldowns,
  recordSourceCooldown,
} from './platform-cooldown';
import type { PlatformCooldowns } from './platform-cooldown';

const STORAGE_KEY_CONFIG = 'lxserver_config';
const STORAGE_KEY_HISTORY = 'play_history';
const STORAGE_KEY_FALLBACK = 'fallback_log';
const STORAGE_KEY_SELECTED_DEVICE = 'selected_device';
const STORAGE_KEY_THEME = 'lx_theme';
const STORAGE_KEY_BLACKLIST = 'quality_blacklist';
const STORAGE_KEY_PLATFORM_COOLDOWNS = 'fallback_platform_cooldowns';

export class ConfigManager {

  // ===== LXServer 配置 =====

  async getConfig(): Promise<LXServerConfig> {
    const raw = await songloft.storage.get(STORAGE_KEY_CONFIG);
    if (!raw || typeof raw !== 'string') {
      return { ...DEFAULT_LX_CONFIG };
    }
    try {
      const saved = JSON.parse(raw);
      return { ...DEFAULT_LX_CONFIG, ...saved };
    } catch {
      return { ...DEFAULT_LX_CONFIG };
    }
  }

  async saveConfig(config: LXServerConfig): Promise<void> {
    await songloft.storage.set(STORAGE_KEY_CONFIG, JSON.stringify(config));
    songloft.log.info('[Config] LXServer config saved');
  }

  async getLXToken(): Promise<{ token: string; expiry: number } | null> {
    const config = await this.getConfig();
    if (config.token && config.tokenExpiry && config.tokenExpiry > Date.now()) {
      return { token: config.token, expiry: config.tokenExpiry };
    }
    return null;
  }

  async saveLXToken(token: string, expiresInSeconds: number = 86400): Promise<void> {
    const config = await this.getConfig();
    config.token = token;
    config.tokenExpiry = Date.now() + expiresInSeconds * 1000;
    await this.saveConfig(config);
  }

  async clearLXToken(): Promise<void> {
    const config = await this.getConfig();
    config.token = undefined;
    config.tokenExpiry = undefined;
    await this.saveConfig(config);
  }

  // ===== 播放历史 =====

  async getPlayHistory(limit: number = 50): Promise<PlayHistoryItem[]> {
    const raw = await songloft.storage.get(STORAGE_KEY_HISTORY);
    if (!raw || typeof raw !== 'string') return [];
    try {
      return (JSON.parse(raw) as PlayHistoryItem[]).slice(0, limit);
    } catch {
      return [];
    }
  }

  async addPlayHistory(item: PlayHistoryItem): Promise<void> {
    const history = await this.getPlayHistory(200);
    const filtered = history.filter(h => h.songId !== item.songId);
    filtered.unshift(item);
    await songloft.storage.set(STORAGE_KEY_HISTORY, JSON.stringify(filtered.slice(0, 200)));
  }

  async clearPlayHistory(): Promise<void> {
    await songloft.storage.set(STORAGE_KEY_HISTORY, '[]');
  }

  // ===== 降级日志 =====

  async getFallbackLogs(limit: number = 20): Promise<FallbackRecord[]> {
    const raw = await songloft.storage.get(STORAGE_KEY_FALLBACK);
    if (!raw || typeof raw !== 'string') return [];
    try {
      return (JSON.parse(raw) as FallbackRecord[]).slice(0, limit);
    } catch {
      return [];
    }
  }

  async addFallbackLog(record: FallbackRecord): Promise<void> {
    const logs = await this.getFallbackLogs(100);
    logs.unshift(record);
    await songloft.storage.set(STORAGE_KEY_FALLBACK, JSON.stringify(logs.slice(0, 100)));
  }

  // ===== 选中的设备 =====

  async getSelectedDevice(): Promise<{ accountId: string; deviceId: string } | null> {
    const raw = await songloft.storage.get(STORAGE_KEY_SELECTED_DEVICE);
    if (!raw || typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async saveSelectedDevice(accountId: string, deviceId: string): Promise<void> {
    await songloft.storage.set(STORAGE_KEY_SELECTED_DEVICE, JSON.stringify({ accountId, deviceId }));
  }

  // ===== 主题 =====

  async getTheme(): Promise<string> {
    const raw = await songloft.storage.get(STORAGE_KEY_THEME);
    return (typeof raw === 'string' ? raw : 'auto');
  }

  async saveTheme(theme: string): Promise<void> {
    await songloft.storage.set(STORAGE_KEY_THEME, theme);
  }

  // ===== 音频质量黑名单 (v1.9.0) =====

  private _blacklistCache: Record<string, QualityBlacklistEntry> | null = null;
  private BLACKLIST_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30天
  private BLACKLIST_TOUCH_WINDOW = 7 * 24 * 60 * 60 * 1000; // 续期判断窗口7天：7天内已命中过的二次命中才续期，避免短期重复点歌频繁续期

  async getQualityBlacklist(): Promise<Record<string, QualityBlacklistEntry>> {
    if (this._blacklistCache) return this._blacklistCache;
    const raw = await songloft.storage.get(STORAGE_KEY_BLACKLIST);
    if (!raw || typeof raw !== 'string') {
      this._blacklistCache = {};
      return {};
    }
    try {
      const data = JSON.parse(raw) as Record<string, QualityBlacklistEntry>;
      // 清理过期条目
      const now = Date.now();
      let changed = false;
      for (const key of Object.keys(data)) {
        if (now - data[key].timestamp > this.BLACKLIST_MAX_AGE) {
          delete data[key];
          changed = true;
        }
      }
      if (changed) {
        await songloft.storage.set(STORAGE_KEY_BLACKLIST, JSON.stringify(data));
      }
      this._blacklistCache = data;
      return data;
    } catch {
      this._blacklistCache = {};
      return {};
    }
  }

  async addToBlacklist(sourceSongId: string, entry: QualityBlacklistEntry): Promise<void> {
    const blacklist = await this.getQualityBlacklist();
    blacklist[sourceSongId] = entry;
    await songloft.storage.set(STORAGE_KEY_BLACKLIST, JSON.stringify(blacklist));
    songloft.log.info('[Blacklist] Added: ' + sourceSongId + ' reason=' + entry.reason + ' duration=' + entry.duration + 's actual=' + entry.actualDuration + 's');
  }

  /**
   * 记录一次黑名单命中（v1.9.0-beta.4: 二次命中自动续期30天）
   * 高频播放的歌每次命中都续期，保证体验；首次加入时 lastHitAt 为空，不续期。
   */
  async touchBlacklistHit(urlHash: string): Promise<void> {
    try {
      const blacklist = await this.getQualityBlacklist();
      const now = Date.now();
      let touched = false;
      for (const key of Object.keys(blacklist)) {
        const entry = blacklist[key];
        if (entry.urlHash !== urlHash) continue;
        // 仅当上次命中在7天窗口外（即确属"二次独立命中"）才续期，避免短期连续点歌频繁写盘
        const lastHit = entry.lastHitAt || entry.timestamp;
        if (now - lastHit > this.BLACKLIST_TOUCH_WINDOW) {
          entry.lastHitAt = now;
          entry.timestamp = now; // 续期：重置30天计时
          touched = true;
          songloft.log.info('[Blacklist] Touch renewed: ' + key + ' (二次命中续期30天)');
        }
        break;
      }
      if (touched) {
        await songloft.storage.set(STORAGE_KEY_BLACKLIST, JSON.stringify(blacklist));
      }
    } catch (e: any) {
      songloft.log.warn('[Blacklist] touch hit error: ' + String(e));
    }
  }

  async isBlacklisted(sourceSongId: string): Promise<boolean> {
    const blacklist = await this.getQualityBlacklist();
    return sourceSongId in blacklist;
  }

  async isUrlBlacklisted(urlHash: string): Promise<boolean> {
    const blacklist = await this.getQualityBlacklist();
    for (const entry of Object.values(blacklist)) {
      if (entry.urlHash === urlHash) return true;
    }
    return false;
  }

  async clearBlacklist(): Promise<void> {
    this._blacklistCache = {};
    await songloft.storage.set(STORAGE_KEY_BLACKLIST, '{}');
  }

  // ===== 自定义源统计 (v2.1.0) =====

  private _customSourceStatsCache: Record<string, { successCount: number; failCount: number; lastFailAt?: number }> | null = null;

  async getCustomSourceStats(): Promise<Record<string, { successCount: number; failCount: number; lastFailAt?: number }>> {
    if (this._customSourceStatsCache) return this._customSourceStatsCache;
    const raw = await songloft.storage.get('custom_source_stats');
    if (!raw || typeof raw !== 'string') {
      this._customSourceStatsCache = {};
      return {};
    }
    try {
      this._customSourceStatsCache = JSON.parse(raw);
      return this._customSourceStatsCache!;
    } catch {
      this._customSourceStatsCache = {};
      return {};
    }
  }

  async recordCustomSourceResult(customSourceName: string, platform: string, success: boolean): Promise<void> {
    const stats = await this.getCustomSourceStats();
    const key = customSourceName + ':' + platform;
    if (!stats[key]) {
      stats[key] = { successCount: 0, failCount: 0 };
    }
    if (success) {
      stats[key].successCount++;
    } else {
      stats[key].failCount++;
      stats[key].lastFailAt = Date.now();
    }
    await songloft.storage.set('custom_source_stats', JSON.stringify(stats));
  }

  async isCustomSourceFailedForPlatform(customSourceName: string, platform: string, threshold: number = 3): Promise<boolean> {
    const stats = await this.getCustomSourceStats();
    const key = customSourceName + ':' + platform;
    const stat = stats[key];
    if (!stat) return false;
    // 如果失败次数超过阈值且成功率低于50%，认为该组合不可用
    const total = stat.successCount + stat.failCount;
    if (total >= threshold && stat.failCount > stat.successCount) {
      return true;
    }
    return false;
  }

  async resetCustomSourceStats(): Promise<void> {
    this._customSourceStatsCache = {};
    await songloft.storage.set('custom_source_stats', '{}');
    songloft.log.info('[Config] Custom source stats reset');
  }

  // ===== URL 解析平台冷却 (v2.2.0) =====

  private _platformCooldownCache: PlatformCooldowns | null = null;

  async getPlatformCooldowns(): Promise<PlatformCooldowns> {
    if (!this._platformCooldownCache) {
      const raw = await songloft.storage.get(STORAGE_KEY_PLATFORM_COOLDOWNS);
      try {
        this._platformCooldownCache = raw && typeof raw === 'string' ? JSON.parse(raw) : {};
      } catch {
        this._platformCooldownCache = {};
      }
    }

    const normalized = normalizePlatformCooldowns(this._platformCooldownCache!);
    this._platformCooldownCache = normalized.cooldowns;
    if (normalized.changed) {
      await songloft.storage.set(STORAGE_KEY_PLATFORM_COOLDOWNS, JSON.stringify(normalized.cooldowns));
    }
    return normalized.cooldowns;
  }

  async getPlatformCooldownRemaining(platform: string): Promise<number> {
    const cooldowns = await this.getPlatformCooldowns();
    const entry = cooldowns[platform];
    return entry ? Math.max(0, entry.expiresAt - Date.now()) : 0;
  }

  async recordPlatformBlock(platform: string, cooldownMs: number = 15 * 60 * 1000): Promise<{ global: boolean }> {
    const cooldowns = await this.getPlatformCooldowns();
    const now = Date.now();
    this._platformCooldownCache = recordSourceCooldown(cooldowns, platform, now, cooldownMs);
    await songloft.storage.set(STORAGE_KEY_PLATFORM_COOLDOWNS, JSON.stringify(this._platformCooldownCache));
    songloft.log.warn('[FallbackV22] Cooldown recorded: platform=' + platform);
    return { global: false };
  }
}
