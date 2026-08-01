// Songloft-LX 插件 — LXServer HTTP 客户端
// 封装所有 lxserver REST API 调用

/// <reference types="@songloft/plugin-sdk" />

import type {
  LXServerConfig,
  LXLoginResponse,
  LXSearchParams,
  LXSearchResult,
  LXUrlParams,
  LXUrlResponse,
  LXLyricParams,
  LXLyricResponse,
  LXFavoriteItem,
  LxPlaylist,
  QualityBlacklistEntry,
  QualityBlacklistReason,
  FallbackSearchResult,
  FailureClassification,
} from './types';

// 收藏缓存条目（内部使用）
interface FavoriteCacheEntry {
  nameKey: string;
  source: string;
}

interface UrlResolutionResult {
  url: string | null;
  customSourceName?: string;
  failureText?: string;
  blocked?: boolean;
  failureClassification?: FailureClassification;
}
import { ConfigManager } from '../config/manager';
import { extractCustomSources } from './custom-sources';
import { FailureClassifier } from './failure-classification';
import { selectRunnableFallbackBatch } from './fallback-batch';
import {
  buildEntitySearchPath,
  mergeEntitySourcePages,
  normalizeEntitySearchPage,
  resolveEntitySources,
} from './entity-search';
import type { EntitySearchBatch, EntitySearchType, EntitySourcePage } from './entity-search';
import {
  buildArtistDetailPath,
  buildArtistSongsPath,
  normalizeArtistDetail,
  normalizeArtistSongs,
} from './artist-detail';
import type { ArtistDetail, ArtistDetailFallback } from './artist-detail';

export class LXServerClient {
  private configManager: ConfigManager;
  private config: LXServerConfig | null = null;

  // ===== 收藏缓存 (v1.9.0) =====
  private favoriteCache: Map<string, FavoriteCacheEntry> = new Map();
  private favoriteCacheTimer: any = null;
  private static readonly FALLBACK_MAX_URL_ATTEMPTS = 8;
  private static readonly FALLBACK_TIMEOUT_MS = 10 * 1000;
  private static readonly FALLBACK_MAX_CONCURRENT_URLS = 2;
  private static activeUrlResolutions = 0;
  private static urlResolutionQueue: Array<() => void> = [];
  private static fallbackInflight: Record<string, Promise<FallbackSearchResult>> = {};

  private scheduleUrlResolution<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>(function(resolve, reject) {
      const start = function() {
        LXServerClient.activeUrlResolutions++;
        work().then(resolve, reject).then(function() {
          LXServerClient.activeUrlResolutions--;
          const next = LXServerClient.urlResolutionQueue.shift();
          if (next) next();
        }, function() {
          LXServerClient.activeUrlResolutions--;
          const next = LXServerClient.urlResolutionQueue.shift();
          if (next) next();
        });
      };
      if (LXServerClient.activeUrlResolutions < LXServerClient.FALLBACK_MAX_CONCURRENT_URLS) {
        start();
      } else {
        LXServerClient.urlResolutionQueue.push(start);
      }
    });
  }

  // ===== URL哈希工具 (v1.9.0, beta.4 改两头判断) =====
  private urlHash(url: string): string {
    // 两头判断：头部40字符 + 尾部80字符，降低不同歌曲URL碰撞误杀
    // 尾部文件名hash每首唯一(主区分)，头部CDN域名+签名段辅助(防尾部过短)
    var len = url.length;
    var str: string;
    if (len <= 120) {
      str = url; // 短URL直接全量
    } else {
      str = url.substring(0, 40) + url.substring(len - 80);
    }
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'h_' + Math.abs(hash).toString(36);
  }

  // ===== 音质比特率映射 (v1.9.0) =====
  private static BITRATE_MAP: Record<string, number> = {
    '128k': 16000,   // bytes/s (128000 / 8)
    '320k': 40000,   // bytes/s (320000 / 8)
    'flac': 90000,   // bytes/s (约720kbps FLAC平均)
  };

  // ===== 异常关键词列表 (v1.9.0) =====
  private static CLIP_KEYWORDS = ['试听版', '试听', '铃声版', '铃声', '30秒', '60秒', 'preview', 'short ver'];

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  // ===== 初始化 =====

  async init(): Promise<void> {
    this.config = await this.configManager.getConfig();
    // v1.9.0: 异步加载收藏缓存（不阻塞初始化）
    this.refreshFavoriteCache();
  }

  async reloadConfig(): Promise<void> {
    this.config = await this.configManager.getConfig();
  }

  // ===== 收藏缓存管理 (v1.9.0) =====

  /**
   * 异步刷新收藏列表到内存缓存
   * 启动时调用 + 每30分钟自动刷新
   */
  private async refreshFavoriteCache(): Promise<void> {
    try {
      if (!this.config || !this.config.host) return;
      const favorites = await this.getFavorites();
      const newCache = new Map<string, FavoriteCacheEntry>();
      for (const item of favorites) {
        const nameKey = ((item.name || '') + '|' + (item.singer || '')).toLowerCase().trim();
        newCache.set(nameKey, { nameKey, source: item.source || '' });
      }
      this.favoriteCache = newCache;
      songloft.log.info('[LXClient] Favorite cache refreshed: ' + newCache.size + ' items');

      // 30分钟后自动刷新
      if (this.favoriteCacheTimer) clearTimeout(this.favoriteCacheTimer);
      this.favoriteCacheTimer = setTimeout(() => { this.refreshFavoriteCache(); }, 30 * 60 * 1000);
    } catch (e: any) {
      songloft.log.warn('[LXClient] Favorite cache refresh failed: ' + String(e));
    }
  }

  private getBaseUrl(): string {
    if (!this.config || !this.config.host) {
      throw new Error('LXServer 地址未配置');
    }
    return this.config.host.replace(/\/+$/, '');
  }

  // ===== 认证 =====

  /**
   * 登录获取token
   */
  async login(force?: boolean): Promise<string> {
    if (!this.config) await this.init();

    // 非强制刷新时检查缓存token
    if (!force) {
      const cached = await this.configManager.getLXToken();
      if (cached && cached.expiry > Date.now() + 60000) {
        songloft.log.info('[LXClient] Using cached token');
        return cached.token;
      }
    }

    const baseUrl = this.getBaseUrl();
    const body = JSON.stringify({
      username: this.config!.username,
      password: this.config!.password,
    });

    songloft.log.info('[LXClient] Logging in to ' + baseUrl + (force ? ' (force)' : ''));

    try {
      const resp = await fetch(baseUrl + '/api/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!resp.ok) {
        throw new Error('LXServer 登录失败: HTTP ' + resp.status);
      }

      const data: LXLoginResponse = JSON.parse(await resp.text());

      if (!data.success || !data.token) {
        throw new Error('LXServer 登录失败: ' + (data.message || '未知错误'));
      }

      await this.configManager.saveLXToken(data.token);
      songloft.log.info('[LXClient] Login successful');
      return data.token;
    } catch (e: any) {
      // 登录失败时清除旧token，防止下次用过期token
      if (force) {
        await this.configManager.clearLXToken();
      }
      throw e;
    }
  }

  /**
   * 获取有效token（自动登录）
   */
  private async getToken(force?: boolean): Promise<string> {
    if (!force) {
      const cached = await this.configManager.getLXToken();
      if (cached && cached.expiry > Date.now() + 60000) {
        return cached.token;
      }
    }
    return await this.login(force);
  }

  // ===== 测试连接 =====

  async testConnection(): Promise<{ success: boolean; message: string }> {
    // v1.0.90: 确保配置已加载，解决上传后首次调用失败
    await this.reloadConfig();
    if (!this.config || !this.config.host) {
      return { success: false, message: 'LXServer 地址未配置' };
    }

    // 带重试的连接测试（3次，间隔1秒）
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // 连接测试不复用升级前缓存的 token，始终以当前配置重新登录。
        const token = await this.login(true);
        if (!token) {
          lastErr = '无法获取Token';
          continue;
        }

        const baseUrl = this.getBaseUrl();
        const resp = await fetch(baseUrl + '/api/user/auth/verify', {
          headers: {
            'x-user-token': token,
            'x-user-name': this.config!.username,
          },
        });

        const responseText = await resp.text();
        let verifyData: any = null;
        try {
          verifyData = responseText ? JSON.parse(responseText) : null;
        } catch {
          verifyData = null;
        }

        if (resp.ok && verifyData && verifyData.valid === true) {
          songloft.log.info('[LXClient] testConnection成功 (尝试' + (attempt + 1) + '次)');
          return { success: true, message: '连接成功' };
        }

        await this.configManager.clearLXToken();
        if (!resp.ok) {
          lastErr = 'Token验证失败: HTTP ' + resp.status;
        } else if (!verifyData) {
          lastErr = 'Token验证失败: 响应格式无效';
        } else {
          lastErr = 'Token验证失败: LXServer 未确认登录有效';
        }
      } catch (e: any) {
        lastErr = '连接失败: ' + (e.message || String(e));
      }

      // 重试前等待1秒
      if (attempt < 2) {
        songloft.log.info('[LXClient] testConnection重试 ' + (attempt + 2) + '/3，原因: ' + lastErr);
        await new Promise<void>(function(resolve) { setTimeout(function() { resolve(); }, 1000); });
      }
    }

    songloft.log.warn('[LXClient] testConnection失败 (3次重试后): ' + lastErr);
    return { success: false, message: lastErr || '连接失败' };
  }

  // ===== 搜索 =====

  /**
   * 在指定音源搜索歌曲
   */
  async search(params: LXSearchParams, retry: boolean = true): Promise<LXSearchResult[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      const queryParts = [
        'source=' + encodeURIComponent(params.source),
        'name=' + encodeURIComponent(params.keywords),
        'limit=' + (params.limit || 20),
        'page=' + (params.page || 1),
      ];
      const url = baseUrl + '/api/music/search?' + queryParts.join('&');
      songloft.log.info('[LXClient] Search URL: ' + url);

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'x-user-token': token,
          'x-user-name': this.config!.username,
        },
      });

      songloft.log.info('[LXClient] Search HTTP ' + resp.status + ' for source=' + params.source);

      if (!resp.ok) {
        const errBody = await resp.text();
        songloft.log.warn('[LXClient] Search failed: HTTP ' + resp.status + ' body=' + errBody.substring(0, 200));
        // 401/403: token过期，清除重试一次
        if (retry && (resp.status === 401 || resp.status === 403)) {
          songloft.log.info('[LXClient] Token expired, retrying with fresh login...');
          return await this.search(params, false);
        }
        return [];
      }

      const text = await resp.text();
      songloft.log.info('[LXClient] Search response body: ' + text.substring(0, 500));

      const data = JSON.parse(text);
      // lxserver 可能返回 {success:true,data:[...]} 或 {code:0,data:[...]} 或直接是数组
      let results: any[] = [];
      if (Array.isArray(data)) {
        results = data;
      } else if (data.success && Array.isArray(data.data)) {
        results = data.data;
      } else if (data.code === 0 && Array.isArray(data.data)) {
        results = data.data;
      } else if (Array.isArray(data.result)) {
        results = data.result;
      } else if (Array.isArray(data.list)) {
        results = data.list;
      } else if (Array.isArray(data.songs)) {
        results = data.songs;
      } else {
        songloft.log.warn('[LXClient] Unknown response format, keys: ' + Object.keys(data).join(', '));
        return [];
      }

      if (results.length > 0) {
        songloft.log.info('[LXClient] Search success: ' + results.length + ' results from ' + params.source);
        return results.map((item: any) => {
          // lxserver 字段: name, singer, albumName, songmid|songId, img, interval("MM:SS"), types[{type,size}]
          // 解析时长 "02:52" → 172秒
          let duration = 0;
          const interval = item.interval || item.duration || '';
          const parts = String(interval).split(':');
          if (parts.length === 2) duration = parseInt(parts[0]) * 60 + parseInt(parts[1]);
          else if (parseInt(interval) > 0) duration = parseInt(interval);
          // 提取最佳音质
          let quality = '';
          if (Array.isArray(item.types) && item.types.length > 0) {
            quality = item.types[item.types.length - 1].type || '';
          }
          return {
            id: item.songmid || item.songId || item.id || '',
            name: item.name || '',
            singer: item.singer || '',
            album: item.albumName || item.album || '',
            duration: duration,
            cover: item.img || item.cover || '',
            source: item.source || params.source,
            quality: quality,
            lyricId: item.lrc || item.lyricId || '',
            albumId: String(item.albumId || ''),
            _raw: item,  // 保留完整的 lxserver 原始响应
          };
        });
      }
      songloft.log.warn('[LXClient] Search returned success=' + data.success + ' data=' + typeof data.data);
      return [];
    } catch (e: any) {
      songloft.log.warn('[LXClient] Search error: ' + String(e));
      return [];
    }
  }

  /**
   * 多源并行搜索
   * v1.9.0: 去重改为"歌名|歌手|音源"，保留同一首歌不同音源的结果
   */
  async searchMultiSource(
    keywords: string,
    sources: string[],
    timeout: number = 3000,
    limit: number = 30
  ): Promise<LXSearchResult[]> {
    const results: LXSearchResult[] = [];
    const seen = new Set<string>();

    // 并行搜索所有源
    const searchPromises = sources.map(async (source) => {
      try {
        const items = await this.search({ source, keywords, limit: limit });
        return items;
      } catch {
        return [];
      }
    });

    const allResults = await Promise.all(searchPromises);

    // v1.9.0: 去重合并（按歌名+歌手+音源），保留同一首歌不同音源
    for (const items of allResults) {
      for (const item of items) {
        const key = (item.name + '|' + item.singer + '|' + item.source).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push(item);
        }
      }
    }

    return results;
  }

  /**
   * 搜索歌手或歌单。每个音源独立失败，只有全部音源失败时才拒绝请求。
   */
  async searchEntities(
    type: EntitySearchType,
    keyword: string,
    requestedSources: string[],
    page: number = 1,
    limit: number = 20,
    retry: boolean = true,
  ): Promise<EntitySearchBatch> {
    const sources = resolveEntitySources(type, requestedSources);
    const normalizedKeyword = String(keyword || '').trim();
    if (!normalizedKeyword) throw new Error('搜索关键词不能为空');

    const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
    const token = await this.getToken();
    const baseUrl = this.getBaseUrl();
    const username = this.config!.username;

    const settled = await Promise.all(sources.map(async (source): Promise<{
      source: string;
      page?: EntitySourcePage;
      authFailed?: boolean;
    }> => {
      const path = buildEntitySearchPath(type, normalizedKeyword, source, normalizedPage, normalizedLimit);
      try {
        const resp = await fetch(baseUrl + path, {
          method: 'GET',
          headers: { 'x-user-token': token, 'x-user-name': username },
        });
        if (!resp.ok) {
          songloft.log.warn('[LXClient] Entity search failed: type=' + type +
            ' source=' + source + ' page=' + normalizedPage + ' status=' + resp.status);
          return { source, authFailed: resp.status === 401 || resp.status === 403 };
        }
        const payload = JSON.parse(await resp.text());
        return {
          source,
          page: normalizeEntitySearchPage(
            type,
            source,
            payload,
            normalizedPage,
            normalizedLimit,
          ),
        };
      } catch (e: any) {
        songloft.log.warn('[LXClient] Entity search error: type=' + type +
          ' source=' + source + ' page=' + normalizedPage + ' error=' + String(e));
        return { source };
      }
    }));

    const pages = settled.filter(item => !!item.page).map(item => item.page!);
    const failedSources = settled.filter(item => !item.page).map(item => item.source);
    if (pages.length === 0) {
      if (retry && settled.some(item => item.authFailed)) {
        await this.getToken(true);
        return this.searchEntities(type, normalizedKeyword, sources, normalizedPage, normalizedLimit, false);
      }
      throw new Error('实体搜索全部音源请求失败');
    }

    const batch = mergeEntitySourcePages(pages, failedSources);
    songloft.log.info('[LXClient] Entity search: type=' + type +
      ' sources=' + sources.join(',') + ' page=' + normalizedPage +
      ' items=' + batch.items.length + ' failed=' + failedSources.length);
    return batch;
  }

  async getArtistDetail(
    source: string,
    id: string,
    fallback: ArtistDetailFallback = {},
  ): Promise<ArtistDetail> {
    const payload = await this.simpleGet(buildArtistDetailPath(source, id));
    return normalizeArtistDetail(payload, source, Object.assign({}, fallback, { id }));
  }

  async getArtistSongs(source: string, id: string, order: string = 'hot'): Promise<LXSearchResult[]> {
    const payload = await this.simpleGet(buildArtistSongsPath(source, id, order));
    return normalizeArtistSongs(payload, source);
  }

  // ===== 异常URL检测 (v1.8.22) =====

  /**
   * 检测URL是否为异常/报错音频
   * 通用规则：覆盖所有通过 getSongUrl 获取的URL
   * - 已知错误音频地址特征
   * - URL过短：正常播放链接不会短于20字符
   * 返回true表示该URL不可用，应继续降级
   */
  private isAbnormalUrl(url: string): boolean {
    if (!url) return true;
    const lower = url.toLowerCase();
    // 已知错误音频地址特征
    if (lower.includes('panspace.kuwo.cn')) return true;
    if (lower.includes('resource/214997273')) return true;
    // URL过短（正常播放链接不会短于20字符）
    if (url.length < 20) return true;
    return false;
  }

  // ===== 音频URL验证（HEAD/Range请求检测文件大小）(v1.9.0) =====

  /**
   * 兼容读取响应头（v1.9.0-beta.3）
   * QuickJS polyfill 的 Response.headers 可能不是标准 Headers 对象（没有 .get 方法），
   * 直接调 .get() 会抛 "TypeError: not a function"。
   * 本 helper 兼容三种形态：Headers 对象 / 普通对象 / undefined。
   */
  private _getHeader(resp: any, name: string): string {
    try {
      var h = resp && resp.headers;
      if (!h) return '';
      // 形态1: 标准 Headers 对象
      if (typeof h.get === 'function') {
        var v = h.get(name);
        if (v) return String(v);
      }
      // 形态2: 普通对象，按 key 不区分大小写遍历
      if (typeof h === 'object') {
        var lower = name.toLowerCase();
        var keys = Object.keys(h);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].toLowerCase() === lower) {
            return String(h[keys[i]] || '');
          }
        }
      }
    } catch (_e) { /* 忽略，返回空串 */ }
    return '';
  }

  /**
   * 验证音频URL的文件大小 (v1.9.0-beta.3 重写)
   * 主方法: GET + Range（GET 已验证可用，Range 让服务器只回1字节，省带宽）
   * 备方法: HEAD（部分 polyfill 不支持 HEAD method，仅作兜底）
   * 返回 { size: number | null, method: string, error?: string }
   * size 为 null 表示验证失败（不阻塞播放）
   */
  async verifyAudioSize(url: string): Promise<{ size: number | null; method: string; error?: string }> {
    // 方法1: GET + Range（首选）
    try {
      songloft.log.info('[LXClient] verifyAudioSize Range GET: ' + url.substring(0, 100));
      var rangeResp = await fetch(url, {
        method: 'GET',
        headers: { 'Range': 'bytes=0-0' },
      });
      var contentRange = this._getHeader(rangeResp, 'content-range');
      var contentLength = this._getHeader(rangeResp, 'content-length');

      // 消费body，防止连接泄漏（Range 206 时只有1字节；200 全量时较大但必要）
      try { await rangeResp.text(); } catch (_e) { /* 忽略 */ }

      songloft.log.info('[LXClient] Range result: status=' + rangeResp.status + ' content-range=' + contentRange + ' content-length=' + contentLength);

      // Content-Range 格式: "bytes 0-0/12345678" → 取总大小
      if (contentRange) {
        var match = contentRange.match(/\/(\d+)/);
        if (match && match[1]) {
          var size2 = parseInt(match[1], 10);
          if (!isNaN(size2) && size2 > 0) {
            return { size: size2, method: 'Range' };
          }
        }
      }

      // 某些服务器忽略 Range，返回 200 + 完整内容，用 Content-Length
      if (rangeResp.status === 200 && contentLength) {
        var size3 = parseInt(contentLength, 10);
        if (!isNaN(size3) && size3 > 0) {
          return { size: size3, method: 'Range-200' };
        }
      }

      songloft.log.warn('[LXClient] Range未能解析size, status=' + rangeResp.status);
    } catch (e: any) {
      songloft.log.warn('[LXClient] Range GET failed: ' + String(e));
    }

    // 方法2: HEAD（备选，部分 polyfill 不支持）
    try {
      songloft.log.info('[LXClient] verifyAudioSize HEAD: ' + url.substring(0, 100));
      var headResp = await fetch(url, {
        method: 'HEAD',
        headers: {},
      });
      var headLen = this._getHeader(headResp, 'content-length');

      songloft.log.info('[LXClient] HEAD result: status=' + headResp.status + ' content-length=' + headLen);

      if (headResp.status === 200 || headResp.status === 204) {
        var size = headLen ? parseInt(headLen, 10) : NaN;
        if (!isNaN(size) && size > 0) {
          return { size, method: 'HEAD' };
        }
      }
    } catch (e: any) {
      songloft.log.warn('[LXClient] HEAD request failed: ' + String(e));
    }

    return { size: null, method: 'none', error: 'Range和HEAD均未能获取文件大小' };
  }

  /**
   * 根据文件大小推算实际播放时长（秒）
   * v1.9.0: 结合音质信息推算，比固定阈值更准确
   */
  private estimateDurationFromFileSize(fileSize: number, quality?: string): number {
    var bytesPerSec = LXServerClient.BITRATE_MAP[quality || ''] || LXServerClient.BITRATE_MAP['128k'];
    return fileSize / bytesPerSec;
  }

  /**
   * 异步验证播放URL质量并更新黑名单
   * v1.9.0: 播放后异步调用，不阻塞播放
   * v1.9.0-beta.4: blacklistKey 由调用方传入完整key（Phase1用 source:songId，Phase0用 source:songId 或 cache:urlHash），避免内部拼接导致前缀重复
   * 对比文件大小推算的实际时长 vs 搜索结果标注时长
   */
  async verifyAndRecordQuality(
    url: string,
    source: string,
    blacklistKey: string,
    songName: string,
    songSinger: string,
    duration: number,
    quality: string
  ): Promise<void> {
    try {
      var result = await this.verifyAudioSize(url);
      if (result.size === null) {
        songloft.log.info('[Quality] Verify skipped: no size (' + result.method + ', ' + (result.error || 'unknown') + ')');
        return;
      }

      var actualDuration = this.estimateDurationFromFileSize(result.size, quality);
      songloft.log.info('[Quality] ' + songName + ' - ' + songSinger + ': size=' + (result.size / 1024).toFixed(1) + 'KB actualDur=' + actualDuration.toFixed(1) + 's labeledDur=' + duration + 's quality=' + quality);

      var reason: QualityBlacklistReason | null = null;

      if (duration > 0) {
        // 有标注时长，用比例对比
        if (actualDuration < duration * 0.5) {
          reason = 'clip';
          songloft.log.warn('[Quality] CLIP detected: actual ' + actualDuration.toFixed(1) + 's vs labeled ' + duration + 's (' + (actualDuration / duration * 100).toFixed(0) + '%)');
        } else if (actualDuration > duration * 1.5) {
          reason = 'mix';
          songloft.log.warn('[Quality] MIX detected: actual ' + actualDuration.toFixed(1) + 's vs labeled ' + duration + 's (' + (actualDuration / duration * 100).toFixed(0) + '%)');
        }
      } else {
        // 没有标注时长，用绝对值兜底
        if (actualDuration < 60) {
          reason = 'clip';
          songloft.log.warn('[Quality] CLIP detected (no label): actual ' + actualDuration.toFixed(1) + 's < 60s');
        }
      }

      if (reason) {
        var entry: QualityBlacklistEntry = {
          urlHash: this.urlHash(url),
          nameKey: (songName + '|' + songSinger).toLowerCase().trim(),
          reason: reason,
          duration: duration,
          actualDuration: Math.round(actualDuration),
          quality: quality || '128k',
          timestamp: Date.now(),
        };
        await this.configManager.addToBlacklist(blacklistKey, entry);
        // v1.9.0: 写入降级日志，前端可查
        try {
          await this.configManager.addFallbackLog({
            query: songName + ' - ' + songSinger,
            attemptedSources: [source],
            finalSource: source,
            finalQuality: quality,
            downgradeReason: '⚠ ' + (reason === 'clip' ? '片段' : '串烧') + ': ' + songName + ' - ' + songSinger + ' (实际' + Math.round(actualDuration) + 's vs 标注' + duration + 's, ' + (result.size! / 1024).toFixed(0) + 'KB)',
            timestamp: new Date().toISOString(),
          });
        } catch (_e) { /* 忽略日志写入失败 */ }
      } else {
        songloft.log.info('[Quality] Normal: ' + songName + ' - ' + songSinger);
      }
    } catch (e: any) {
      songloft.log.warn('[Quality] Verify error: ' + String(e));
    }
  }

  // ===== 搜索结果匹配度评分 (v1.8.22, v1.9.0增强) =====

  /**
   * 计算搜索结果与目标歌曲的匹配度分数
   * v1.8.22: 基础评分（标题+歌手匹配）
   * v1.9.0: 新增时长加分(+10)、关键词加分(+5)、收藏加分(+10)
   */
  private matchScore(song: LXSearchResult, titleHint?: string, artistHint?: string): number {
    if (!titleHint && !artistHint) return 50; // 无hint时默认中等分数

    var score = 0;
    var titleLower = (song.name || '').toLowerCase().trim();
    var artistLower = (song.singer || '').toLowerCase().trim();
    var hintTitle = (titleHint || '').toLowerCase().trim();
    var hintArtist = (artistHint || '').toLowerCase().trim();

    // 标题完全匹配 +40分
    if (hintTitle && titleLower === hintTitle) {
      score += 40;
    } else if (hintTitle && titleLower.includes(hintTitle)) {
      // 标题包含hint +20分
      score += 20;
    } else if (hintTitle && hintTitle.includes(titleLower) && titleLower.length > 1) {
      // 标题被hint包含 +10分
      score += 10;
    }

    // 歌手完全匹配 +40分
    if (hintArtist && artistLower === hintArtist) {
      score += 40;
    } else if (hintArtist && artistLower.includes(hintArtist)) {
      // 歌手包含hint +15分
      score += 15;
    } else if (hintArtist && hintArtist.includes(artistLower) && artistLower.length > 1) {
      // 歌手被hint包含 +5分
      score += 5;
    }

    // v1.9.0: 时长加分 — 正常时长(90s~600s) +10
    var duration = song.duration || 0;
    if (duration >= 90 && duration <= 600) {
      score += 10;
    }
    // 时长<90s或>600s或缺失: +0（不加分也不扣分）

    // v1.9.0: 关键词加分 — 歌名不含异常关键词 +5
    var hasClipKeyword = false;
    var nameLower = (song.name || '').toLowerCase();
    for (var ki = 0; ki < LXServerClient.CLIP_KEYWORDS.length; ki++) {
      if (nameLower.includes(LXServerClient.CLIP_KEYWORDS[ki].toLowerCase())) {
        hasClipKeyword = true;
        break;
      }
    }
    if (!hasClipKeyword) {
      score += 5;
    }

    // v1.9.0: 收藏加分 — 收藏列表中有这首歌 +10
    var favKey = ((song.name || '') + '|' + (song.singer || '')).toLowerCase().trim();
    if (this.favoriteCache.has(favKey)) {
      score += 10;
    }

    return Math.min(150, score); // 上限从100提高到150（原有100 + 新增25）
  }

  // ===== 缓存查询 (v1.8.22) =====

  /**
   * 查询lxserver缓存：按歌名+歌手匹配已缓存歌曲
   * 返回缓存URL或null
   */
  async cacheCheck(name: string, singer: string): Promise<{ url: string; duration: number; name: string; singer: string; source: string; songId: string } | null> {
    try {
      if (!this.config) await this.init();
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      songloft.log.info('[LXClient] cacheCheck: ' + name + ' - ' + singer);

      const resp = await fetch(baseUrl + '/api/music/cache/list', {
        method: 'GET',
        headers: {
          'x-user-token': token,
          'x-user-name': this.config!.username,
        },
      });

      if (!resp.ok) {
        songloft.log.warn('[LXClient] cacheCheck failed: HTTP ' + resp.status);
        return null;
      }

      const text = await resp.text();
      var data: any;
      try {
        data = JSON.parse(text);
      } catch (e) {
        songloft.log.warn('[LXClient] cacheCheck parse error');
        return null;
      }

      // 解析缓存列表（lxserver 可能返回多种格式）
      var list: any[] = [];
      if (Array.isArray(data)) {
        list = data;
      } else if (data.data && Array.isArray(data.data)) {
        list = data.data;
      } else if (data.list && Array.isArray(data.list)) {
        list = data.list;
      }

      // v1.9.0-beta.4: 打印首条缓存项的字段名，确认是否有 songmid/id 可用作统一黑名单key
      if (list.length > 0) {
        songloft.log.info('[LXClient] cache item keys: ' + Object.keys(list[0] || {}).join(','));
        songloft.log.info('[LXClient] cache item[0] sample: ' + JSON.stringify(list[0]).substring(0, 300));
      } else {
        songloft.log.info('[LXClient] cache list empty');
      }

      // 按歌名+歌手精确匹配
      var nameLower = (name || '').toLowerCase().trim();
      var singerLower = (singer || '').toLowerCase().trim();

      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var itemName = (item.name || item.title || '').toLowerCase().trim();
        var itemSinger = (item.singer || item.artist || '').toLowerCase().trim();
        if (itemName === nameLower && itemSinger === singerLower && item.url) {
          // 提取缓存项ID（如果存在），用于统一黑名单key
          var cacheSongId = String(item.songmid || item.songId || item.id || '');
          songloft.log.info('[LXClient] ✓ Cache hit: ' + name + ' - ' + singer + ' (cacheSongId=' + (cacheSongId || 'none') + ')');
          // 解析缓存项时长 "02:52" → 172秒
          var cacheDuration = 0;
          var cacheInterval = item.interval || item.duration || '';
          var cacheParts = String(cacheInterval).split(':');
          if (cacheParts.length === 2) cacheDuration = parseInt(cacheParts[0]) * 60 + parseInt(cacheParts[1]);
          else if (parseInt(String(cacheInterval)) > 0) cacheDuration = parseInt(String(cacheInterval));
          return {
            url: item.url,
            duration: cacheDuration,
            name: name,
            singer: singer,
            source: item.source || 'cache',
            songId: cacheSongId,
          };
        }
      }

      songloft.log.info('[LXClient] Cache miss: ' + name + ' - ' + singer + ' (checked ' + list.length + ' items)');
      return null;
    } catch (e) {
      songloft.log.warn('[LXClient] cacheCheck error: ' + String(e));
      return null;
    }
  }

  // ===== 获取播放URL =====

  /**
   * 获取歌曲播放直链
   * 参考 songloft-lx-sync-server 实现：直接传递完整的 lxserver songInfo
   * v1.8.22: 新增异常URL检测，返回前验证URL可用性
   */
  async getSongUrl(params: LXUrlParams): Promise<UrlResolutionResult> {
    const token = await this.getToken();
    const baseUrl = this.getBaseUrl();

    // 优先使用 _raw 字段（完整的 lxserver 原始响应）
    let songInfo: any;
    if (params._raw) {
      songInfo = params._raw;
      songloft.log.info('[LXClient] Using _raw songInfo from search results');
    } else {
      // Fallback: 构建基础 songInfo（兼容旧代码）
      songInfo = {
        id: params.id,
        source: params.source,
        songmid: params.id,
        name: params.name,
        singer: params.singer,
      };
      songloft.log.info('[LXClient] Using constructed songInfo (no _raw available)');
    }

    const body = JSON.stringify({
      songInfo: songInfo,
      quality: params.type || '128k',
      enableAutoSwitchApiSource: true,
    });

    songloft.log.info('[LXClient] getSongUrl request: POST ' + baseUrl + '/api/music/url');
    songloft.log.info('[LXClient] getSongUrl body preview: ' + body.substring(0, 200) + '...');

    const resp = await fetch(baseUrl + '/api/music/url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-token': token,
        'x-user-name': this.config!.username,
      },
      body,
    });

    const text = await resp.text();
    songloft.log.info('[LXClient] getSongUrl response: HTTP=' + resp.status + ' body=' + text.substring(0, 500));

    if (!resp.ok) {
      const classification = FailureClassifier.classify(text.substring(0, 300), resp.status);
      songloft.log.warn('[LXClient] getSongUrl failed: HTTP ' + resp.status + ' category=' + classification.category + ' confidence=' + classification.confidence);
      return {
        url: null,
        failureText: text.substring(0, 300),
        blocked: classification.category === 'platform_block',
        failureClassification: classification,
      };
    }

    try {
      const data: any = JSON.parse(text);
      songloft.log.info('[LXClient] getSongUrl parsed data keys: ' + Object.keys(data).join(', '));

      // v2.1.0: 提取自定义源名称
      const customSourceName = data.sourceName || '';

      if (data.url) {
        // v1.8.22: 异常URL检测 — 报错音频URL视为无效
        if (this.isAbnormalUrl(data.url)) {
          songloft.log.warn('[LXClient] ✗ Abnormal URL detected: ' + data.url.substring(0, 100));
          return {
            url: null,
            customSourceName,
            failureText: 'abnormal url',
            failureClassification: FailureClassifier.classify('', 0, 'invalid_url'),
          };
        }
        songloft.log.info('[LXClient] ✓ Got URL: ' + data.url.substring(0, 100) + '...');
        return { url: data.url, customSourceName };
      }

      // 可能的其他字段
      if (data.data && data.data.url) {
        // v1.8.22: 异常URL检测
        if (this.isAbnormalUrl(data.data.url)) {
          songloft.log.warn('[LXClient] ✗ Abnormal URL detected (data.data): ' + data.data.url.substring(0, 100));
          return {
            url: null,
            customSourceName,
            failureText: 'abnormal url',
            failureClassification: FailureClassifier.classify('', 0, 'invalid_url'),
          };
        }
        songloft.log.info('[LXClient] ✓ Got URL from data.url: ' + data.data.url.substring(0, 100) + '...');
        return { url: data.data.url, customSourceName };
      }

      songloft.log.warn('[LXClient] ✗ No url in response, full response: ' + text.substring(0, 300));
      const classification = FailureClassifier.classify(text.substring(0, 300), resp.status);
      return {
        url: null,
        customSourceName,
        failureText: text.substring(0, 300),
        blocked: classification.category === 'platform_block',
        failureClassification: classification,
      };
    } catch (e) {
      songloft.log.warn('[LXClient] Parse error: ' + String(e));
      return {
        url: null,
        customSourceName: '',
        failureText: String(e),
        failureClassification: FailureClassifier.classify(String(e)),
      };
    }
  }

  // ===== 获取歌词 =====

  async getLyric(params: LXLyricParams): Promise<string | null> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      const body = JSON.stringify({
        id: params.id,
        source: params.source,
      });

      const resp = await fetch(baseUrl + '/api/music/lyric', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-token': token,
          'x-user-name': this.config!.username,
        },
        body,
      });

      if (!resp.ok) return null;

      const text = await resp.text();
      const data: LXLyricResponse = JSON.parse(text);
      if (data.success && data.data && data.data.lyric) {
        return data.data.lyric;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ===== 获取Web播放器地址 =====

  getWebPlayerUrl(): string {
    if (this.config?.webPlayerUrl) {
      return this.config.webPlayerUrl;
    }
    // Fallback: 使用 lxserver 地址 + /player
    if (this.config?.host) {
      return this.config.host.replace(/\/+$/, '') + '/player';
    }
    return '';
  }

  // ===== 获取收藏列表 =====

  /**
   * 获取用户收藏歌曲列表
   */
  async getFavorites(): Promise<LXFavoriteItem[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      songloft.log.info('[LXClient] Fetching favorites from ' + baseUrl + '/api/user/list');

      const resp = await fetch(baseUrl + '/api/user/list', {
        method: 'GET',
        headers: {
          'x-user-token': token,
          'x-user-name': this.config!.username,
        },
      });

      if (!resp.ok) {
        songloft.log.warn('[LXClient] Get favorites failed: HTTP ' + resp.status);
        return [];
      }

      const text = await resp.text();
      songloft.log.info('[LXClient] ========== /api/user/list 原始响应 ==========');
      songloft.log.info('[LXClient] 完整文本长度: ' + text.length);
      songloft.log.info('[LXClient] 前1000字符: ' + text.substring(0, 1000));
      const data: any = JSON.parse(text);

      songloft.log.info('[LXClient] 顶层 keys: ' + Object.keys(data).join(', '));
      // 遍历每个key，输出类型和简要信息
      for (const key of Object.keys(data)) {
        const val = data[key];
        const type = Array.isArray(val) ? 'array[' + val.length + ']' : typeof val;
        songloft.log.info('[LXClient]   ' + key + ': ' + type);
        if (Array.isArray(val) && val.length > 0) {
          songloft.log.info('[LXClient]   ' + key + '[0] keys: ' + Object.keys(val[0] || {}).join(', '));
          songloft.log.info('[LXClient]   ' + key + '[0]: ' + JSON.stringify(val[0]).substring(0, 300));
        } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          songloft.log.info('[LXClient]   ' + key + ' keys: ' + Object.keys(val).join(', '));
        }
      }

      if (data.defaultList && Array.isArray(data.defaultList)) {
        songloft.log.info('[LXClient] Got ' + data.defaultList.length + ' favorites from defaultList');
        return data.defaultList;
      }

      // 尝试其他可能的字段
      if (data.list && Array.isArray(data.list)) {
        songloft.log.info('[LXClient] Got ' + data.list.length + ' favorites from list');
        return data.list;
      }

      if (Array.isArray(data)) {
        songloft.log.info('[LXClient] Got ' + data.length + ' favorites from root array');
        return data;
      }

      songloft.log.warn('[LXClient] No favorites found in response, data structure: ' + JSON.stringify(data).substring(0, 200));
      return [];
    } catch (e: any) {
      songloft.log.warn('[LXClient] Get favorites error: ' + String(e));
      return [];
    }
  }

  /**
   * 获取用户所有歌单 (v1.5.0)
   * 包含：试听列表(defaultList)、我的收藏(loveList)、自定义歌单(userList)
   */
  async getPlaylists(): Promise<LxPlaylist[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      songloft.log.info('[LXClient] Fetching playlists from ' + baseUrl + '/api/user/list');

      const resp = await fetch(baseUrl + '/api/user/list', {
        method: 'GET',
        headers: {
          'x-user-token': token,
          'x-user-name': this.config!.username,
        },
      });

      if (!resp.ok) {
        songloft.log.warn('[LXClient] Get playlists failed: HTTP ' + resp.status);
        return [];
      }

      const text = await resp.text();
      songloft.log.info('[LXClient] Playlists response length: ' + text.length);
      const data: any = JSON.parse(text);
      songloft.log.info('[LXClient] Playlists data keys: ' + Object.keys(data).join(', '));

      const playlists: LxPlaylist[] = [];

      // 1. 试听列表 (defaultList)
      if (Array.isArray(data.defaultList)) {
        playlists.push({
          id: 'default',
          name: '试听列表',
          system: true,
          songs: data.defaultList,
          songCount: data.defaultList.length
        });
      }

      // 2. 我的收藏 (loveList)
      if (Array.isArray(data.loveList)) {
        playlists.push({
          id: 'love',
          name: '我的收藏',
          system: true,
          songs: data.loveList,
          songCount: data.loveList.length
        });
      }

      // 3. 自定义歌单 (userList)
      const userLists = Array.isArray(data.userList) ? data.userList : [];
      for (const list of userLists) {
        const songs = Array.isArray(list.list) ? list.list : [];
        playlists.push({
          id: String(list.id || list.name || ''),
          name: list.name || String(list.id || '未命名'),
          system: false,
          songs,
          songCount: songs.length
        });
      }

      // 兼容旧格式：如果以上都没有，回退到 data.defaultList/data.list/data 数组
      if (playlists.length === 0) {
        const songs = Array.isArray(data.defaultList) ? data.defaultList
          : Array.isArray(data.list) ? data.list
          : Array.isArray(data) ? data
          : [];

        if (songs.length > 0) {
          playlists.push({
            id: 'love',
            name: '我的收藏',
            system: true,
            songs,
            songCount: songs.length
          });
        }
      }

      songloft.log.info('[LXClient] Built ' + playlists.length + ' playlists: ' +
        playlists.map(p => p.name + '(' + p.songCount + ')').join(', '));
      return playlists;
    } catch (e: any) {
      songloft.log.warn('[LXClient] Get playlists error: ' + String(e));
      return [];
    }
  }

  // ===== 搜索联想 (v1.5.1) =====
  async searchSuggest(keyword: string): Promise<string[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      const url = baseUrl + '/api/music/tipSearch?name=' + encodeURIComponent(keyword);
      const resp = await fetch(url, {
        headers: { 'x-user-token': token, 'x-user-name': this.config!.username },
      });
      if (!resp.ok) return [];
      const data: any = JSON.parse(await resp.text());
      return Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
    } catch (e: any) {
      songloft.log.warn('[LXClient] searchSuggest error: ' + String(e));
      return [];
    }
  }

  // ===== 热搜榜 (v1.5.1) =====
  async hotSearch(source?: string): Promise<any[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      let url = baseUrl + '/api/music/hotSearch';
      if (source) url += '?source=' + encodeURIComponent(source);
      const resp = await fetch(url, {
        headers: { 'x-user-token': token, 'x-user-name': this.config!.username },
      });
      songloft.log.info('[LXClient] hotSearch HTTP: ' + resp.status);
      const text = await resp.text();
      songloft.log.info('[LXClient] hotSearch raw: ' + text.substring(0, 1000));
      const data: any = JSON.parse(text);
      // 格式可能是: {source, list:[...]} 或 数组 或 {data:[...]}
      const result = Array.isArray(data.list) ? data.list
        : Array.isArray(data) ? data
        : Array.isArray(data.data) ? data.data
        : [];
      songloft.log.info('[LXClient] hotSearch result count: ' + result.length);
      return result;
    } catch (e: any) {
      songloft.log.warn('[LXClient] hotSearch error: ' + String(e));
      return [];
    }
  }

  // ===== 歌单标签 + 详情 (v1.6.0) =====
  async getSongListTags(source: string): Promise<any> {
    return this.simpleGet('/api/music/songList/tags?source=' + source);
  }
  async getSongLists(source: string, tagId: string, sortId?: string, page?: number, limit?: number): Promise<any> {
    var url = '/api/music/songList/list?source=' + source + '&tagId=' + encodeURIComponent(tagId);
    if (sortId) url += '&sortId=' + sortId;
    if (page) url += '&page=' + page;
    if (limit) url += '&limit=' + limit;
    return this.simpleGet(url);
  }
  async getSongListDetail(source: string, id: string): Promise<any> {
    return this.simpleGet('/api/music/songList/detail?source=' + source + '&id=' + encodeURIComponent(id));
  }

  // ===== 排行榜 (v1.6.0) =====
  async getLeaderboardBoards(source: string): Promise<any> {
    return this.simpleGet('/api/music/leaderboard/boards?source=' + source);
  }
  async getLeaderboardList(source: string, bangid: string): Promise<any> {
    return this.simpleGet('/api/music/leaderboard/list?source=' + source + '&bangid=' + encodeURIComponent(bangid));
  }

  // 通用GET请求
  async simpleGet(path: string): Promise<any> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      const resp = await fetch(baseUrl + path, {
        headers: { 'x-user-token': token, 'x-user-name': this.config!.username },
      });
      if (!resp.ok) return {};
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e: any) {
      songloft.log.warn('[LXClient] simpleGet ' + path + ': ' + String(e));
      return {};
    }
  }

  // ===== 自定义源管理 (v2.1.0) =====

  async getCustomSources(): Promise<any[]> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      const username = this.config!.username;
      const resp = await fetch(
        baseUrl + '/api/custom-source/list?username=' + encodeURIComponent(username),
        { headers: { 'x-user-token': token, 'x-user-name': username } },
      );
      const rawText = await resp.text();
      if (!resp.ok) {
        songloft.log.warn('[LXClient] getCustomSources failed: status=' + resp.status);
        return [];
      }

      const sources = extractCustomSources(JSON.parse(rawText));
      songloft.log.info(
        '[LXClient] getCustomSources: count=' + sources.length + ' status=' + resp.status,
      );
      return sources;
    } catch (e: any) {
      songloft.log.warn('[LXClient] getCustomSources error: ' + String(e));
      return [];
    }
  }

  async toggleCustomSource(name: string, enabled?: boolean): Promise<boolean> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      const username = this.config!.username;
      songloft.log.info('[LXClient] toggleCustomSource: sourceId=' + name + ' enabled=' + enabled);
      
      // lxserver toggle API需要: { username, sourceId, enabled, allowUnsafeVM }
      const toggleUrl = baseUrl + '/api/custom-source/toggle?username=' + encodeURIComponent(username);
      const body = { username: username, sourceId: name, enabled: enabled, allowUnsafeVM: false };
      
      // 先尝试用户token
      let resp = await fetch(toggleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-token': token,
          'x-user-name': username,
        },
        body: JSON.stringify(body),
      });
      
      // 如果失败，尝试管理员权限
      if (!resp.ok) {
        songloft.log.info('[LXClient] toggleCustomSource: 用户token失败，尝试x-frontend-auth...');
        resp = await fetch(toggleUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-frontend-auth': this.config!.password,
          },
          body: JSON.stringify(body),
        });
      }
      
      const rawText = await resp.text();
      songloft.log.info('[LXClient] toggleCustomSource: status=' + resp.status + ' response=' + rawText);
      return resp.ok;
    } catch (e: any) {
      songloft.log.warn('[LXClient] toggleCustomSource error: ' + String(e));
      return false;
    }
  }

  async reorderCustomSources(ids: string[]): Promise<boolean> {
    try {
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();
      const username = this.config!.username;
      const reorderUrl = baseUrl + '/api/custom-source/reorder?username=' + encodeURIComponent(username);
      songloft.log.info('[LXClient] reorderCustomSources: ids=' + JSON.stringify(ids));
      
      // lxserver期望 body: { sourceIds: [...], username: "..." }
      const body = { sourceIds: ids, username: username };
      
      // 先尝试用户token
      let resp = await fetch(reorderUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-token': token,
          'x-user-name': username,
        },
        body: JSON.stringify(body),
      });
      
      // 如果失败，尝试管理员权限
      if (!resp.ok) {
        songloft.log.info('[LXClient] reorderCustomSources: 用户token失败，尝试x-frontend-auth...');
        resp = await fetch(reorderUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-frontend-auth': this.config!.password,
          },
          body: JSON.stringify(body),
        });
      }
      
      const rawText = await resp.text();
      songloft.log.info('[LXClient] reorderCustomSources: status=' + resp.status + ' response=' + rawText);
      return resp.ok;
    } catch (e: any) {
      songloft.log.warn('[LXClient] reorderCustomSources error: ' + String(e));
      return false;
    }
  }

  // ===== 降级搜索：按优先级链依次尝试获取可播放URL =====

  /**
   * 智能搜索 + 降级获取URL
   * v1.9.0: 黑名单过滤 + 流水线取URL + 播放后异步验证
   * v1.8.22: 缓存优先(Phase0) → 内置源(Phase1,匹配度排序) → 自定义源(Phase2) → 降音质(Phase3) → 模糊匹配(Phase4)
   */
  async searchWithFallback(
    keywords: string,
    titleHint?: string,
    artistHint?: string,
    preferredSource?: string
  ): Promise<FallbackSearchResult> {
    const requestKey = ((titleHint || keywords) + '|' + (artistHint || '')).toLowerCase().trim();
    const existing = LXServerClient.fallbackInflight[requestKey];
    if (existing) {
      songloft.log.info('[FallbackV22] Reusing in-flight request: key=' + requestKey);
      return existing;
    }

    const task = this.runSearchWithFallback(keywords, titleHint, artistHint, preferredSource);
    LXServerClient.fallbackInflight[requestKey] = task;
    try {
      return await task;
    } finally {
      delete LXServerClient.fallbackInflight[requestKey];
    }
  }

  private async runSearchWithFallback(
    keywords: string,
    titleHint?: string,
    artistHint?: string,
    preferredSource?: string
  ): Promise<FallbackSearchResult> {
    if (!this.config) await this.init();

    const config = this.config!;
    const fallbackSteps: string[] = [];
    const searchKeyword = titleHint ? (titleHint + ' ' + (artistHint || '')).trim() : keywords;
    const requestId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);
    const startedAt = Date.now();
    let attempts = 0;

    const finish = (song: LXSearchResult | null, url: string | null, source: string, quality: string, failureReason?: string, failureClassification?: FailureClassification): FallbackSearchResult => {
      const elapsedMs = Date.now() - startedAt;
      const summary = '[FallbackV22][' + requestId + '] done success=' + !!url + ' attempts=' + attempts + ' elapsedMs=' + elapsedMs + (failureReason ? ' reason=' + failureReason : '');
      songloft.log.info(summary);
      fallbackSteps.push('V22总结: ' + (url ? '成功' : '失败') + '；URL解析' + attempts + '/' + LXServerClient.FALLBACK_MAX_URL_ATTEMPTS + '次；耗时' + elapsedMs + 'ms' + (failureReason ? '；原因=' + failureReason : ''));
      return { song, url, source, quality, fallbackSteps, requestId, attempts, elapsedMs, failureReason, failureClassification };
    };

    fallbackSteps.push('V22请求: ' + requestId + '；预算10秒/8次；每批最多2个并行');
    songloft.log.info('[FallbackV22][' + requestId + '] start keyword="' + searchKeyword + '"');

    // ===== Phase0: 缓存优先 + 黑名单检查 (v1.9.0) =====
    if (titleHint || keywords) {
      var cacheName = titleHint || keywords.split(' ')[0];
      var cacheSinger = artistHint || keywords.split(' ').slice(1).join(' ');
      fallbackSteps.push('Phase0: 查询缓存');
      songloft.log.info('[searchWithFallback][Phase0] 查询lxserver缓存: name="' + cacheName + '" singer="' + cacheSinger + '"');
      var cacheHit = await this.cacheCheck(cacheName, cacheSinger);
      var cachedUrl = cacheHit ? cacheHit.url : null;
      songloft.log.info('[searchWithFallback][Phase0] cacheCheck返回: ' + (cachedUrl ? ('hit url=' + cachedUrl.substring(0, 80) + '... dur=' + cacheHit!.duration + 's songId=' + (cacheHit!.songId || 'none')) : 'null'));
      if (cachedUrl && !this.isAbnormalUrl(cachedUrl)) {
        // v1.9.0-beta.4: 黑名单key优先用 source:songId（与Phase1统一），无ID时退化用 urlHash
        var cacheHash = this.urlHash(cachedUrl);
        var cacheSongId = cacheHit!.songId;
        var cacheBlacklistKey = (cacheSongId && cacheHit!.source && cacheHit!.source !== 'cache')
          ? (cacheHit!.source + ':' + cacheSongId)
          : ('cache:' + cacheHash);
        var cacheBlacklisted = await this.configManager.isBlacklisted(cacheBlacklistKey);
        // source:songId 查不到时，再用 urlHash 兜底查一次（兼容旧条目/无ID缓存）
        if (!cacheBlacklisted) {
          cacheBlacklisted = await this.configManager.isUrlBlacklisted(cacheHash);
          if (cacheBlacklisted) cacheBlacklistKey = 'cache:' + cacheHash;
        }
        songloft.log.info('[searchWithFallback][Phase0] 缓存命中, blacklistKey=' + cacheBlacklistKey + ' urlHash=' + cacheHash + ' 黑名单命中=' + cacheBlacklisted);
        if (cacheBlacklisted) {
          // 命中黑名单：记录二次命中(用于续期)，然后跳过缓存走重新搜索
          this.configManager.touchBlacklistHit(cacheHash).catch(function() {});
          fallbackSteps.push('⚠ 缓存命中但URL在黑名单中，跳过缓存');
          songloft.log.info('[LXClient] Phase0 cache hit but blacklisted: ' + cacheName + ' - ' + cacheSinger);
        } else {
          fallbackSteps.push('✓ 缓存命中');
          songloft.log.info('[LXClient] Phase0 cache hit: ' + cacheName + ' - ' + cacheSinger);
          songloft.log.info('[searchWithFallback] ===== 命中缓存直接返回, url=' + cachedUrl.substring(0, 80) + ' =====');
          // 缓存命中也异步验证质量(返回完整item含时长，可识别缓存里的片段)
          var cacheSongName = cacheHit!.name;
          var cacheSongSinger = cacheHit!.singer;
          var cacheSongDuration = cacheHit!.duration;
          var cacheSongSource = cacheHit!.source;
          this.verifyAndRecordQuality(
            cachedUrl, cacheSongSource, cacheBlacklistKey,
            cacheSongName, cacheSongSinger, cacheSongDuration, '128k'
          ).catch(function(e: any) {
            songloft.log.warn('[LXClient] Cache async quality verify failed: ' + String(e));
          });
          return finish(
            { id: cacheSongId || 'cached', name: cacheName, singer: cacheSinger, source: 'cache', duration: cacheSongDuration, album: '', cover: '', quality: '', _raw: null },
            cachedUrl,
            'cache',
            'cached'
          );
        }
      }
      fallbackSteps.push('缓存未命中');
      songloft.log.info('[searchWithFallback][Phase0] 缓存未命中, 进入Phase1');
    }

    const builtinSources = config.sourcePriority.filter(function(source) {
      return ['kw', 'kg', 'tx', 'wy', 'mg'].includes(source);
    });
    if (preferredSource && builtinSources.includes(preferredSource)) {
      builtinSources.splice(builtinSources.indexOf(preferredSource), 1);
      builtinSources.unshift(preferredSource);
      fallbackSteps.push('使用优选音源: ' + preferredSource);
    }

    fallbackSteps.push('搜索: 内置平台(' + builtinSources.join(',') + ')');
    let candidates = await this.searchMultiSource(searchKeyword, builtinSources, config.searchTimeout * 1000);
    if (candidates.length === 0 && config.enableFuzzyMatch && titleHint) {
      fallbackSteps.push('搜索无候选，使用模糊关键词: ' + titleHint);
      candidates = await this.searchMultiSource(titleHint, builtinSources, config.searchTimeout * 1000);
    }
    if (candidates.length === 0) {
      return finish(null, null, '', '', '搜索无候选');
    }

    const blacklist = await this.configManager.getQualityBlacklist();
    candidates = candidates.filter(function(candidate) {
      return !(candidate.source + ':' + candidate.id in blacklist);
    });
    candidates.sort((left, right) => this.matchScore(right, titleHint, artistHint) - this.matchScore(left, titleHint, artistHint));
    fallbackSteps.push('搜索完成: ' + candidates.length + '条候选');

    const usedCandidates = new Set<string>();
    const usedSongVersions = new Set<string>();
    const blockedPlatforms = new Set<string>();
    const canContinue = () => attempts < LXServerClient.FALLBACK_MAX_URL_ATTEMPTS && Date.now() - startedAt < LXServerClient.FALLBACK_TIMEOUT_MS;
    const tryBatch = async (batchName: string, batch: Array<{ song: LXSearchResult; quality: string }>): Promise<FallbackSearchResult | null> => {
      if (!canContinue()) return null;
      const selected = await selectRunnableFallbackBatch({
        batch,
        maxConcurrent: LXServerClient.FALLBACK_MAX_CONCURRENT_URLS,
        usedCandidates,
        blockedPlatforms,
        getCooldownRemaining: source => this.configManager.getPlatformCooldownRemaining(source),
      });
      for (let index = 0; index < selected.skippedCooldowns.length; index++) {
        const skipped = selected.skippedCooldowns[index];
        fallbackSteps.push('跳过冷却平台: ' + skipped.source + '（剩余' + Math.ceil(skipped.remainingMs / 1000) + '秒）');
      }
      const runnable = selected.runnable;
      for (let index = 0; index < runnable.length; index++) {
        const item = runnable[index];
        usedSongVersions.add(item.song.source + ':' + item.song.id);
      }
      if (runnable.length === 0) return null;

      attempts += runnable.length;
      fallbackSteps.push(batchName + ': 并行解析 ' + runnable.map(function(item) { return item.song.source + '/' + item.quality; }).join(' + '));
      songloft.log.info('[FallbackV22][' + requestId + '] ' + batchName + ' attempts=' + attempts + ' candidates=' + runnable.map(function(item) { return item.song.source + '/' + item.song.name + '/' + item.quality; }).join(' | '));

      const pending = runnable.map(async (item, index) => {
        const result = await this.scheduleUrlResolution(() => this.getSongUrl({
          id: item.song.id,
          source: item.song.source,
          type: item.quality,
          name: item.song.name,
          singer: item.song.singer,
          _raw: item.song._raw,
        }));
        return { index, item, result };
      });
      const unresolved = new Set<number>();
      for (let index = 0; index < pending.length; index++) unresolved.add(index);

      while (unresolved.size > 0) {
        const remainingMs = LXServerClient.FALLBACK_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          return finish(null, null, '', '', '10秒预算耗尽');
        }

        let deadlineTimer: any;
        const deadline = new Promise<{ timedOut: true }>(function(resolve) {
          deadlineTimer = setTimeout(function() { resolve({ timedOut: true }); }, remainingMs);
        });
        const outcome = await Promise.race([
          ...Array.from(unresolved).map(function(index) { return pending[index]; }),
          deadline,
        ]);
        clearTimeout(deadlineTimer);
        if ('timedOut' in outcome) {
          return finish(null, null, '', '', '10秒预算耗尽');
        }
        unresolved.delete(outcome.index);
        if (outcome.result.blocked) {
          await this.configManager.recordPlatformBlock(outcome.item.song.source);
          blockedPlatforms.add(outcome.item.song.source);
          fallbackSteps.push('block ip: ' + outcome.item.song.source + '；平台冷却15分钟');
        }
        if (outcome.result.customSourceName) {
          await this.configManager.recordCustomSourceResult(outcome.result.customSourceName, outcome.item.song.source, !!outcome.result.url);
        }
        const classification = outcome.result.failureClassification;
        if (classification) {
          fallbackSteps.push('失败分类: ' + classification.category);
          if (classification.action === 'skip') {
            fallbackSteps.push('无效音频地址，跳过当前候选');
          } else if (classification.action === 'stop') {
            fallbackSteps.push('认证或配置错误，停止后续URL解析');
            return finish(null, null, '', '', classification.failureReason, classification);
          }
        }
        if (outcome.result.url && !this.isAbnormalUrl(outcome.result.url)) {
          fallbackSteps.push('✓ 成功: ' + outcome.item.song.source + '/' + outcome.item.quality);
          this.verifyAndRecordQuality(
            outcome.result.url,
            outcome.item.song.source,
            outcome.item.song.source + ':' + outcome.item.song.id,
            outcome.item.song.name,
            outcome.item.song.singer,
            outcome.item.song.duration || 0,
            outcome.item.quality
          ).catch(function() {});
          return finish(outcome.item.song, outcome.result.url, outcome.item.song.source, outcome.item.quality);
        }
        fallbackSteps.push('✗ 失败: ' + outcome.item.song.source + '/' + outcome.item.quality + (outcome.result.blocked ? '（block ip）' : ''));
      }
      return null;
    };

    const pickByPlatform = (excluded: Set<string>, limit: number): LXSearchResult[] => {
      const selected: LXSearchResult[] = [];
      const platforms = new Set<string>();
      for (let index = 0; index < candidates.length && selected.length < limit; index++) {
        const candidate = candidates[index];
        if (excluded.has(candidate.source) || platforms.has(candidate.source)) continue;
        selected.push(candidate);
        platforms.add(candidate.source);
      }
      return selected;
    };

    const batch1 = pickByPlatform(new Set<string>(), 2).map(function(song) { return { song, quality: config.defaultQuality }; });
    let success = await tryBatch('第1批', batch1);
    if (success) return success;

    const firstPlatforms = new Set(batch1.map(function(item) { return item.song.source; }));
    const batch2 = pickByPlatform(firstPlatforms, 2).map(function(song) { return { song, quality: config.defaultQuality }; });
    success = await tryBatch('第2批', batch2);
    if (success) return success;

    const allBatchPlatforms = new Set<string>(batch1.concat(batch2).map(function(item) { return item.song.source; }));
    const batch3 = pickByPlatform(allBatchPlatforms, 1).map(function(song) { return { song, quality: config.defaultQuality }; });
    for (let index = 0; index < candidates.length && batch3.length < 2; index++) {
      const candidate = candidates[index];
      if (usedSongVersions.has(candidate.source + ':' + candidate.id)) continue;
      batch3.push({ song: candidate, quality: config.defaultQuality });
    }
    success = await tryBatch('第3批', batch3);
    if (success) return success;

    const finalBatch: Array<{ song: LXSearchResult; quality: string }> = [];
    if (config.allowQualityDowngrade) {
      for (let index = 0; index < candidates.length && finalBatch.length < 1; index++) {
        const candidate = candidates[index];
        if (candidate.source === 'custom') continue;
        finalBatch.push({ song: candidate, quality: '128k' });
      }
    }

    if (config.enableCustomSources && canContinue()) {
      const customResults = await this.search({ source: 'custom', keywords: searchKeyword, limit: 10 });
      for (let index = 0; index < customResults.length && finalBatch.length < 2; index++) {
        const candidate = customResults[index];
        const candidateKey = candidate.source + ':' + candidate.id;
        if (usedSongVersions.has(candidateKey)) continue;
        if (this.matchScore(candidate, titleHint, artistHint) < 50) continue;
        finalBatch.push({ song: candidate, quality: '128k' });
      }
      if (finalBatch.length > 0) fallbackSteps.push('custom搜索仅纳入未重复且高匹配候选: ' + finalBatch.length + '条');
    }

    success = await tryBatch('第4批（降音质或custom候选）', finalBatch);
    if (success) return success;

    const failureReason = Date.now() - startedAt >= LXServerClient.FALLBACK_TIMEOUT_MS ? '10秒预算耗尽' : attempts >= LXServerClient.FALLBACK_MAX_URL_ATTEMPTS ? '8次URL解析预算耗尽' : '候选均不可用';
    return finish(null, null, '', '', failureReason);
  }

  /**
   * 从排序后的搜索结果中选取TopN候选（不同音源优先）
   * v1.9.0: 改为按matchScore排序取TopN，而非按音源优先级
   */
  private _pickTopCandidates(results: LXSearchResult[], count: number): LXSearchResult[] {
    var candidates: LXSearchResult[] = [];
    var usedSources = new Set<string>();
    // 第一轮：优先不同音源
    for (var i = 0; i < results.length && candidates.length < count; i++) {
      if (!usedSources.has(results[i].source)) {
        candidates.push(results[i]);
        usedSources.add(results[i].source);
      }
    }
    // 第二轮：如果还不够，允许同音源
    for (var j = 0; j < results.length && candidates.length < count; j++) {
      if (candidates.indexOf(results[j]) === -1) {
        candidates.push(results[j]);
      }
    }
    return candidates;
  }

  /**
   * 竞速获取URL：第1个返回后启动1s窗口，窗口内收集更多结果
   * v1.9.0: 选matchScore最高的有效URL
   */
  private async _raceWithWindow(
    promises: Array<Promise<{source: string, song: LXSearchResult, url: string | null}>>,
    windowMs: number,
    allResults: LXSearchResult[],
    titleHint?: string,
    artistHint?: string,
    fallbackSteps?: string[]
  ): Promise<{source: string, song: LXSearchResult, url: string | null}> {
    var self = this;
    var resolved: Array<{source: string, song: LXSearchResult, url: string | null}> = [];

    return new Promise(function(resolve) {
      var settled = false;
      var windowTimer: any = null;

      function checkDone() {
        if (settled) return;
        // 从已返回的结果中选matchScore最高的有效URL
        var valid = resolved.filter(function(r) { return r.url && !self.isAbnormalUrl(r.url); });
        if (valid.length > 0) {
          valid.sort(function(a, b) {
            return self.matchScore(b.song, titleHint, artistHint) - self.matchScore(a.song, titleHint, artistHint);
          });
          settled = true;
          if (windowTimer) clearTimeout(windowTimer);
          resolve(valid[0]);
        }
      }

      for (var i = 0; i < promises.length; i++) {
        (function(p, idx) {
          p.then(function(result) {
            if (settled) return;
            resolved.push(result);
            if (fallbackSteps) {
              fallbackSteps.push((result.url ? '✓' : '✗') + ' ' + result.source + ' URL' + (result.url ? '' : ' failed'));
            }
            if (resolved.length === 1) {
              // 第1个结果返回，启动1s窗口
              windowTimer = setTimeout(function() {
                if (!settled) {
                  // 窗口超时，选最好的
                  checkDone();
                  // 如果还没有有效的，返回null
                  if (!settled) {
                    settled = true;
                    resolve({ source: '', song: allResults[0], url: null });
                  }
                }
              }, windowMs);
            } else if (resolved.length === promises.length) {
              // 全部返回，直接选
              checkDone();
            }
          }).catch(function() {
            // 忽略错误
            resolved.push({ source: '', song: allResults[0], url: null });
            if (resolved.length === promises.length && !settled) {
              checkDone();
              if (!settled) {
                settled = true;
                resolve({ source: '', song: allResults[0], url: null });
              }
            }
          });
        })(promises[i], i);
      }

      // 兜底超时：5s后强制返回
      setTimeout(function() {
        if (!settled) {
          settled = true;
          checkDone();
          if (!settled) {
            resolve({ source: '', song: allResults[0], url: null });
          }
        }
      }, 5000);
    });
  }

  /**
   * 智能缓存：触发 lxserver 后台下载并缓存歌曲 (v1.0.78)
   */
  async cacheDownload(params: {
    songId: string;
    source: string;
    quality: string;
    name: string;
    singer: string;
    album?: string;
    cover?: string;
  }): Promise<boolean> {
    if (!this.config) {
      songloft.log.warn('[LXClient] cacheDownload: No config available');
      return false;
    }

    try {
      // v1.8.22: 使用 getToken() 而非 this.config.token，确保token有效
      const token = await this.getToken();
      const baseUrl = this.getBaseUrl();

      songloft.log.info('[LXClient] Triggering cache download: ' + params.name + ' - ' + params.singer);

      const resp = await fetch(baseUrl + '/api/music/cache/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-token': token,
          'x-user-name': this.config.username,
        },
        body: JSON.stringify({
          songInfo: {
            id: params.songId,
            songmid: params.songId,
            source: params.source,
            name: params.name,
            singer: params.singer,
            albumName: params.album || '',
            img: params.cover || '',
          },
          quality: params.quality,
        }),
      });

      if (!resp.ok) {
        songloft.log.warn('[LXClient] Cache download failed: HTTP ' + resp.status);
        return false;
      }

      const text = await resp.text();
      songloft.log.info('[LXClient] Cache download response: ' + text.substring(0, 200));

      // 解析响应
      try {
        const data = JSON.parse(text);
        return data.success !== false;
      } catch (e) {
        // 如果无法解析 JSON，认为请求已发送成功（异步处理）
        return true;
      }
    } catch (e) {
      songloft.log.warn('[LXClient] cacheDownload error: ' + String(e));
      return false;
    }
  }
}
