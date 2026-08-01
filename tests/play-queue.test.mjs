import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadModel() {
  const context = {};
  vm.runInNewContext(readFileSync('static/js/play-queue.js', 'utf8'), context);
  return context.PlayQueueState;
}

function sampleItems() {
  return [
    { title: '歌1', artist: '甲', source: 'tx', id: '1' },
    { title: '歌2', artist: '甲', source: 'tx', id: '2' },
    { title: '歌3', artist: '乙', source: 'wy', id: '3' },
    { title: '歌4', artist: '丙', source: 'kg', id: '4' },
  ];
}

function titles(items) {
  return Array.from(items, (song) => song.title);
}

test('create normalizes index and never shares the input array', () => {
  const model = loadModel();
  const items = sampleItems();
  const state = model.create(items, 2, 'artist');
  assert.equal(state.currentIndex, 2);
  assert.equal(state.type, 'artist');
  assert.deepEqual(Array.from(state.items), items);
  assert.notEqual(state.items, items);

  const clampedLow = model.create(items, -3, '');
  assert.equal(clampedLow.currentIndex, 0);
  const clampedHigh = model.create(items, 99, '');
  assert.equal(clampedHigh.currentIndex, 3);
  const empty = model.create([], 0, '');
  assert.equal(empty.currentIndex, -1);
});

test('getView splits current and upcoming without auto-advance', () => {
  const model = loadModel();
  const items = sampleItems();
  let state = model.create(items, 1, 'favorites');
  let view = model.getView(state);
  assert.equal(view.current.title, '歌2');
  assert.deepEqual(titles(view.upcoming), ['歌3', '歌4']);

  state = model.create(items, 3, '');
  view = model.getView(state);
  assert.equal(view.current.title, '歌4');
  assert.deepEqual(Array.from(view.upcoming), []);

  state = model.create([], 0, '');
  view = model.getView(state);
  assert.equal(view.current, null);
  assert.deepEqual(Array.from(view.upcoming), []);
});

test('activate jumps to an upcoming song without mutating the input', () => {
  const model = loadModel();
  const items = sampleItems();
  const state = model.create(items, 0, 'list');
  const next = model.activate(state, 3);
  assert.equal(next.currentIndex, 3);
  assert.equal(model.getView(next).current.title, '歌4');
  assert.deepEqual(titles(items), ['歌1', '歌2', '歌3', '歌4']);
});

test('activate on current or invalid index keeps state', () => {
  const model = loadModel();
  const state = model.create(sampleItems(), 2, '');
  assert.equal(model.activate(state, 2), state);
  assert.equal(model.activate(state, -1), state);
  assert.equal(model.activate(state, 99), state);
});

test('removeUpcoming removes only songs after the current one', () => {
  const model = loadModel();
  const state = model.create(sampleItems(), 1, '');
  const next = model.removeUpcoming(state, 3);
  assert.deepEqual(titles(next.items), ['歌1', '歌2', '歌3']);
  assert.equal(next.currentIndex, 1);

  const before = model.removeUpcoming(state, 0);
  assert.equal(before, state);
  const current = model.removeUpcoming(state, 1);
  assert.equal(current, state);
  const invalid = model.removeUpcoming(state, 42);
  assert.equal(invalid, state);
});

test('moveUpcoming reorders within upcoming and keeps the current song fixed', () => {
  const model = loadModel();
  const state = model.create(sampleItems(), 1, '');
  const up = model.moveUpcoming(state, 3, -1);
  assert.deepEqual(titles(up.items), ['歌1', '歌2', '歌4', '歌3']);
  assert.equal(up.currentIndex, 1);

  const down = model.moveUpcoming(state, 2, 1);
  assert.deepEqual(titles(down.items), ['歌1', '歌2', '歌4', '歌3']);
  assert.equal(down.currentIndex, 1);

  const refused = model.moveUpcoming(state, 2, -1);
  assert.equal(refused, state);
  const invalid = model.moveUpcoming(state, 5, 1);
  assert.equal(invalid, state);
});

test('reorderUpcoming repositions an upcoming song at an arbitrary index', () => {
  const model = loadModel();
  const state = model.create(sampleItems(), 1, '');
  const toFront = model.reorderUpcoming(state, 3, 2);
  assert.deepEqual(titles(toFront.items), ['歌1', '歌2', '歌4', '歌3']);
  assert.equal(toFront.currentIndex, 1);

  const toBack = model.reorderUpcoming(state, 2, 3);
  assert.deepEqual(titles(toBack.items), ['歌1', '歌2', '歌4', '歌3']);
  assert.equal(toBack.currentIndex, 1);

  const crossed = model.reorderUpcoming(state, 3, 1);
  assert.equal(crossed, state);
});

test('clearUpcoming keeps the current song and everything before it', () => {
  const model = loadModel();
  const state = model.create(sampleItems(), 2, '');
  const cleared = model.clearUpcoming(state);
  assert.deepEqual(titles(cleared.items), ['歌1', '歌2', '歌3']);
  assert.equal(cleared.currentIndex, 2);

  const empty = model.create(sampleItems(), 0, '');
  assert.deepEqual(titles(model.clearUpcoming(empty).items), ['歌1']);
});

test('operations never mutate the source state', () => {
  const model = loadModel();
  const items = sampleItems();
  const state = model.create(items, 1, '');
  const snapshot = JSON.stringify(state);
  model.getView(state);
  model.activate(state, 3);
  model.removeUpcoming(state, 3);
  model.moveUpcoming(state, 3, -1);
  model.reorderUpcoming(state, 3, 2);
  model.clearUpcoming(state);
  assert.equal(JSON.stringify(state), snapshot);
  assert.equal(JSON.stringify(items), JSON.stringify(sampleItems()));
});

test('history queue does not pass storage records as lxserver raw song data', () => {
  const appSource = readFileSync('static/js/app.js', 'utf8');
  const historyQueueStart = appSource.indexOf('this.playQueue = this.historyResults.map');
  const historyQueueEnd = appSource.indexOf('this.currentQueueIndex = index;', historyQueueStart);
  assert.ok(historyQueueStart >= 0 && historyQueueEnd > historyQueueStart);

  const historyQueueSource = appSource.slice(historyQueueStart, historyQueueEnd);
  assert.doesNotMatch(historyQueueSource, /_raw\s*:\s*h\b/);
  assert.match(historyQueueSource, /id:\s*h\.songId\s*\|\|\s*h\.id/);
  assert.match(historyQueueSource, /name:\s*h\.title/);
  assert.match(historyQueueSource, /singer:\s*h\.artist/);
});
