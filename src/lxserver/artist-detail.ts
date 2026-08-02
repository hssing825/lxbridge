import type { LXSearchResult } from './types';

export interface ArtistDetailFallback {
  id?: string;
  name?: string;
  cover?: string;
}

export interface ArtistDetail {
  id: string;
  name: string;
  cover: string;
  description: string;
  songCount: number;
  albumCount: number;
  source: string;
}

export interface ArtistAlbum {
  id: string;
  name: string;
  cover: string;
  publishDate: string;
  songCount: number;
  source: string;
  _raw: any;
}

const ARTIST_SOURCES = ['tx', 'wy'];

function assertArtistSource(source: string): void {
  if (!ARTIST_SOURCES.includes(source)) {
    throw new Error('Artist detail does not support source: ' + source);
  }
}

function requireArtistId(id: string): string {
  const value = String(id || '').trim();
  if (!value) throw new Error('Artist id is required');
  return value;
}

function requireAlbumId(id: string): string {
  const value = String(id || '').trim();
  if (!value) throw new Error('Album id is required');
  return value;
}

function text(value: any): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function count(value: any): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function unwrap(payload: any): any {
  return payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload;
}

function extractList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.list)) return payload.list;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  return [];
}

function durationSeconds(value: any): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const raw = text(value);
  if (!raw) return 0;
  const parts = raw.split(':').map(part => Number(part));
  if (parts.length === 2 && parts.every(Number.isFinite)) return Math.floor(parts[0] * 60 + parts[1]);
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function buildArtistDetailPath(source: string, id: string): string {
  assertArtistSource(source);
  return '/api/music/artistDetail?source=' + encodeURIComponent(source) +
    '&id=' + encodeURIComponent(requireArtistId(id));
}

export function buildArtistSongsPath(source: string, id: string, order: string = 'hot'): string {
  assertArtistSource(source);
  const normalizedOrder = text(order) || 'hot';
  return '/api/music/artistSongs?source=' + encodeURIComponent(source) +
    '&id=' + encodeURIComponent(requireArtistId(id)) +
    '&order=' + encodeURIComponent(normalizedOrder);
}

export function buildArtistAlbumsPath(source: string, id: string, page: number = 1, limit: number = 20): string {
  assertArtistSource(source);
  const normalizedPage = Math.max(1, Math.floor(Number(page) || 1));
  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
  return '/api/music/artistAlbums?source=' + encodeURIComponent(source) +
    '&id=' + encodeURIComponent(requireArtistId(id)) +
    '&page=' + normalizedPage + '&limit=' + normalizedLimit;
}

export function buildAlbumSongsPath(source: string, id: string): string {
  assertArtistSource(source);
  return '/api/music/albumSongs?source=' + encodeURIComponent(source) +
    '&id=' + encodeURIComponent(requireAlbumId(id));
}

export function normalizeArtistDetail(
  payload: any,
  source: string,
  fallback: ArtistDetailFallback = {},
): ArtistDetail {
  assertArtistSource(source);
  const raw = unwrap(payload) || {};
  return {
    id: text(raw.id) || text(fallback.id),
    name: text(raw.name) || text(fallback.name) || '未知歌手',
    cover: text(raw.avatar ?? raw.cover ?? raw.picUrl ?? raw.img) || text(fallback.cover),
    description: text(raw.desc ?? raw.description ?? raw.briefDesc),
    songCount: count(raw.musicSize ?? raw.songCount ?? raw.music_count),
    albumCount: count(raw.albumSize ?? raw.albumCount ?? raw.album_count),
    source,
  };
}

export function normalizeArtistSongs(payload: any, source: string): LXSearchResult[] {
  assertArtistSource(source);
  return extractList(payload).map((raw: any): LXSearchResult | null => {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.songmid ?? raw.songId ?? raw.id ?? raw.mid);
    const name = text(raw.name ?? raw.title ?? raw.songName);
    if (!id || !name) return null;
    const types = Array.isArray(raw.types) ? raw.types : [];
    const quality = types.length ? text(types[types.length - 1]?.type ?? types[types.length - 1]) : '';
    return {
      id,
      name,
      singer: text(raw.singer ?? raw.artist ?? raw.author),
      album: text(raw.albumName ?? raw.album),
      albumId: text(raw.albumId),
      duration: durationSeconds(raw.interval ?? raw.duration),
      cover: text(raw.img ?? raw.cover ?? raw.picUrl),
      source: text(raw.source) || source,
      quality,
      lyricId: text(raw.lrc ?? raw.lyricId),
      _raw: raw,
    };
  }).filter((song): song is LXSearchResult => song !== null);
}

export function normalizeArtistAlbums(payload: any, source: string): ArtistAlbum[] {
  assertArtistSource(source);
  return extractList(payload).map((raw: any): ArtistAlbum | null => {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.albumMID ?? raw.albumMid ?? raw.albumId ?? raw.id ?? raw.mid);
    const name = text(raw.albumName ?? raw.name ?? raw.title);
    if (!id || !name) return null;
    return {
      id,
      name,
      cover: text(raw.albumPic ?? raw.picUrl ?? raw.img ?? raw.cover ?? raw.pic),
      publishDate: text(raw.publishDate ?? raw.publishTime ?? raw.date ?? raw.time),
      songCount: count(raw.songNum ?? raw.songCount ?? raw.size ?? raw.total ?? raw.count),
      source: text(raw.source) || source,
      _raw: raw,
    };
  }).filter((album): album is ArtistAlbum => album !== null);
}

export function normalizeAlbumSongs(payload: any, source: string): LXSearchResult[] {
  assertArtistSource(source);
  return extractList(payload).map((raw: any): LXSearchResult | null => {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.songmid ?? raw.songId ?? raw.id ?? raw.mid);
    const name = text(raw.name ?? raw.title ?? raw.songName);
    if (!id || !name) return null;
    const types = Array.isArray(raw.types) ? raw.types : [];
    const quality = types.length ? text(types[types.length - 1]?.type ?? types[types.length - 1]) : '';
    return {
      id,
      name,
      singer: text(raw.singer ?? raw.artist ?? raw.author),
      album: text(raw.albumName ?? raw.album),
      albumId: text(raw.albumId ?? raw.albumMID ?? raw.albumMid),
      duration: durationSeconds(raw.interval ?? raw.duration),
      // Album endpoints may include both an album image and a per-song image.
      cover: text(raw.songPic ?? raw.songImg ?? raw.coverPic ?? raw.picUrl ?? raw.cover ?? raw.img ?? raw.albumPic),
      source: text(raw.source) || source,
      quality,
      lyricId: text(raw.lrc ?? raw.lyricId),
      _raw: raw,
    };
  }).filter((song): song is LXSearchResult => song !== null);
}
