// Songloft-LX 插件 — LXServer API 数据类型定义

// ===== LXServer 认证 =====

export interface LXLoginRequest {
  username: string;
  password: string;
}

export interface LXLoginResponse {
  success: boolean;
  token: string;
  username: string;
  message?: string;
}

// ===== LXServer 用户配置 =====

export interface LXServerConfig {
  host: string;            // 服务器地址，如 http://your-lxserver:9527
  username: string;        // 登录用户名
  password: string;        // 登录密码
  webPlayerUrl?: string;   // Web播放器地址（非必填）
  defaultQuality: string;  // 默认音质: "128k" | "320k" | "flac"
  sourcePriority: string[]; // 内置源优先级，如 ["kw","kg","tx","wy","mg"]
  allowQualityDowngrade: boolean;  // 允许音质降级
  enableCustomSources: boolean;    // 启用自定义源fallback
  enableFuzzyMatch: boolean;       // 启用模糊匹配兜底
  searchTimeout: number;   // 单个源搜索超时(秒)，默认3
  token?: string;          // 缓存的登录token
  tokenExpiry?: number;    // token过期时间戳
}

export const DEFAULT_LX_CONFIG: LXServerConfig = {
  host: '',
  username: '',
  password: '',
  webPlayerUrl: '',
  defaultQuality: '320k',
  sourcePriority: ['kg', 'tx', 'wy', 'mg', 'kw'],  // 低稳定性来源放最后
  allowQualityDowngrade: true,
  enableCustomSources: true,
  enableFuzzyMatch: true,
  searchTimeout: 3,
};

// ===== LXServer 搜索 =====

export type LXSourceType = 'kw' | 'kg' | 'tx' | 'wy' | 'mg';

export interface LXSearchParams {
  source: LXSourceType | string;  // 音源标识，支持自定义源
  keywords: string;
  limit?: number;
  page?: number;
}

export interface LXSearchResult {
  id: string;
  name: string;            // 歌曲名
  singer: string;          // 歌手
  album?: string;          // 专辑
  duration?: number;       // 时长(秒)
  cover?: string;          // 封面URL
  source: string;          // 音源标识
  quality?: string;        // 音质
  lyricId?: string;        // 歌词ID
  albumId?: string;        // 专辑ID
  _raw?: any;              // lxserver 原始响应（用于播放）
}

export interface LXSearchResponse {
  success: boolean;
  data: LXSearchResult[];
  total: number;
  message?: string;
}

// ===== LXServer 播放URL =====

export interface LXUrlParams {
  id: string;
  source: string;
  type?: string;           // 音质类型
  name?: string;
  singer?: string;
  album?: string;
  duration?: string;
  cover?: string;
  _raw?: any;              // lxserver 原始响应（包含完整 songInfo）
}

export interface LXUrlResponse {
  success: boolean;
  data: {
    url: string;           // 播放直链
    quality?: string;
    format?: string;
  };
  message?: string;
}

// ===== LXServer 歌词 =====

export interface LXLyricParams {
  id: string;
  source: string;
}

export interface LXLyricResponse {
  success: boolean;
  data: {
    lyric?: string;        // 歌词文本(LRC格式)
    tlyric?: string;       // 翻译歌词
    rlyric?: string;       // 罗马音歌词
  };
}

// ===== 歌曲缓存 =====

export interface CachedSong {
  songId: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  url: string;
  source: string;
  quality: string;
  duration: number;
  cachedAt: number;
}

// ===== lxserver 缓存列表项 (v1.8.22) =====

export interface CacheListItem {
  name: string;
  singer: string;
  url: string;
  source?: string;
  quality?: string;
  size?: number;
}

// ===== lxserver 收藏列表 =====

export interface LXFavoriteItem {
  id: string;           // 如 "tx_004PjZLu3CjaYS"
  name: string;         // 歌曲名
  singer: string;       // 歌手
  source: string;       // 音源标识
  interval: string;     // 时长字符串 "04:15"
  meta: any;            // 完整的 songInfo（用于播放）
}

// ===== lxserver 歌单 (v1.5.0) =====

export interface LxPlaylist {
  id: string;           // 歌单ID: 'default' | 'love' | 自定义ID
  name: string;         // 歌单名称
  system: boolean;      // 是否系统歌单
  songs: LXFavoriteItem[];  // 歌曲列表
  songCount: number;    // 歌曲数量
}

export interface LXFavoriteResponse {
  defaultList: LXFavoriteItem[];
  loveList?: LXFavoriteItem[];
}

// ===== 播放历史 =====

export interface PlayHistoryItem {
  songId: string;
  title: string;
  artist: string;
  album?: string;
  cover?: string;           // 封面URL
  source: string;
  quality: string;
  duration?: number;
  playedAt: string;        // ISO8601
}

// ===== MIoT 桥接消息 =====

export interface MIoTDevice {
  account_id: string;
  device_id: string;
  device_name: string;
  model: string;
  alias: string;
  online: boolean;
}

export interface MIoTPlaybackControl {
  action: 'play' | 'pause' | 'next' | 'prev' | 'stop' | 'set_volume' | 'set_play_mode';
  account_id?: string;
  device_id?: string;
  volume?: number;
  play_mode?: string;
  url?: string;
  song_id?: number;
}

export interface MIoTStatusRequest {
  account_id?: string;
  device_id?: string;
}

// ===== 插件全局状态 =====

export interface PluginState {
  miotInstalled: boolean;
  miotConfigured: boolean;
  lxConnected: boolean;
  currentDevice: MIoTDevice | null;
  devices: MIoTDevice[];
  isPlaying: boolean;
  currentSong: CachedSong | null;
  playerStatus: {
    state: 'idle' | 'playing' | 'paused' | 'stopped';
    position: number;
    duration: number;
    volume: number;
    playMode: string;
  };
}

// ===== 降级记录 =====

export interface FallbackRecord {
  query: string;           // 原始搜索关键词
  attemptedSources: string[];  // 尝试过的音源
  finalSource: string;     // 最终成功的音源
  finalQuality: string;    // 最终音质
  downgradeReason: string; // 降级原因
  timestamp: string;       // ISO8601
}

export type FailureHint = 'invalid_url';

export interface FailureClassification {
  category: 'auth_config' | 'network' | 'no_result' | 'invalid_url' | 'platform_block' | 'timeout' | 'unknown';
  confidence: number;
  action: 'stop' | 'skip' | 'cooldown' | 'record';
  failureReason: string;
  isHighConfidence: boolean;
  shouldStop: boolean;
  httpStatus?: number;
}

export interface FallbackSearchResult {
  song: LXSearchResult | null;
  url: string | null;
  source: string;
  quality: string;
  fallbackSteps: string[];
  requestId: string;
  attempts: number;
  elapsedMs: number;
  failureReason?: string;
  failureClassification?: FailureClassification;
}
// ===== 自定义源管理 (v2.1.0) =====

export interface CustomSource {
  name: string;           // 源名称
  enabled: boolean;       // 是否启用
  version?: string;       // 版本号
  description?: string;   // 描述
  type?: string;          // 类型
  filename?: string;      // 文件名
}

export interface CustomSourceStats {
  customSourceName: string;
  platform: string;
  successCount: number;
  failCount: number;
  lastFailAt?: number;
}

// ===== 音频质量黑名单 (v1.9.0) =====

export type QualityBlacklistReason = 'clip' | 'mix';

export interface QualityBlacklistEntry {
  urlHash: string;              // URL两头(头40+尾80)哈希，P0缓存匹配用
  nameKey: string;              // "歌名|歌手".toLowerCase()，辅助信息
  reason: QualityBlacklistReason; // clip=片段, mix=串烧
  duration: number;             // 搜索结果标注时长(秒)
  actualDuration: number;       // HEAD推算的实际时长(秒)
  quality: string;              // 音质 "128k" | "320k" | "flac"
  timestamp: number;            // 记录/续期时间戳(命中续期时更新)
  lastHitAt?: number;           // 上次命中时间戳(用于二次命中续期判断)
  customSource?: string;        // v2.1.0: 自定义源名称
}

// ===== 收藏缓存 (v1.9.0) =====

export interface FavoriteCacheEntry {
  nameKey: string;  // "歌名|歌手".toLowerCase()
  source: string;   // 音源标识
}
