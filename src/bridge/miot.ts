// Songloft-LX 插件 — MIoT 插件桥接
// 通过 HTTP 调用 MIoT 插件的 API 路由（和 MIoT Web UI 相同的调用方式）
/// <reference types="@songloft/plugin-sdk" />

import type { MIoTDevice, MIoTPlaybackControl } from '../lxserver/types';

const MIOT_API_BASE = '/api/v1/jsplugin/miot';
const LXBRIDGE_SEARCH_SOURCE_ID = 'lxbridge';
const LXBRIDGE_SEARCH_SOURCE_NAME = 'LX音乐桥';
const LXBRIDGE_SEARCH_PATH = '/api/search/topone';
const LXBRIDGE_SEARCH_URL = '/api/v1/jsplugin/lxbridge' + LXBRIDGE_SEARCH_PATH;

interface MIoTSearchSource {
  id: string;
  name: string;
  url: string;
  token?: string;
  enabled: boolean;
}

// 解码HTML实体（lxserver返回URL可能包含双重编码的 &amp;amp; 等）
function decodeHtmlEntities(str: string): string {
  if (!str) return str;
  let prev: string;
  do {
    prev = str;
    str = str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  } while (str !== prev);
  return str;
}

export class MIoTBridge {

  /**
   * 通用 MIoT HTTP 请求
   */
  private async miotRequest(path: string, options?: { method?: string; body?: any }): Promise<any> {
    songloft.log.info('[MIoTBridge] miotRequest START path=' + path);

    const method = options?.method || 'GET';
    songloft.log.info('[MIoTBridge] method=' + method);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // 使用插件 token 进行认证
    try {
      songloft.log.info('[MIoTBridge] Getting token...');
      const token = await songloft.plugin.getToken();
      songloft.log.info('[MIoTBridge] Token obtained');
      headers['Authorization'] = 'Bearer ' + token;
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] Failed to get token: ' + String(e));
    }

    const fetchOptions: any = { method, headers };
    if (options?.body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(options.body);
      songloft.log.info('[MIoTBridge] Body length: ' + fetchOptions.body.length);
    }

    // 构建完整 URL - 使用 http://localhost:58091（插件内部调用）
    const fullUrl = 'http://localhost:58091' + MIOT_API_BASE + path;
    songloft.log.info('[MIoTBridge] Full URL: ' + fullUrl);
    songloft.log.info('[MIoTBridge] Calling fetch...');

    try {
      const resp = await fetch(fullUrl, fetchOptions);
      songloft.log.info('[MIoTBridge] Fetch completed, status=' + resp.status);

      const text = await resp.text();
      songloft.log.info('[MIoTBridge] Response text length: ' + text.length);

      if (!resp.ok) {
        songloft.log.warn('[MIoTBridge] HTTP error: ' + resp.status + ' body=' + text.substring(0, 200));
        throw new Error('MIoT HTTP ' + resp.status + ': ' + text.substring(0, 100));
      }

      try {
        const parsed = JSON.parse(text);
        songloft.log.info('[MIoTBridge] Parsed JSON successfully');
        return parsed;
      } catch (parseErr: any) {
        songloft.log.warn('[MIoTBridge] JSON parse failed: ' + String(parseErr));
        return { raw: text };
      }
    } catch (fetchErr: any) {
      songloft.log.warn('[MIoTBridge] Fetch error: ' + String(fetchErr));
      throw fetchErr;
    }
  }

  /**
   * 检测 MIoT 是否安装（尝试调用其 API）
   */
  async checkMIoTInstalled(): Promise<{ installed: boolean; version?: string; configured: boolean }> {
    try {
      // 尝试调用 MIoT 的 config API 来验证其是否存在
      const result = await this.miotRequest('/config');
      if (result && result.success !== false) {
        return {
          installed: true,
          version: result.version || result.data?.version || 'unknown',
          configured: true, // 能响应 API 说明基本配置好了
        };
      }
      return { installed: false, configured: false };
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] MIoT not available: ' + String(e));
      return { installed: false, configured: false };
    }
  }

  /**
   * 获取 MIoT 设备列表
   */
  async getDevices(): Promise<MIoTDevice[]> {
    try {
      const result = await this.miotRequest('/mina/devices');
      if (result && result.success !== false && Array.isArray(result.data)) {
        // MIoT 返回的是按账号分组的设备列表
        const allDevices: MIoTDevice[] = [];
        for (const account of result.data) {
          const accountId = account.account_id || account.accountId || '';
          const devices = Array.isArray(account.devices) ? account.devices : [];
          for (const d of devices) {
            allDevices.push({
              account_id: accountId,
              device_id: d.deviceID || d.device_id || d.deviceId || '',
              device_name: d.name || d.alias || d.device_name || '未知设备',
              model: d.model || '',
              alias: d.alias || '',
              online: d.presence === 'online' || d.online === true,
            });
          }
        }
        return allDevices;
      }
      return [];
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] getDevices failed: ' + String(e));
      return [];
    }
  }

  /**
   * 获取设备播放状态
   */
  async getPlayerStatus(accountId: string, deviceId: string): Promise<{
    state: string; volume: number; playMode: string;
    currentSong?: { title: string; artist: string };
  } | null> {
    try {
      const result = await this.miotRequest('/player/status?account_id=' + encodeURIComponent(accountId) + '&device_id=' + encodeURIComponent(deviceId));
      if (result && result.success && result.data) {
        return {
          state: result.data.state || 'idle',
          volume: result.data.volume || 50,
          playMode: result.data.play_mode || 'order',
          currentSong: result.data.current_song || undefined,
        };
      }
      return null;
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] getPlayerStatus failed: ' + String(e));
      return null;
    }
  }

  /**
   * 控制播放（通过 MIoT HTTP API）
   */
  async controlPlayback(control: MIoTPlaybackControl): Promise<boolean> {
    try {
      songloft.log.info('[MIoTBridge] controlPlayback: ' + JSON.stringify(control));
      const action = control.action || 'toggle';

      // 构建请求体：基础字段 + 可选字段
      const body: any = {
        account_id: control.account_id,
        device_id: control.device_id,
      };
      if (control.volume !== undefined) body.volume = control.volume;
      if (control.play_mode) body.play_mode = control.play_mode;

      const result = await this.miotRequest('/player/' + action, {
        method: 'POST',
        body,
      });
      songloft.log.info('[MIoTBridge] controlPlayback ' + action + ' result: ' + JSON.stringify(result));
      return result?.success === true || (result && result.success !== false);
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] controlPlayback failed: ' + String(e));
      return false;
    }
  }

  async playSong(accountId: string, deviceId: string, songUrl: string): Promise<boolean> {
    try {
      const decodedUrl = decodeHtmlEntities(songUrl);
      songloft.log.info('[MIoTBridge] playSong via /mina/play-url: accountId=' + accountId + ' deviceId=' + deviceId);
      songloft.log.info('[MIoTBridge] songUrl length=' + decodedUrl.length + ' decoded=' + (decodedUrl !== songUrl));
      const result = await this.miotRequest('/mina/play-url', {
        method: 'POST',
        body: {
          account_id: accountId,
          device_id: deviceId,
          song_url: decodedUrl,
          url: decodedUrl,
        },
      });
      songloft.log.info('[MIoTBridge] playSong result: ' + JSON.stringify(result));
      return result?.success === true || (result && result.success !== false);
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] playSong failed: ' + String(e));
      return false;
    }
  }

  async setVolume(accountId: string, deviceId: string, volume: number): Promise<boolean> {
    // 使用 /mina/volume 端点（与 MIoT 官方插件一致）
    try {
      songloft.log.info('[MIoTBridge] setVolume: accountId=' + accountId + ' deviceId=' + deviceId + ' volume=' + volume);
      const result = await this.miotRequest('/mina/volume', {
        method: 'POST',
        body: {
          account_id: accountId,
          device_id: deviceId,
          volume: volume,
        },
      });
      songloft.log.info('[MIoTBridge] setVolume result: ' + JSON.stringify(result));
      return result?.success === true || (result && result.success !== false);
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] setVolume failed: ' + String(e));
      return false;
    }
  }

  async setPlayMode(accountId: string, deviceId: string, mode: string): Promise<boolean> {
    return await this.controlPlayback({ action: 'set_play_mode', account_id: accountId, device_id: deviceId, play_mode: mode });
  }

  private normalizeSearchSources(value: unknown): MIoTSearchSource[] {
    if (!Array.isArray(value)) return [];
    return value.filter((source: any) => {
      return source && typeof source.url === 'string' && source.url.trim() !== '';
    }).map((source: any, index: number) => ({
      id: typeof source.id === 'string' && source.id ? source.id : 'source-' + index,
      name: typeof source.name === 'string' ? source.name : '',
      url: source.url.trim(),
      token: typeof source.token === 'string' ? source.token : '',
      enabled: source.enabled !== false,
    }));
  }

  private buildSearchSources(existingSources: MIoTSearchSource[]): MIoTSearchSource[] {
    const otherSources = existingSources.filter(source => {
      return source.id !== LXBRIDGE_SEARCH_SOURCE_ID
        && source.url !== LXBRIDGE_SEARCH_URL
        && source.url !== '/api/v1/jsplugin/lxbridge/api/search';
    });
    const lxbridgeSource: MIoTSearchSource = {
      id: LXBRIDGE_SEARCH_SOURCE_ID,
      name: LXBRIDGE_SEARCH_SOURCE_NAME,
      url: LXBRIDGE_SEARCH_URL,
      token: '',
      enabled: true,
    };
    return [lxbridgeSource].concat(otherSources);
  }

  /**
   * 自动启用 MIoT 外部搜索，并把 LX音乐桥置于搜索源列表首位。
   * 同时写入旧单值字段，兼容尚未支持多搜索源的 MIoT 版本。
   */
  async configureSearchEndpoint(): Promise<boolean> {
    try {
      let existingSources: MIoTSearchSource[] = [];
      let canUpdateSourceList = false;
      try {
        const current = await this.miotRequest('/config');
        existingSources = this.normalizeSearchSources(current?.data?.external_search_sources);
        canUpdateSourceList = true;
      } catch (e: any) {
        songloft.log.warn('[MIoTBridge] Failed to read existing search sources, preserving the source list: ' + String(e));
      }

      const body: any = {
        external_search_enabled: true,
        external_search_url: LXBRIDGE_SEARCH_URL,
        voice_command_enabled: true,
      };
      if (canUpdateSourceList) {
        body.external_search_sources = this.buildSearchSources(existingSources);
      }

      await this.miotRequest('/config', {
        method: 'POST',
        body,
      });
      songloft.log.info('[MIoTBridge] MIoT configured: LX音乐桥 first, extSearch=enabled, voiceCmd=enabled');
      return true;
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] configureSearchEndpoint failed: ' + String(e));
      return false;
    }
  }

  /**
   * 将 LX音乐桥登记为 MIoT 的候选搜索源。注册失败不影响自动配置和插件启动。
   */
  registerSearchProvider(): void {
    let attempts = 0;
    const tryRegister = async () => {
      attempts += 1;
      try {
        if (!songloft.comm || typeof songloft.comm.call !== 'function') {
          songloft.log.info('[MIoTBridge] Search provider registration unavailable on this host');
          return;
        }
        await songloft.comm.call('miot', 'register-search-provider', {
          name: LXBRIDGE_SEARCH_SOURCE_NAME,
          searchPath: LXBRIDGE_SEARCH_PATH,
          icon: '',
        }, 3000);
        songloft.log.info('[MIoTBridge] Registered as MIoT search provider');
      } catch (e: any) {
        if (attempts < 5) {
          songloft.log.warn('[MIoTBridge] Search provider registration retry ' + attempts + '/5: ' + String(e));
          setTimeout(tryRegister, 3000);
        } else {
          songloft.log.warn('[MIoTBridge] Search provider registration skipped after 5 attempts: ' + String(e));
        }
      }
    };
    setTimeout(tryRegister, 2000);
  }

  async unregisterSearchProvider(): Promise<void> {
    try {
      if (songloft.comm && typeof songloft.comm.call === 'function') {
        await songloft.comm.call('miot', 'unregister-search-provider', {}, 2000);
      }
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] Search provider unregister failed: ' + String(e));
    }
  }

  /**
   * 获取 MIoT 对话记录
   */
  async getConversations(limit: number = 20): Promise<any[]> {
    try {
      songloft.log.info('[MIoTBridge] ========== 获取对话记录 ==========');
      songloft.log.info('[MIoTBridge] 请求 /conversation/messages?limit=' + limit);
      const result = await this.miotRequest('/conversation/messages?limit=' + limit);
      songloft.log.info('[MIoTBridge] getConversations 原始响应: ' + JSON.stringify(result).substring(0, 500));
      songloft.log.info('[MIoTBridge] 响应类型: ' + typeof result);
      songloft.log.info('[MIoTBridge] 是否数组: ' + Array.isArray(result));
      songloft.log.info('[MIoTBridge] success字段: ' + result?.success);
      songloft.log.info('[MIoTBridge] data字段类型: ' + typeof result?.data);

      if (result && result.success !== false) {
        if (Array.isArray(result.data)) {
          songloft.log.info('[MIoTBridge] 返回 result.data，数量: ' + result.data.length);
          return result.data;
        }
        if (Array.isArray(result)) {
          songloft.log.info('[MIoTBridge] 返回 result，数量: ' + result.length);
          return result;
        }
      }
      songloft.log.warn('[MIoTBridge] getConversations: unexpected format, 返回空数组');
      return [];
    } catch (e: any) {
      songloft.log.warn('[MIoTBridge] getConversations error: ' + String(e));
      songloft.log.warn('[MIoTBridge] error stack: ' + (e.stack || 'no stack'));
      return [];
    }
  }
}
