import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArtistDetailPath,
  buildArtistSongsPath,
  normalizeArtistDetail,
  normalizeArtistSongs,
} from '../src/lxserver/artist-detail.ts';

test('builds encoded artist detail paths and rejects unsupported sources', () => {
  assert.equal(
    buildArtistDetailPath('tx', 'mid / 1'),
    '/api/music/artistDetail?source=tx&id=mid%20%2F%201',
  );
  assert.equal(
    buildArtistSongsPath('wy', '123', 'time'),
    '/api/music/artistSongs?source=wy&id=123&order=time',
  );
  assert.throws(() => buildArtistDetailPath('kg', '1'), /does not support/);
  assert.throws(() => buildArtistSongsPath('wy', '', 'hot'), /Artist id is required/);
});

test('normalizes artist detail with search-result fallbacks', () => {
  assert.deepEqual(
    normalizeArtistDetail(
      { id: 7, name: '歌手甲', avatar: 'avatar.jpg', desc: '简介', musicSize: 88, albumSize: 9 },
      'wy',
      { id: 'fallback', name: '旧名称', cover: 'fallback.jpg' },
    ),
    {
      id: '7',
      name: '歌手甲',
      cover: 'avatar.jpg',
      description: '简介',
      songCount: 88,
      albumCount: 9,
      source: 'wy',
    },
  );

  assert.equal(
    normalizeArtistDetail({}, 'tx', { id: 'mid', name: '歌手乙', cover: 'cover.jpg' }).cover,
    'cover.jpg',
  );
});

test('normalizes tx and wy artist songs for playback without truncation', () => {
  const songs = normalizeArtistSongs([
    {
      songId: 1,
      songmid: 'tx-mid',
      name: '歌曲甲',
      singer: '歌手甲',
      albumName: '专辑甲',
      interval: '03:05',
      img: 'tx.jpg',
      source: 'tx',
      types: [{ type: '128k' }, { type: 'flac' }],
    },
    {
      songmid: 2,
      name: '歌曲乙',
      singer: '歌手乙',
      albumName: '专辑乙',
      interval: 120,
      img: 'wy.jpg',
      source: 'wy',
    },
    { songmid: 3, singer: '缺少歌名' },
  ], 'tx');

  assert.equal(songs.length, 2);
  assert.deepEqual(songs[0], {
    id: 'tx-mid',
    name: '歌曲甲',
    singer: '歌手甲',
    album: '专辑甲',
    albumId: '',
    duration: 185,
    cover: 'tx.jpg',
    source: 'tx',
    quality: 'flac',
    lyricId: '',
    _raw: {
      songId: 1,
      songmid: 'tx-mid',
      name: '歌曲甲',
      singer: '歌手甲',
      albumName: '专辑甲',
      interval: '03:05',
      img: 'tx.jpg',
      source: 'tx',
      types: [{ type: '128k' }, { type: 'flac' }],
    },
  });
  assert.equal(songs[1].source, 'wy');
  assert.equal(songs[1].duration, 120);
});
