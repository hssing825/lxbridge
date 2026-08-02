// Songloft-LX 插件 — HTTP 路由处理器
/// <reference types="@songloft/plugin-sdk" />

import type { Router, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { ConfigManager } from '../config/manager';
import { LXServerClient } from '../lxserver/client';
import { MIoTBridge } from '../bridge/miot';
import { SearchAdapter } from '../bridge/search';
import type { MIoTSearchRequest } from '../bridge/search';
import { PlayerController } from '../player/controller';
import { PLUGIN_VERSION } from '../version';
import { DiagnosticsService } from '../diagnostics/diagnostics-center';
import { simulateFallbackV22 } from '../lxserver/fallback-simulation';

// ===== 语音交互日志 (v1.0.86) =====
const voiceLogs: Array<{ time: number; type: string; action: string; detail: string; result: string | null; extra?: any }> = [];
const MAX_VOICE_LOGS = 100;

// ===== 播放追踪 (v1.0.93) =====
const playbackTracker: Array<{
  time: number;
  keyword: string;
  source: string; // 'miot-voice' | 'web-ui' | 'unknown'
  songTitle: string;
  songArtist: string;
  songUrl: string;
  urlPrefix: string; // URL的前80字符，用于匹配
  platform: string; // 'lxserver' | 'netease' | 'qq' 等
}> = [];
const MAX_TRACKER_LOGS = 50;

function addPlaybackTrack(keyword: string, source: string, songTitle: string, songArtist: string, songUrl: string, platform: string) {
  const track = {
    time: Date.now(),
    keyword,
    source,
    songTitle,
    songArtist,
    songUrl,
    urlPrefix: songUrl.substring(0, 80),
    platform
  };
  playbackTracker.push(track);
  if (playbackTracker.length > MAX_TRACKER_LOGS) playbackTracker.shift();
  songloft.log.info(`[PlaybackTracker] Tracked: ${songTitle} - ${songArtist} from ${source} (${platform})`);
}

function addVoiceLog(action: string, detail: string, result: string | null, extra?: any) {
  voiceLogs.push({ time: Date.now(), type: 'voice', action, detail, result, extra });
  if (voiceLogs.length > MAX_VOICE_LOGS) voiceLogs.shift();
}

// ===== 工具函数 =====

function jsonResponse(data: any, statusCode: number = 200): HTTPResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  };
}

function errorResponse(message: string, statusCode: number = 400): HTTPResponse {
  return jsonResponse({ success: false, error: message }, statusCode);
}

function uint8ToString(buf: Uint8Array): string {
  let str = '';
  for (let i = 0; i < buf.length; i++) {
    str += String.fromCharCode(buf[i]);
  }
  return str;
}

function getBody(req: HTTPRequest): any {
  if (!req.body) return {};
  try {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    // Uint8Array → string (QuickJS 没有 TextDecoder)
    if (req.body instanceof Uint8Array) {
      return JSON.parse(uint8ToString(req.body));
    }
    return req.body;
  } catch {
    return {};
  }
}

// QuickJS 兼容的 query string 解析
function parseQuery(queryString: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!queryString) return result;
  const pairs = queryString.split('&');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      result[decodeURIComponent(pair)] = '';
    } else {
      result[decodeURIComponent(pair.substring(0, idx))] = decodeURIComponent(pair.substring(idx + 1));
    }
  }
  return result;
}

// ===== 原生远程流令牌表（用于受控交接给 Songloft） =====
const PROXY_URL_TTL = 120000; // 2分钟过期
const PROXY_MAX_USES = 3;
interface ProxySongMetadata {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  dedupKey?: string;
}

interface RegisteredRemoteSong {
  id?: number;
}

interface SongloftSongsWithCreate {
  create(songs: Array<{
    url: string;
    title: string;
    artist: string;
    album: string;
    coverUrl: string;
    duration: number;
    dedupKey: string;
  }>): Promise<RegisteredRemoteSong[]>;
}

const proxyUrlStore: Record<string, { songId: number; createdAt: number; remainingUses: number }> = {};

function generateShortToken(): string {
  // This token is the only credential for the narrowly exposed proxy route.
  try {
    if (typeof __go_crypto_random_bytes === 'function') {
      return __go_crypto_random_bytes(24);
    }
  } catch {
    // Keep compatibility with older hosts that do not provide the crypto bridge.
  }
  return Math.random().toString(36).substring(2, 10)
    + Math.random().toString(36).substring(2, 10)
    + Date.now().toString(36);
}

async function registerProxyUrl(originalUrl: string, metadata: ProxySongMetadata): Promise<string> {
  const remoteSongs = songloft.songs as unknown as SongloftSongsWithCreate;
  const registeredSongs = await remoteSongs.create([{
    url: originalUrl,
    title: metadata.title || 'unknown title',
    artist: metadata.artist || 'unknown artist',
    album: metadata.album || '',
    coverUrl: metadata.coverUrl || '',
    duration: Number(metadata.duration) || 0,
    // The vkey in a tx URL expires, so use the stable song identity for deduplication.
    dedupKey: metadata.dedupKey || 'tx-url:' + originalUrl.substring(0, 160),
  }]);
  const songId = registeredSongs && registeredSongs[0] && Number(registeredSongs[0].id);
  if (!songId || songId <= 0) {
    throw new Error('Songloft did not return a remote song id');
  }

  const token = generateShortToken();
  proxyUrlStore[token] = { songId, createdAt: Date.now(), remainingUses: PROXY_MAX_USES };
  // 清理过期条目
  const now = Date.now();
  for (const key in proxyUrlStore) {
    if (now - proxyUrlStore[key].createdAt > PROXY_URL_TTL) {
      delete proxyUrlStore[key];
    }
  }
  return token;
}

// ===== 注册所有路由 =====

export function registerHandlers(
  router: Router,
  configManager: ConfigManager,
  lxClient: LXServerClient,
  miotBridge: MIoTBridge,
  searchAdapter: SearchAdapter,
  playerController: PlayerController
): void {

  // ── 首页重定向 ──
  router.get('/', (_req: HTTPRequest) => {
    return {
      statusCode: 302,
      headers: { 'Location': '/api/plugins/lxbridge/static/index.html' },
      body: '',
    };
  });

  // ── 获取 lxserver 配置 ──
  router.get('/api/config', async (_req: HTTPRequest) => {
    try {
      const config = await configManager.getConfig();
      const safeConfig: any = { ...config, password: '******' };
      return jsonResponse({ success: true, data: safeConfig });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 保存 lxserver 配置 ──
  router.post('/api/config', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const current = await configManager.getConfig();

      const newConfig = {
        ...current,
        host: body.host !== undefined ? body.host : current.host,
        username: body.username !== undefined ? body.username : current.username,
        password: body.password !== undefined ? body.password : current.password,
        webPlayerUrl: body.webPlayerUrl !== undefined ? body.webPlayerUrl : current.webPlayerUrl,
        defaultQuality: body.defaultQuality || current.defaultQuality,
        sourcePriority: body.sourcePriority || current.sourcePriority,
        allowQualityDowngrade: body.allowQualityDowngrade !== undefined ? body.allowQualityDowngrade : current.allowQualityDowngrade,
        enableCustomSources: body.enableCustomSources !== undefined ? body.enableCustomSources : current.enableCustomSources,
        enableFuzzyMatch: body.enableFuzzyMatch !== undefined ? body.enableFuzzyMatch : current.enableFuzzyMatch,
        searchTimeout: body.searchTimeout || current.searchTimeout,
      };

      await configManager.saveConfig(newConfig);
      await lxClient.reloadConfig();
      songloft.log.info('[Route] Config saved');
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 测试连接 ──
  router.post('/api/config/test', async (_req: HTTPRequest) => {
    try {
      const result = await lxClient.testConnection();
      return jsonResponse(result);
    } catch (e: any) {
      return jsonResponse({ success: false, message: e.message });
    }
  });

  // ── MIoT topone 格式搜索（核心语音点歌入口）──
  const handleMIoTSearch = async (req: HTTPRequest): Promise<HTTPResponse> => {
    try {
      const body: MIoTSearchRequest = getBody(req);
      const keyword = body.keyword || body.hint?.title || '';
      songloft.log.info('[Route] MIoT search: path=' + req.path + ' keyword=' + keyword);
      addVoiceLog('语音搜索', '"' + keyword + '"', null);
      const result = await searchAdapter.handleMIoTSearch(body);
      if (result.code === 0 && result.data) {
        const song = result.data;
        addVoiceLog('搜索结果', song.title + ' · ' + song.artist + ' ✅', 'success', {
          url: song.url?.substring(0, 80),
          platform: song.source_data?.platform || 'unknown'
        });
        // 记录到播放追踪
        addPlaybackTrack(
          keyword,
          'miot-voice',
          song.title,
          song.artist,
          song.url || '',
          song.source_data?.platform || 'unknown'
        );
      } else {
        addVoiceLog('搜索结果', result.msg || '未找到', 'fail');
      }
      return jsonResponse(result);
    } catch (e: any) {
      songloft.log.error('[Route] MIoT search error: ' + String(e));
      addVoiceLog('语音搜索', '错误', 'fail');
      return jsonResponse({ code: -1, msg: e.message, data: null });
    }
  };

  router.post('/api/search/topone', handleMIoTSearch);
  router.post('/api/search', handleMIoTSearch);

  // ── 搜索联想 (v1.5.1) ──
  router.get('/api/search/suggest', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const keyword = q.keyword || q.name || '';
      if (!keyword) return jsonResponse({ success: true, data: [] });
      const suggestions = await lxClient.searchSuggest(keyword);
      return jsonResponse({ success: true, data: suggestions });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 歌单+榜单 (v1.6.0) ──
  router.get('/api/songlist/tags', async (req: HTTPRequest) => {
    try { const q = parseQuery(req.query); const raw = await lxClient.getSongListTags(q.source || 'wy'); return jsonResponse({ success: true, data: (raw as any).tags || raw }); }
    catch (e: any) { return errorResponse(e.message); }
  });
  router.get('/api/songlist/list', async (req: HTTPRequest) => {
    try { const q = parseQuery(req.query); const page = q.page ? parseInt(q.page, 10) : undefined; const limit = q.limit ? parseInt(q.limit, 10) : undefined; const raw = await lxClient.getSongLists(q.source || 'wy', q.tagId || q.tag || '', undefined, page, limit); return jsonResponse({ success: true, data: (raw as any).list || raw }); }
    catch (e: any) { return errorResponse(e.message); }
  });
  router.get('/api/songlist/detail', async (req: HTTPRequest) => {
    try { const q = parseQuery(req.query); const raw = await lxClient.getSongListDetail(q.source || 'wy', q.id || ''); return jsonResponse({ success: true, data: (raw as any).list || raw }); }
    catch (e: any) { return errorResponse(e.message); }
  });
  router.get('/api/leaderboard/boards', async (req: HTTPRequest) => {
    try { const q = parseQuery(req.query); const raw = await lxClient.getLeaderboardBoards(q.source || 'kg'); return jsonResponse({ success: true, data: (raw as any).list || raw }); }
    catch (e: any) { return errorResponse(e.message); }
  });
  router.get('/api/leaderboard/list', async (req: HTTPRequest) => {
    try { const q = parseQuery(req.query); const raw = await lxClient.getLeaderboardList(q.source || 'kg', q.bangid || q.id || ''); return jsonResponse({ success: true, data: (raw as any).list || raw }); }
    catch (e: any) { return errorResponse(e.message); }
  });

  // ── 热搜榜 (v1.5.1) ──
  router.get('/api/search/hot', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const source = q.source || '';
      const hotList = await lxClient.hotSearch(source);
      return jsonResponse({ success: true, data: hotList });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── Web UI 搜索 ──
  router.get('/api/search/web', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const keyword = q.keyword || '';
      const sourcesStr = q.sources || '';
      const sources = sourcesStr ? sourcesStr.split(',') : undefined;
      const limit = q.limit ? parseInt(q.limit, 10) : undefined;
      const results = await searchAdapter.handleWebSearch(keyword, sources, limit);
      return jsonResponse({ success: true, data: results });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 歌手/歌单搜索 ──
  router.get('/api/search/entities', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const type = q.type || '';
      const keyword = (q.keyword || '').trim();
      if (type !== 'singer' && type !== 'playlist') {
        return errorResponse('不支持的搜索类型', 400);
      }
      if (!keyword) return errorResponse('缺少搜索关键词', 400);

      const requestedSources = (q.sources || '')
        .split(',')
        .map(source => source.trim())
        .filter(Boolean);
      const parsedPage = parseInt(q.page || '1', 10);
      const parsedLimit = parseInt(q.limit || '20', 10);
      const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 20;
      const result = await lxClient.searchEntities(type, keyword, requestedSources, page, limit);
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      const message = e.message || String(e);
      const isValidationError = message.indexOf('does not support') !== -1 ||
        message.indexOf('Unsupported entity search type') !== -1;
      return errorResponse(message, isValidationError ? 400 : 500);
    }
  });

  // ── 歌手详情与全部歌曲 ──
  router.get('/api/artist/detail', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      if (!q.source || !q.id) return errorResponse('缺少歌手来源或 ID', 400);
      const detail = await lxClient.getArtistDetail(q.source, q.id, {
        name: q.name || '',
        cover: q.cover || '',
      });
      return jsonResponse({ success: true, data: detail });
    } catch (e: any) {
      const message = e.message || String(e);
      return errorResponse(message, message.indexOf('does not support') !== -1 ? 400 : 500);
    }
  });

  router.get('/api/artist/songs', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      if (!q.source || !q.id) return errorResponse('缺少歌手来源或 ID', 400);
      const songs = await lxClient.getArtistSongs(q.source, q.id, q.order || 'hot');
      return jsonResponse({ success: true, data: songs });
    } catch (e: any) {
      const message = e.message || String(e);
      return errorResponse(message, message.indexOf('does not support') !== -1 ? 400 : 500);
    }
  });

  router.get('/api/artist/albums', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      if (!q.source || !q.id) return errorResponse('缺少歌手来源或 ID', 400);
      const albums = await lxClient.getArtistAlbums(q.source, q.id);
      return jsonResponse({ success: true, data: albums });
    } catch (e: any) {
      const message = e.message || String(e);
      return errorResponse(message, message.indexOf('does not support') !== -1 ? 400 : 500);
    }
  });

  router.get('/api/album/songs', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      if (!q.source || !q.id) return errorResponse('缺少专辑来源或 ID', 400);
      const songs = await lxClient.getAlbumSongs(q.source, q.id);
      return jsonResponse({ success: true, data: songs });
    } catch (e: any) {
      const message = e.message || String(e);
      return errorResponse(message, message.indexOf('does not support') !== -1 ? 400 : 500);
    }
  });

  // ── 获取单曲播放URL ──
  router.post('/api/song/url', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { songId, source, quality, name, singer, album, duration, cover, _raw } = body;
      if (!songId || !source) return errorResponse('缺少 songId 或 source');
      const result = await searchAdapter.getUrlForSong(songId, source, quality, { name, singer, album, duration, cover, _raw });
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/song/lyric', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const song = body.song && typeof body.song === 'object' ? body.song : body;
      if (!song.id || !song.source) return errorResponse('缺少歌曲 ID 或来源', 400);
      const result = await lxClient.getLyric({
        id: String(song.id),
        source: String(song.source),
        lyricId: String(song.lyricId || song.lrc || ''),
        name: String(song.name || song.title || ''),
        singer: String(song.singer || song.artist || ''),
        interval: song.interval || song.duration || '',
        albumId: String(song.albumId || ''),
        raw: song.raw && typeof song.raw === 'object' ? song.raw : (song._raw && typeof song._raw === 'object' ? song._raw : undefined),
      });
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return errorResponse(e.message || String(e));
    }
  });

  // ── 获取歌曲URL（带降级策略）──
  router.post('/api/song/url-with-fallback', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { name, singer, album, source, songId, preferredSource } = body;
      if (!name) return errorResponse('缺少歌曲名称');

      // 使用智能降级搜索 (v1.0.78: 支持优选音源)
      const keywords = name + (singer ? ' ' + singer : '');
      const result = await lxClient.searchWithFallback(keywords, name, singer, preferredSource);

      if (result.url && result.song) {
        return jsonResponse({
          success: true,
          data: {
            url: result.url,
            quality: result.quality,
            source: result.source,
            song: result.song,
            fallbackSteps: result.fallbackSteps,
          }
        });
      }

      return jsonResponse({
        success: false,
        error: '未找到可播放的歌曲版本',
        data: {
          requestId: result.requestId,
          attempts: result.attempts,
          elapsedMs: result.elapsedMs,
          failureReason: result.failureReason || '候选均不可用',
          fallbackSteps: result.fallbackSteps,
        },
      }, 404);
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 设备列表 ──
  router.get('/api/devices', async (_req: HTTPRequest) => {
    try {
      const devices = await playerController.getDevices();
      const current = playerController.getCurrentDevice();
      return jsonResponse({ success: true, data: { devices, currentDevice: current } });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 选择设备 ──
  router.post('/api/device/select', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const result = await playerController.selectDevice(body.account_id, body.device_id);
      return jsonResponse({ success: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 播放指定歌曲 ──
  router.post('/api/player/play', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { url, title, artist, account_id, device_id } = body;
      if (!url) return errorResponse('缺少播放URL');

      // 将设备参数直接传递给 play 方法
      const result = await playerController.play(url, title, artist, account_id, device_id);
      return jsonResponse({ success: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 播放控制 ──
  router.post('/api/player/control', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { action, volume, mode, url, title, artist, account_id, device_id } = body;
      let result = false;

      // 如果前端传递了 account_id 和 device_id，先更新当前设备
      if (account_id && device_id) {
        await playerController.selectDevice(account_id, device_id);
      }

      switch (action) {
        case 'play':
          result = url
            ? await playerController.play(url, title, artist)
            : await playerController.resume();
          break;
        case 'pause': result = await playerController.pause(); break;
        case 'next': result = await playerController.next(); break;
        case 'prev': result = await playerController.prev(); break;
        case 'stop': result = await playerController.stop(); break;
        case 'set_volume':
          songloft.log.info('[Route] set_volume: ' + (volume || 50));
          result = await playerController.setVolume(volume || 50);
          songloft.log.info('[Route] set_volume result: ' + result);
          break;
        case 'set_mode': result = await playerController.setPlayMode(mode || 'order'); break;
        default: return errorResponse('未知操作: ' + action);
      }

      return jsonResponse({ success: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 播放状态 ──
  router.get('/api/player/status', async (_req: HTTPRequest) => {
    try {
      const status = await playerController.getState();
      const currentDevice = playerController.getCurrentDevice();
      return jsonResponse({ success: true, data: { ...status, currentDevice } });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 播放历史 ──
  router.get('/api/history', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const limit = parseInt(q.limit || '50', 10);
      const history = await configManager.getPlayHistory(limit);
      return jsonResponse({ success: true, data: history });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/history/add', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { songId, title, artist, album, cover, source, quality, duration } = body;
      if (!songId || !title) {
        return errorResponse('缺少必要字段');
      }
      await configManager.addPlayHistory({
        songId,
        title,
        artist: artist || '',
        album: album || '',
        cover: cover || '',
        source: source || '',
        quality: quality || '',
        duration: duration || 0,
        playedAt: new Date().toISOString(),
      });
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/history/clear', async (_req: HTTPRequest) => {
    try {
      await configManager.clearPlayHistory();
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── MIoT 状态 ──
  router.get('/api/miot/status', async (_req: HTTPRequest) => {
    try {
      const status = await miotBridge.checkMIoTInstalled();
      return jsonResponse({ success: true, data: status });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 一键配置MIoT搜索源 ──
  router.post('/api/miot/configure', async (_req: HTTPRequest) => {
    try {
      const result = await miotBridge.configureSearchEndpoint();
      return jsonResponse({ success: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 对话记录 ──
  router.get('/api/conversations', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const limit = parseInt(q.limit || '20', 10);
      const conversations = await miotBridge.getConversations(limit);
      return jsonResponse({ success: true, data: conversations });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 语音交互日志 (v1.0.86) ──
  router.get('/api/logs/voice', async (_req: HTTPRequest) => {
    return jsonResponse({ success: true, data: voiceLogs });
  });

  // ── 播放追踪日志 (v1.0.93) ──
  router.get('/api/logs/playback', async (_req: HTTPRequest) => {
    return jsonResponse({ success: true, data: playbackTracker });
  });

  // ── 时间线视图 (v1.0.94) - 整合小爱对话、插件响应、播放状态 ──
  router.get('/api/timeline', async (req: HTTPRequest) => {
    try {
      songloft.log.info('[Timeline] ========== 时间线API调用 ==========');
      const q = parseQuery(req.query);
      const limit = parseInt(q.limit || '50', 10);
      const startTime = parseInt(q.startTime || '0', 10);
      songloft.log.info('[Timeline] 参数: limit=' + limit + ', startTime=' + startTime);

      // 1. 获取小爱对话记录
      songloft.log.info('[Timeline] 正在获取小爱对话记录...');
      const conversations = await miotBridge.getConversations(limit);
      songloft.log.info('[Timeline] 小爱对话数量: ' + conversations.length);
      if (conversations.length > 0) {
        songloft.log.info('[Timeline] 小爱对话示例: ' + JSON.stringify(conversations[0]).substring(0, 200));
      }

      // 2. 获取插件响应记录（语音日志 + 播放追踪）
      songloft.log.info('[Timeline] 语音日志数量: ' + voiceLogs.length);
      songloft.log.info('[Timeline] 播放追踪数量: ' + playbackTracker.length);

      const pluginEvents = voiceLogs.concat(
        playbackTracker.map(p => ({
          time: p.time,
          type: 'playback-track',
          action: '插件返回歌曲',
          detail: p.songTitle + ' - ' + p.songArtist,
          result: 'success',
          extra: p
        }))
      );
      songloft.log.info('[Timeline] 插件事件总数: ' + pluginEvents.length);

      // 3. 构建时间线（合并所有事件）
      const timeline: Array<any> = [];

      // 添加小爱对话
      for (const conv of conversations) {
        if (startTime && conv.time && conv.time < startTime) continue;
        // 使用对话的真实时间戳，而不是当前时间
        const realTime = conv.message?.timestamp_ms || conv.time || conv.timestamp || Date.now();
        timeline.push({
          time: realTime,
          type: 'xiaoai-conversation',
          source: 'xiaoai',
          data: conv
        });
      }
      songloft.log.info('[Timeline] 添加小爱事件: ' + timeline.length + '条');

      // 添加插件事件
      for (const event of pluginEvents) {
        if (startTime && event.time < startTime) continue;
        timeline.push({
          time: event.time,
          type: event.type,
          source: 'plugin',
          data: event
        });
      }
      songloft.log.info('[Timeline] 添加插件事件后总数: ' + timeline.length + '条');

      // 按时间排序
      timeline.sort((a, b) => (b.time || 0) - (a.time || 0));

      // 限制数量
      const result = timeline.slice(0, limit);
      songloft.log.info('[Timeline] 返回最终数量: ' + result.length + '条');
      if (result.length > 0) {
        songloft.log.info('[Timeline] 第一条: ' + JSON.stringify(result[0]).substring(0, 200));
      }

      return jsonResponse({ success: true, data: result, total: timeline.length });
    } catch (e: any) {
      songloft.log.error('[Route] /api/timeline error: ' + String(e));
      songloft.log.error('[Route] /api/timeline stack: ' + (e.stack || 'no stack'));
      return errorResponse(e.message);
    }
  });

  // ── 降级日志 ──
  router.get('/api/fallback-logs', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const limit = parseInt(q.limit || '20', 10);
      const logs = await configManager.getFallbackLogs(limit);
      return jsonResponse({ success: true, data: logs });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── Web播放器地址 ──
  router.get('/api/webplayer-url', async (_req: HTTPRequest) => {
    try {
      const url = lxClient.getWebPlayerUrl();
      return jsonResponse({ success: true, data: { url } });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 原生远程流：注册短时访问令牌 ──
  router.post('/api/proxy/register', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const originalUrl = body.url;
      if (!originalUrl) return errorResponse('缺少url');
      const token = await registerProxyUrl(originalUrl, body.song || {});
      return jsonResponse({ success: true, data: { token } });
    } catch (e: any) {
      songloft.log.warn('[Proxy] Native stream registration failed: ' + String(e));
      return errorResponse(e.message);
    }
  });

  // ── 原生远程流：短 token → Songloft 流式服务 ──
  router.get('/api/proxy/play', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const entry = proxyUrlStore[q.token];
      if (!entry) return errorResponse('令牌无效或已过期', 404);
      entry.remainingUses--;
      if (entry.remainingUses <= 0) delete proxyUrlStore[q.token];
      songloft.log.info('[Proxy] Native stream accepted songId=' + entry.songId
        + ' usesRemaining=' + Math.max(0, entry.remainingUses));
      return {
        statusCode: 200,
        serveFile: { songId: entry.songId },
      };
    } catch (e: any) {
      songloft.log.warn('[Proxy] Native stream handoff failed: ' + String(e));
      return errorResponse('audio stream handoff failed: ' + e.message, 502);
    }
  });

  // ── 歌单列表 (v1.5.0) - 返回所有歌单 ──
  router.get('/api/playlists', async (_req: HTTPRequest) => {
    try {
      const playlists = await lxClient.getPlaylists();
      return jsonResponse({ success: true, data: playlists });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 收藏列表（兼容旧版）──
  router.get('/api/favorites', async (_req: HTTPRequest) => {
    try {
      const favorites = await lxClient.getFavorites();
      return jsonResponse({ success: true, data: favorites });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 主题 ──
  router.get('/api/theme', async (_req: HTTPRequest) => {
    try {
      const theme = await configManager.getTheme();
      return jsonResponse({ success: true, data: { theme } });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/theme', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      await configManager.saveTheme(body.theme || 'auto');
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 智能缓存 (v1.0.78) ──
  router.post('/api/cache/download', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      const { songId, source, quality, name, singer, album, cover } = body;

      if (!songId || !source || !name || !singer) {
        return errorResponse('缺少必要参数：songId, source, name, singer');
      }

      songloft.log.info('[LXBridge] 触发缓存下载: ' + name + ' - ' + singer + ' (' + source + ', ' + quality + ')');

      // 调用 lxserver 缓存下载 API
      const result = await lxClient.cacheDownload({
        songId,
        source,
        quality: quality || '320k',
        name,
        singer,
        album: album || '',
        cover: cover || ''
      });

      return jsonResponse({ success: result });
    } catch (e: any) {
      songloft.log.warn('[LXBridge] 缓存下载失败: ' + String(e));
      return errorResponse(e.message);
    }
  });

  // ── 缓存查询 (v1.8.22) ──
  router.get('/api/cache/check', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const name = q.name || '';
      const singer = q.singer || '';
      if (!name) return errorResponse('缺少歌曲名称');
      const cacheHit = await lxClient.cacheCheck(name, singer);
      return jsonResponse({ success: true, data: { cached: !!cacheHit, url: cacheHit ? cacheHit.url : '', duration: cacheHit ? cacheHit.duration : 0 } });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 音频URL验证测试 (v1.9.0-test) ──
  // 用法: GET /api/test/verify-audio?url=<encoded_url>&quality=320k
  // 先搜一首歌拿到URL，再用这个接口验证
  router.get('/api/test/verify-audio', async (req: HTTPRequest) => {
    try {
      const q = parseQuery(req.query);
      const testUrl = q.url || '';
      const quality = q.quality || '320k';

      if (!testUrl) {
        // 没有指定URL时，自动搜索一首歌来测试
        const keyword = q.keyword || '周杰伦 晴天';
        songloft.log.info('[Test] Auto-searching for: ' + keyword);

        const searchResults = await lxClient.searchMultiSource(keyword, ['kg', 'tx'], 5000);
        if (searchResults.length === 0) {
          return jsonResponse({ success: false, error: '搜索无结果，请手动指定url参数' });
        }

        // 取第一个结果获取URL
        const song = searchResults[0];
        songloft.log.info('[Test] Found song: ' + song.name + ' - ' + song.singer + ' (' + song.source + ', duration=' + song.duration + 's)');

        const songUrlResult = await lxClient.getSongUrl({
          id: song.id,
          source: song.source,
          type: quality,
          name: song.name,
          singer: song.singer,
          _raw: song._raw,
        });

        if (!songUrlResult.url) {
          return jsonResponse({ success: false, error: '无法获取播放URL: ' + song.name + ' - ' + song.singer });
        }
        const songUrl = songUrlResult.url;

        // 自动获取到URL，继续验证
        songloft.log.info('[Test] Got URL: ' + songUrl.substring(0, 120) + '...');

        const verifyResult = await lxClient.verifyAudioSize(songUrl);

        return jsonResponse({
          success: true,
          data: {
            testType: 'auto',
            song: { name: song.name, singer: song.singer, source: song.source, duration: song.duration },
            url: songUrl.substring(0, 150),
            urlLength: songUrl.length,
            verify: verifyResult,
            // 阈值判断
            verdict: verifyResult.size !== null
              ? (verifyResult.size < 800 * 1024
                ? '⚠️ 片段嫌疑 (size=' + (verifyResult.size / 1024).toFixed(1) + 'KB < 800KB)'
                : '✅ 正常 (size=' + (verifyResult.size / 1024 / 1024).toFixed(2) + 'MB)')
              : '❓ 无法验证 (' + (verifyResult.error || '未知') + ')',
          }
        });
      }

      // 手动指定URL，直接验证
      songloft.log.info('[Test] Manual verify URL: ' + testUrl.substring(0, 120));
      const verifyResult = await lxClient.verifyAudioSize(testUrl);

      return jsonResponse({
        success: true,
        data: {
          testType: 'manual',
          url: testUrl.substring(0, 150),
          urlLength: testUrl.length,
          verify: verifyResult,
          verdict: verifyResult.size !== null
            ? (verifyResult.size < 800 * 1024
              ? '⚠️ 片段嫌疑 (size=' + (verifyResult.size / 1024).toFixed(1) + 'KB < 800KB)'
              : '✅ 正常 (size=' + (verifyResult.size / 1024 / 1024).toFixed(2) + 'MB)')
            : '❓ 无法验证 (' + (verifyResult.error || '未知') + ')',
        }
      });
    } catch (e: any) {
      return errorResponse('验证失败: ' + e.message);
    }
  });

  // ── 降级策略模拟（不访问 lxserver，不写入真实冷却状态）──
  router.post('/api/test/fallback-simulation', async (req: HTTPRequest) => {
    const body = getBody(req);
    const scenario = body.scenario || 'budget_exhausted';
    const allowed = ['success_batch_3', 'platform_block', 'global_block', 'budget_exhausted'];
    if (!allowed.includes(scenario)) {
      return errorResponse('未知模拟场景: ' + scenario);
    }
    const result = simulateFallbackV22(scenario);
    songloft.log.info('[FallbackV22][simulation] scenario=' + scenario + ' attempts=' + result.attempts + ' success=' + result.success);
    return jsonResponse({ success: true, data: { scenario, simulated: true, ...result } });
  });

  // ── 自定义源管理 (v2.1.0) ──
  router.get('/api/custom-sources', async (_req: HTTPRequest) => {
    try {
      const result = await lxClient.getCustomSources();
      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/custom-sources/toggle', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      songloft.log.info('[Route] toggleCustomSources: body.id=' + body.id + ' enabled=' + body.enabled);
      const result = await lxClient.toggleCustomSource(body.id, body.enabled);
      songloft.log.info('[Route] toggleCustomSources: result=' + result);
      return jsonResponse({ success: result });
    } catch (e: any) {
      songloft.log.warn('[Route] toggleCustomSources error: ' + e.message);
      return errorResponse(e.message);
    }
  });

  router.post('/api/custom-sources/reorder', async (req: HTTPRequest) => {
    try {
      const body = getBody(req);
      songloft.log.info('[Route] reorderCustomSources: body.ids=' + JSON.stringify(body.ids));
      const result = await lxClient.reorderCustomSources(body.ids);
      songloft.log.info('[Route] reorderCustomSources: result=' + result);
      return jsonResponse({ success: result });
    } catch (e: any) {
      songloft.log.warn('[Route] reorderCustomSources error: ' + e.message);
      return errorResponse(e.message);
    }
  });

  // ── 自定义源统计 (v2.1.0) ──
  router.get('/api/custom-source-stats', async (_req: HTTPRequest) => {
    try {
      const stats = await configManager.getCustomSourceStats();
      return jsonResponse({ success: true, data: stats });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  router.post('/api/custom-source-stats/reset', async (_req: HTTPRequest) => {
    try {
      await configManager.resetCustomSourceStats();
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message);
    }
  });

  // ── 系统诊断中心 (v2.6.0) ──
  const diagnosticsService = new DiagnosticsService({
    version: PLUGIN_VERSION,
    configManager,
    lxClient,
    miotBridge,
    playerController,
    getVoiceLogs: () => voiceLogs,
    getPlaybackTracker: () => playbackTracker,
  });

  // 诊断总览：默认只访问状态或配置接口，不搜索、不解析、不播放、不控制音箱。
  router.get('/api/diagnostics/overview', async (_req: HTTPRequest) => {
    try {
      const data = await diagnosticsService.gatherOverview();
      return jsonResponse({ success: true, data });
    } catch (e: any) {
      songloft.log.error('[Diagnostics] overview error: ' + String(e));
      return errorResponse(e.message);
    }
  });

  // 脱敏诊断报告：返回可复制的纯文本，不含敏感信息。
  router.get('/api/diagnostics/report', async (_req: HTTPRequest) => {
    try {
      const report = await diagnosticsService.buildReport();
      return jsonResponse({ success: true, data: { report } });
    } catch (e: any) {
      songloft.log.error('[Diagnostics] report error: ' + String(e));
      return errorResponse(e.message);
    }
  });
}
