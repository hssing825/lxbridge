import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadModel() {
  const context = {};
  vm.runInNewContext(readFileSync('static/js/entity-search.js', 'utf8'), context);
  return context.EntitySearchModel;
}

test('normalizes search types and restricts singer sources', () => {
  const model = loadModel();
  assert.equal(model.normalizeType(), 'song');
  assert.equal(model.normalizeType('unknown'), 'song');
  assert.deepEqual(Array.from(model.sourcesForType('singer')), ['tx', 'wy']);
  assert.deepEqual(Array.from(model.sourcesForType('playlist')), ['kg', 'kw', 'tx', 'wy', 'mg']);
});

test('creates and resets state with a stable condition identity', () => {
  const model = loadModel();
  const state = model.createState('singer', ' 周杰伦 ', 'kg');
  assert.equal(state.type, 'singer');
  assert.equal(state.keyword, '周杰伦');
  assert.equal(state.source, '');
  assert.equal(state.conditionId, 'singer|周杰伦|');

  state.items.push({ source: 'tx', id: '1', name: '旧结果' });
  const reset = model.resetState(state, 'playlist', '经典', 'wy');
  assert.equal(reset.conditionId, 'playlist|经典|wy');
  assert.equal(reset.items.length, 0);
  assert.equal(reset.upstreamPage, 0);
});

test('merges batches by source and id while preserving pagination metadata', () => {
  const model = loadModel();
  let state = model.createState('singer', '歌手', '');
  state = model.mergeBatch(state, {
    items: [
      { source: 'tx', id: '1', name: '甲' },
      { source: 'wy', id: '1', name: '甲' },
    ],
    sourceTotals: { tx: 20, wy: 40 },
    sourceHasMore: { tx: false, wy: true },
    failedSources: [],
    upstreamPage: 1,
  });
  state = model.mergeBatch(state, {
    items: [
      { source: 'wy', id: '1', name: '重复' },
      { source: 'wy', id: '2', name: '乙' },
    ],
    sourceTotals: { wy: 60 },
    sourceHasMore: { wy: false },
    failedSources: ['tx'],
    upstreamPage: 2,
  });

  assert.equal(state.items.length, 3);
  assert.equal(state.upstreamPage, 2);
  assert.equal(state.sourceTotals.tx, 20);
  assert.equal(state.sourceTotals.wy, 60);
  assert.equal(state.sourceHasMore.tx, false);
  assert.equal(state.sourceHasMore.wy, false);
  assert.equal(state.sourcePages.tx, 1);
  assert.equal(state.sourcePages.wy, 2);
  assert.deepEqual(Array.from(state.failedSources), ['tx']);
  assert.equal(model.paginationTotal(state), 80);
});

test('pagination total never falls below cached items', () => {
  const model = loadModel();
  const state = model.createState('playlist', '经典', '');
  state.items = [{ source: 'kg', id: '1' }, { source: 'kg', id: '2' }];
  state.sourceTotals = { kg: 1 };
  assert.equal(model.paginationTotal(state), 2);
});

test('resolves song covers from normalized and raw detail shapes', () => {
  const model = loadModel();
  assert.equal(model.resolveSongCover({ cover: 'artist-cover.jpg', img: 'fallback.jpg' }), 'artist-cover.jpg');
  assert.equal(model.resolveSongCover({ img: 'playlist-song.jpg' }), 'playlist-song.jpg');
  assert.equal(model.resolveSongCover({ picUrl: 'detail-pic.jpg' }), 'detail-pic.jpg');
  assert.equal(model.resolveSongCover({ meta: { picUrl: 'legacy-meta.jpg' } }), 'legacy-meta.jpg');
  assert.equal(model.resolveSongCover({ _raw: { img: 'raw-song.jpg' } }), 'raw-song.jpg');
  assert.equal(model.resolveSongCover({}), '');
});

test('artist results pass a stable source and id into the unified artist page', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /App\.showArtist\([^\n]+item\.source[^\n]+item\.id/);
});

test('artist page uses shared pagination and does not cap the song list at 50', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /_renderPagination\('artistPagination'/);
  assert.doesNotMatch(app, /Math\.min\(songs\.length,\s*50\)/);
});
