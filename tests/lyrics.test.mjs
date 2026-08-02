import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadModel() {
  const context = {};
  vm.runInNewContext(readFileSync('static/js/lyrics.js', 'utf8'), context);
  return context.LyricsModel;
}

test('parses multi-timestamp LRC lines and ignores metadata or invalid lines', () => {
  const model = loadModel();
  const lines = model.parse('[ti:示例]\n[00:02.50][00:04.00]第一句\n[00:03.00]第二句\n纯文本\n[bad]坏行');
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
    { time: 2.5, text: '第一句' },
    { time: 3, text: '第二句' },
    { time: 4, text: '第一句' },
  ]);
});

test('sorts and de-duplicates identical lyric timestamps', () => {
  const model = loadModel();
  const lines = model.parse('[00:08]后句\n[00:02]前句\n[00:02]重复');
  assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
    { time: 2, text: '前句' },
    { time: 8, text: '后句' },
  ]);
});

test('finds the active line and formats elapsed time safely', () => {
  const model = loadModel();
  const lines = model.parse('[00:02]甲\n[00:05]乙\n[01:00]丙');
  assert.equal(model.activeIndex(lines, 0), -1);
  assert.equal(model.activeIndex(lines, 2), 0);
  assert.equal(model.activeIndex(lines, 4.9), 0);
  assert.equal(model.activeIndex(lines, 5), 1);
  assert.equal(model.activeIndex(lines, 100), 2);
  assert.equal(model.formatTime(65.9), '1:05');
  assert.equal(model.formatTime(-1), '0:00');
});

test('uses the matched song source for lyrics instead of a cache playback source', () => {
  const model = loadModel();
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.requestForSong({ id: 'matched-id', source: 'tx' }, 'cache'))),
    { id: 'matched-id', source: 'tx' },
  );
});

test('falls back to the originally selected song when the matched result is cached', () => {
  const model = loadModel();
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.requestForSong(
      { id: 'cache-id', source: 'cache' },
      'cache',
      { id: 'original-id', source: 'wy' },
    ))),
    { id: 'original-id', source: 'wy' },
  );
});

test('keeps an upstream lyric id in the browser lyric request', () => {
  const model = loadModel();
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.requestForSong({ id: 'song-id', source: 'tx', lyricId: 'lyric-id' }, 'tx'))),
    { id: 'song-id', source: 'tx', lyricId: 'lyric-id' },
  );
});

test('keeps source lyric metadata when preparing the browser request', () => {
  const model = loadModel();
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.requestForSong({
      id: 'song-id',
      source: 'kg',
      name: '歌曲名称',
      singer: '歌手',
      interval: '03:20',
      albumId: 'album-1',
      _raw: { hash: 'hash-value', lrcUrl: 'https://example.invalid/lrc' },
    }, 'kg'))),
    {
      id: 'song-id',
      source: 'kg',
      name: '歌曲名称',
      singer: '歌手',
      interval: '03:20',
      albumId: 'album-1',
      raw: { hash: 'hash-value', lrcUrl: 'https://example.invalid/lrc' },
    },
  );
});
