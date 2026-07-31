import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEntitySearchPath,
  mergeEntitySourcePages,
  normalizeEntitySearchPage,
  resolveEntitySources,
} from '../src/lxserver/entity-search.ts';

test('resolves supported sources by entity type', () => {
  assert.deepEqual(resolveEntitySources('singer', []), ['tx', 'wy']);
  assert.deepEqual(resolveEntitySources('playlist', []), ['kg', 'kw', 'tx', 'wy', 'mg']);
  assert.deepEqual(resolveEntitySources('singer', ['wy', 'wy']), ['wy']);
  assert.throws(() => resolveEntitySources('singer', ['kg']), /does not support/);
  assert.throws(() => resolveEntitySources('invalid' as any, []), /Unsupported entity search type/);
});

test('builds encoded lxserver paths for singer and playlist searches', () => {
  assert.equal(
    buildEntitySearchPath('singer', '周 杰伦', 'wy', 2, 10),
    '/api/music/search?name=%E5%91%A8%20%E6%9D%B0%E4%BC%A6&source=wy&type=singer&page=2&limit=10',
  );
  assert.equal(
    buildEntitySearchPath('playlist', '华语 经典', 'kg', 3, 50),
    '/api/music/songList/search?source=kg&text=%E5%8D%8E%E8%AF%AD%20%E7%BB%8F%E5%85%B8&page=3',
  );
});

test('normalizes singer array responses and estimates an additional page', () => {
  const page = normalizeEntitySearchPage(
    'singer',
    'tx',
    [
      { singerMID: 'mid-1', singerName: '歌手A', singerPic: 'a.jpg', alias: ['别名'], albumNum: 3 },
      { id: 'id-2', name: '歌手B', picUrl: 'b.jpg', albumSize: 8 },
    ],
    1,
    2,
  );

  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items[0], {
    id: 'mid-1',
    name: '歌手A',
    cover: 'a.jpg',
    alias: '别名',
    albumCount: 3,
    source: 'tx',
    _raw: { singerMID: 'mid-1', singerName: '歌手A', singerPic: 'a.jpg', alias: ['别名'], albumNum: 3 },
  });
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 4);
});

test('normalizes playlist object responses with exact totals', () => {
  const page = normalizeEntitySearchPage(
    'playlist',
    'wy',
    {
      list: [
        { id: 7, name: '经典歌单', img: 'cover.jpg', author: '创建者', total: 66 },
      ],
      total: 101,
      limit: 20,
      source: 'wy',
    },
    2,
    20,
  );

  assert.deepEqual(page.items[0], {
    id: '7',
    name: '经典歌单',
    cover: 'cover.jpg',
    creator: '创建者',
    songCount: 66,
    source: 'wy',
    _raw: { id: 7, name: '经典歌单', img: 'cover.jpg', author: '创建者', total: 66 },
  });
  assert.equal(page.total, 101);
  assert.equal(page.hasMore, true);
});

test('merges source pages, deduplicates by source and id, and keeps partial failures', () => {
  const txPage = normalizeEntitySearchPage(
    'singer',
    'tx',
    [{ id: 'same', name: '歌手A' }, { id: 'same', name: '重复项' }],
    1,
    20,
  );
  const wyPage = normalizeEntitySearchPage(
    'singer',
    'wy',
    [{ id: 'same', name: '歌手A' }],
    1,
    20,
  );

  const batch = mergeEntitySourcePages([txPage, wyPage], ['kg']);

  assert.equal(batch.items.length, 2);
  assert.deepEqual(batch.items.map(item => item.source), ['tx', 'wy']);
  assert.deepEqual(batch.failedSources, ['kg']);
  assert.deepEqual(batch.sourceHasMore, { tx: false, wy: false });
  assert.equal(batch.sourceTotals.tx, 2);
  assert.equal(batch.sourceTotals.wy, 1);
  assert.equal(batch.upstreamPage, 1);
});

test('drops malformed entities without a usable name', () => {
  const page = normalizeEntitySearchPage(
    'playlist',
    'mg',
    { list: [{ id: 'bad' }, null, { name: '有效歌单', id: 'ok' }] },
    1,
    20,
  );

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 'ok');
});
