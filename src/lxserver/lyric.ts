function lyricValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return '';
}

type LyricRequestParams = {
  id: string;
  source: string;
  lyricId?: string;
  name?: string;
  singer?: string;
  interval?: string | number;
  albumId?: string;
  raw?: Record<string, unknown>;
};

function rawValue(params: LyricRequestParams, ...keys: string[]): string {
  const raw = params.raw && typeof params.raw === 'object' ? params.raw : {};
  for (const key of keys) {
    const value = lyricValue(raw[key]);
    if (value) return value;
  }
  return '';
}

function lyricSongInfo(params: LyricRequestParams, id: string): Record<string, string> {
  const songId = lyricValue(id);
  return {
    songmid: songId,
    songId,
    id: songId,
    source: lyricValue(params.source),
    name: lyricValue(params.name) || rawValue(params, 'name', 'title', 'songName'),
    singer: lyricValue(params.singer) || rawValue(params, 'singer', 'artist', 'author'),
    hash: rawValue(params, 'hash'),
    interval: lyricValue(params.interval) || rawValue(params, 'interval', 'duration'),
    copyrightId: rawValue(params, 'copyrightId'),
    albumId: lyricValue(params.albumId) || rawValue(params, 'albumId', 'albumMID', 'albumMid'),
    lrcUrl: rawValue(params, 'lrcUrl'),
    mrcUrl: rawValue(params, 'mrcUrl'),
    trcUrl: rawValue(params, 'trcUrl'),
  };
}

export function buildLyricGetPath(params: LyricRequestParams, id: string): string {
  const song = lyricSongInfo(params, id);
  const allowedKeys = ['source', 'songmid', 'songId', 'name', 'singer', 'hash', 'interval', 'copyrightId', 'albumId', 'lrcUrl', 'mrcUrl', 'trcUrl'];
  const query = allowedKeys
    .filter((key) => song[key])
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(song[key]))
    .join('&');
  return '/api/music/lyric?' + query;
}

export function buildLyricPostBody(params: LyricRequestParams, id: string): { songInfo: Record<string, string> } {
  return { songInfo: lyricSongInfo(params, id) };
}

export function lyricRequestIds(params: { id: string; lyricId?: string }): string[] {
  const primary = lyricValue(params.id);
  const lyricId = lyricValue(params.lyricId);
  if (!primary) return [];
  return lyricId && lyricId !== primary ? [primary, lyricId] : [primary];
}

export function extractLyricText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return '';

  const record = payload as Record<string, unknown>;
  if (record.success === false) return '';

  const direct = lyricValue(record.lyric) || lyricValue(record.lrc);
  if (direct) return direct;

  const data = record.data;
  if (!data || typeof data !== 'object') return '';
  const nested = data as Record<string, unknown>;
  return lyricValue(nested.lyric) || lyricValue(nested.lrc);
}
