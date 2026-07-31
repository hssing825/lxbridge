export type EntitySearchType = 'singer' | 'playlist';

export interface SingerSearchItem {
  id: string;
  name: string;
  cover: string;
  alias: string;
  albumCount: number;
  source: string;
  _raw: any;
}

export interface PlaylistSearchItem {
  id: string;
  name: string;
  cover: string;
  creator: string;
  songCount: number;
  source: string;
  _raw: any;
}

export type EntitySearchItem = SingerSearchItem | PlaylistSearchItem;

export interface EntitySourcePage {
  source: string;
  items: EntitySearchItem[];
  total: number;
  hasMore: boolean;
  upstreamPage: number;
}

export interface EntitySearchBatch {
  items: EntitySearchItem[];
  sourceTotals: Record<string, number>;
  sourceHasMore: Record<string, boolean>;
  failedSources: string[];
  upstreamPage: number;
}

const SOURCE_SUPPORT: Record<EntitySearchType, string[]> = {
  singer: ['tx', 'wy'],
  playlist: ['kg', 'kw', 'tx', 'wy', 'mg'],
};

function assertType(type: string): asserts type is EntitySearchType {
  if (type !== 'singer' && type !== 'playlist') {
    throw new Error('Unsupported entity search type: ' + type);
  }
}

export function resolveEntitySources(type: EntitySearchType, requested: string[]): string[] {
  assertType(type);
  const supported = SOURCE_SUPPORT[type];
  const normalized = (requested || [])
    .map(source => String(source || '').trim())
    .filter(Boolean);
  if (normalized.length === 0) return supported.slice();

  const resolved: string[] = [];
  for (const source of normalized) {
    if (!supported.includes(source)) {
      throw new Error(type + ' search does not support source: ' + source);
    }
    if (!resolved.includes(source)) resolved.push(source);
  }
  return resolved;
}

export function buildEntitySearchPath(
  type: EntitySearchType,
  keyword: string,
  source: string,
  page: number,
  limit: number,
): string {
  assertType(type);
  resolveEntitySources(type, [source]);
  const encodedKeyword = encodeURIComponent(keyword);
  if (type === 'singer') {
    return '/api/music/search?name=' + encodedKeyword +
      '&source=' + encodeURIComponent(source) +
      '&type=singer&page=' + page + '&limit=' + limit;
  }
  return '/api/music/songList/search?source=' + encodeURIComponent(source) +
    '&text=' + encodedKeyword + '&page=' + page;
}

function toText(value: any): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toCount(value: any): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function extractList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.list)) return payload.list;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  return [];
}

function extractTotal(payload: any): number | null {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  const value = payload.total ?? payload.data?.total;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function normalizeSinger(raw: any, source: string): SingerSearchItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = toText(raw.name ?? raw.singerName ?? raw.singername ?? raw.title);
  if (!name) return null;
  const id = toText(
    raw.id ?? raw.singerMID ?? raw.singerMid ?? raw.singermid ?? raw.singerid ?? raw.mid ?? name,
  );
  const aliasValue = raw.alias ?? raw.aliaName ?? raw.transNames ?? '';
  return {
    id,
    name,
    cover: toText(raw.picUrl ?? raw.singerPic ?? raw.pic ?? raw.img ?? raw.avatar),
    alias: Array.isArray(aliasValue) ? aliasValue.map(toText).filter(Boolean).join('、') : toText(aliasValue),
    albumCount: toCount(raw.albumSize ?? raw.albumCount ?? raw.album_count ?? raw.albumNum),
    source,
    _raw: raw,
  };
}

function normalizeCreator(raw: any): string {
  const creator = raw.creator;
  if (creator && typeof creator === 'object') {
    return toText(creator.name ?? creator.nickname ?? creator.userName);
  }
  return toText(raw.author ?? creator ?? raw.nickname ?? raw.userName ?? raw.username);
}

function normalizePlaylist(raw: any, source: string): PlaylistSearchItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = toText(raw.name ?? raw.title ?? raw.dissname ?? raw.specialname);
  if (!name) return null;
  const id = toText(raw.id ?? raw.list_id ?? raw.dissid ?? raw.specialid ?? name);
  return {
    id,
    name,
    cover: toText(raw.img ?? raw.cover ?? raw.pic ?? raw.picUrl ?? raw.imgurl),
    creator: normalizeCreator(raw),
    songCount: toCount(raw.total ?? raw.songCount ?? raw.song_count ?? raw.count ?? raw.trackCount),
    source,
    _raw: raw,
  };
}

export function normalizeEntitySearchPage(
  type: EntitySearchType,
  source: string,
  payload: any,
  page: number,
  limit: number,
): EntitySourcePage {
  assertType(type);
  const rawItems = extractList(payload);
  const items = rawItems
    .map(raw => type === 'singer' ? normalizeSinger(raw, source) : normalizePlaylist(raw, source))
    .filter((item): item is EntitySearchItem => item !== null);
  const responseLimit = toCount(payload?.limit) || limit;
  const exactTotal = extractTotal(payload);
  const hasMore = exactTotal === null
    ? rawItems.length > 0 && rawItems.length >= responseLimit
    : page * responseLimit < exactTotal;
  const total = exactTotal === null
    ? (page - 1) * responseLimit + items.length + (hasMore ? responseLimit : 0)
    : exactTotal;

  return { source, items, total, hasMore, upstreamPage: page };
}

export function mergeEntitySourcePages(
  pages: EntitySourcePage[],
  failedSources: string[] = [],
): EntitySearchBatch {
  const items: EntitySearchItem[] = [];
  const seen = new Set<string>();
  const sourceTotals: Record<string, number> = {};
  const sourceHasMore: Record<string, boolean> = {};
  let upstreamPage = 1;

  for (const page of pages) {
    sourceTotals[page.source] = page.total;
    sourceHasMore[page.source] = page.hasMore;
    upstreamPage = Math.max(upstreamPage, page.upstreamPage);
  }

  const maxItems = pages.reduce((max, page) => Math.max(max, page.items.length), 0);
  for (let index = 0; index < maxItems; index++) {
    for (const page of pages) {
      const item = page.items[index];
      if (!item) continue;
      const key = item.source + ':' + item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  return {
    items,
    sourceTotals,
    sourceHasMore,
    failedSources: Array.from(new Set(failedSources)),
    upstreamPage,
  };
}
