import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLyricGetPath, buildLyricPostBody, extractLyricText, lyricRequestIds } from '../src/lxserver/lyric.ts';

test('extracts original LRC from supported lxserver response shapes', () => {
  assert.equal(extractLyricText({ success: true, data: { lyric: '[00:01]第一句' } }), '[00:01]第一句');
  assert.equal(extractLyricText({ data: { lrc: '[00:02]第二句' } }), '[00:02]第二句');
  assert.equal(extractLyricText({ lyric: '[00:03]第三句' }), '[00:03]第三句');
  assert.equal(extractLyricText('[00:04]第四句'), '[00:04]第四句');
});

test('does not treat failed or non-string lyric payloads as lyrics', () => {
  assert.equal(extractLyricText({ success: false, data: { lyric: '[00:01]错误结果' } }), '');
  assert.equal(extractLyricText({ data: { lyric: null } }), '');
  assert.equal(extractLyricText({}), '');
});

test('retries a distinct lyric id once after the song id', () => {
  assert.deepEqual(lyricRequestIds({ id: 'song-id', lyricId: 'lyric-id' }), ['song-id', 'lyric-id']);
  assert.deepEqual(lyricRequestIds({ id: 'song-id', lyricId: 'song-id' }), ['song-id']);
});

test('builds the lxserver GET lyric request with the metadata required by source SDKs', () => {
  const path = buildLyricGetPath({
    id: 'kg_hash_value',
    source: 'kg',
    name: '歌曲 名称',
    singer: '歌手',
    interval: '03:20',
    albumId: 'album-1',
    raw: {
      hash: 'hash-value',
      copyrightId: 'copyright-1',
      lrcUrl: 'https://example.invalid/lrc',
      mrcUrl: 'https://example.invalid/mrc',
      trcUrl: 'https://example.invalid/trc',
      ignoredSecret: 'must-not-be-sent',
    },
  }, 'kg_hash_value');

  assert.equal(
    path,
    '/api/music/lyric?source=kg&songmid=kg_hash_value&songId=kg_hash_value&name=%E6%AD%8C%E6%9B%B2%20%E5%90%8D%E7%A7%B0&singer=%E6%AD%8C%E6%89%8B&hash=hash-value&interval=03%3A20&copyrightId=copyright-1&albumId=album-1&lrcUrl=https%3A%2F%2Fexample.invalid%2Flrc&mrcUrl=https%3A%2F%2Fexample.invalid%2Fmrc&trcUrl=https%3A%2F%2Fexample.invalid%2Ftrc',
  );
  assert.equal(path.includes('ignoredSecret'), false);
});

test('builds a minimal songInfo body for the legacy lyric fallback', () => {
  assert.deepEqual(
    buildLyricPostBody({
      id: 'song-id',
      source: 'mg',
      name: '歌曲名称',
      singer: '歌手',
      raw: { copyrightId: 'copyright-1', lrcUrl: 'https://example.invalid/lrc', ignoredSecret: 'must-not-be-sent' },
    }, 'song-id'),
    {
      songInfo: {
        songmid: 'song-id',
        songId: 'song-id',
        id: 'song-id',
        source: 'mg',
        name: '歌曲名称',
        singer: '歌手',
        hash: '',
        interval: '',
        copyrightId: 'copyright-1',
        albumId: '',
        lrcUrl: 'https://example.invalid/lrc',
        mrcUrl: '',
        trcUrl: '',
      },
    },
  );
});
