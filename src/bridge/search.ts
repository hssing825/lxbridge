// Songloft-LX 插件 — 搜索适配器
// 将 lxserver 搜索结果转换为 MIoT OnlineSearcher 期望的格式

/// <reference types="@songloft/plugin-sdk" />

import type { LXSearchResult, CachedSong, FallbackRecord } from '../lxserver/types';
import { LXServerClient } from '../lxserver/client';
import { ConfigManager } from '../config/manager';
import { MIoTBridge } from './miot';

/**
 * MIoT OnlineSearcher 期望的请求格式
 */
export interface MIoTSearchRequest {
  keyword: string;
  hint?: {
    title?: string;
    artist?: string;
    duration?: number;
  };
  quality?: string;
}

/**
 * MIoT OnlineSearcher 期望的响应格式
 */
export interface MIoTSearchResponse {
  code: number;
  msg: string;
  data: {
    title: string;
    artist: string;
    album: string;
    duration: number;
    cover_url: string;
    url: string;
    source_data?: {
      platform?: string;
      quality?: string;
    };
  } | null;
}

export class SearchAdapter {
  private lxClient: LXServerClient;
  private configManager: ConfigManager;
  private miotBridge: MIoTBridge;

  constructor(lxClient: LXServerClient, configManager: ConfigManager, miotBridge: MIoTBridge) {
    this.lxClient = lxClient;
    this.configManager = configManager;
    this.miotBridge = miotBridge;
  }

  /**
   * 处理来自 MIoT OnlineSearcher 的搜索请求
   * 这是语音点歌的核心入口
   *
   * @param req MIoT格式的搜索请求
   * @returns MIoT格式的搜索响应
   */
  async handleMIoTSearch(req: MIoTSearchRequest): Promise<MIoTSearchResponse> {
    const keyword = req.keyword || '';
    const titleHint = req.hint?.title || '';
    const artistHint = req.hint?.artist || '';

    songloft.log.info(
      '[SearchAdapter] MIoT search request: keyword="' + keyword +
      '" hint_title="' + titleHint + '" hint_artist="' + artistHint + '"'
    );

    if (!keyword && !titleHint) {
      return { code: -1, msg: '缺少搜索关键词', data: null };
    }

    try {
      // 确保lxClient已初始化
      await this.lxClient.reloadConfig();

      // 执行智能降级搜索 (v1.0.80: 添加语音点歌类型标记)
      const searchKeyword = keyword || (titleHint + ' ' + (artistHint || '')).trim();

      // 语音点歌不使用优选音源（每次都重新搜索，保证准确性）
      const result = await this.lxClient.searchWithFallback(
        searchKeyword,
        titleHint || undefined,
        artistHint || undefined,
        undefined  // preferredSource = undefined（语音点歌不优选）
      );

      if (result.url && result.song) {
        songloft.log.info(
          '[SearchAdapter] ✓ Found: ' + result.song.name + ' - ' +
          result.song.singer + ' [' + result.source + '/' + result.quality + ']'
        );

        // 记录降级日志
        if (result.fallbackSteps.length > 1) {
          const fallbackRecord: FallbackRecord = {
            query: searchKeyword,
            attemptedSources: result.fallbackSteps,
            finalSource: result.source,
            finalQuality: result.quality,
            downgradeReason: result.fallbackSteps.join(' → '),
            timestamp: new Date().toISOString(),
          };
          await this.configManager.addFallbackLog(fallbackRecord);
        }

        // 记录播放历史
        await this.configManager.addPlayHistory({
          songId: result.song.id,
          title: result.song.name,
          artist: result.song.singer,
          album: result.song.album || '',
          cover: result.song.cover || '',
          source: result.source,
          quality: result.quality,
          duration: result.song.duration || 0,
          playedAt: new Date().toISOString(),
        });

        return {
          code: 0,
          // v1.8.22: 缓存命中时在msg中标记
          msg: result.source === 'cache' ? 'success (cached)' : 'success',
          data: {
            title: result.song.name,
            artist: result.song.singer,
            album: result.song.album || '',
            duration: result.song.duration || 0,
            cover_url: result.song.cover || '',
            url: result.url,
            source_data: {
              platform: result.source,
              quality: result.quality,
            },
          },
        };
      }

      // 未找到可播放歌曲
      songloft.log.warn(
        '[SearchAdapter] ✗ No playable song found for: "' + searchKeyword +
        '" steps: ' + JSON.stringify(result.fallbackSteps)
      );

      return {
        code: -1,
        msg: '未找到可播放的歌曲版本',
        data: null,
      };
    } catch (e: any) {
      songloft.log.error('[SearchAdapter] Search error: ' + String(e));
      return {
        code: -1,
        msg: '搜索出错: ' + (e.message || '未知错误'),
        data: null,
      };
    }
  }

  /**
   * Web UI 搜索（不降级，返回完整结果列表）
   */
  async handleWebSearch(
    keywords: string,
    sources?: string[],
    limit?: number
  ): Promise<LXSearchResult[]> {
    if (!keywords || keywords.trim() === '') {
      songloft.log.info('[SearchAdapter] Web search: empty keyword');
      return [];
    }

    try {
      await this.lxClient.reloadConfig();
      const config = await this.configManager.getConfig();

      const searchSources = sources || config.sourcePriority;
      const searchLimit = limit || 30;
      songloft.log.info('[SearchAdapter] Web search: "' + keywords + '" sources=' + JSON.stringify(searchSources) + ' limit=' + searchLimit);

      const results = await this.lxClient.searchMultiSource(
        keywords.trim(),
        searchSources,
        config.searchTimeout * 1000,
        searchLimit
      );

      songloft.log.info('[SearchAdapter] Web search done: ' + results.length + ' total results');
      return results;
    } catch (e: any) {
      songloft.log.warn('[SearchAdapter] Web search error: ' + String(e));
      return [];
    }
  }

  /**
   * 获取单首歌曲的播放URL（Web UI点播）
   */
  async getUrlForSong(
    songId: string,
    source: string,
    quality?: string,
    songInfo?: { name?: string; singer?: string; album?: string; duration?: number; cover?: string; _raw?: any }
  ): Promise<{ url: string | null; quality: string }> {
    try {
      await this.lxClient.reloadConfig();
      const config = await this.configManager.getConfig();
      const q = quality || config.defaultQuality;

      const result = await this.lxClient.getSongUrl({
        id: songId,
        source: source,
        type: q,
        name: songInfo?.name,
        singer: songInfo?.singer,
        album: songInfo?.album,
        duration: songInfo?.duration ? String(songInfo.duration) : undefined,
        cover: songInfo?.cover,
        _raw: songInfo?._raw,  // 传递 _raw 字段
      });

      return { url: result.url, quality: q };
    } catch (e: any) {
      songloft.log.warn('[SearchAdapter] getUrlForSong error: ' + String(e));
      return { url: null, quality: quality || '320k' };
    }
  }
}
