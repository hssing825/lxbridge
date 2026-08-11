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

test('artist detail has separate song and album views with album-song pagination', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /showArtistAlbums\(page\)/);
  assert.match(app, /renderArtistAlbums\(page\)/);
  assert.match(app, /showAlbum\(albumName, source, albumId, cover\)/);
  assert.match(app, /renderAlbumSongs\(page\)/);
  assert.match(app, /_renderPagination\('artistAlbumPagination'/);
  assert.match(app, /_renderPagination\('albumSongsPagination'/);
  assert.match(app, /artist-tab/);
  assert.match(app, /暂无专辑|暂不支持专辑浏览/);
});

test('browser player page loads lyrics safely and never presents speaker lyrics as synchronized', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const template = readFileSync('static/index.template.html', 'utf8');
  const inline = readFileSync('scripts/inline.mjs', 'utf8');
  const api = readFileSync('static/js/api.js', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(template, /id="page-player"/);
  assert.match(app, /id="playerLyrics"/);
  assert.match(template, /App\.openPlayerPage\(\)/);
  assert.match(app, /loadLyricsForSong\(song, source, fallbackSong\)/);
  assert.match(app, /getCachedLyric\(/);
  assert.match(app, /saveCachedLyric\(/);
  assert.match(app, /seekToLyric\(index\)/);
  assert.match(app, /_lyricRequestId/);
  assert.match(app, /LyricsModel\.activeIndex/);
  assert.match(app, /当前设备不支持同步歌词/);
  assert.match(api, /getLyric:\s+function\(song\)/);
  assert.match(inline, /lyrics\.js/);
  assert.match(css, /\.lyric-line\{[^}]*cursor:pointer/);
  assert.match(css, /\.lyric-line:hover\{[^}]*color:#fff[^}]*text-shadow/);
});

test('browser player uses a discoverable full-screen vinyl layout', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const template = readFileSync('static/index.template.html', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(template, /player-open-btn/);
  assert.match(template, /打开播放器/);
  assert.match(app, /classList\.toggle\('player-mode'/);
  assert.match(app, /player-vinyl/);
  assert.match(css, /\.player-mode #page-player/);
  assert.match(css, /player-vinyl-spin/);
  assert.match(css, /prefers-reduced-motion/);
});

test('player stays within the viewport and uses the bottom cover state instead of a fullscreen badge', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(css, /\.player-mode #page-player\{[^}]*overflow:hidden/);
  assert.match(css, /\.player-screen\{height:100dvh[^}]*overflow:hidden/);
  assert.match(css, /\.player-page-layout\{[^}]*height:calc\(100dvh - 52px\)[^}]*min-height:0/);
  assert.doesNotMatch(css, /\.player-open-btn::after\{content:'⛶'/);
  assert.match(css, /\.player-open-btn\.is-playing/);
  assert.match(app, /coverEl\.classList\.toggle\('is-playing', this\.isPlaying\)/);
});

test('player enters from and exits to the bottom with a single downward collapse control', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(app, /playerPage\.classList\.remove\('player-entered'\)/);
  assert.match(app, /requestAnimationFrame\(function\(\)\s*\{\s*playerPage\.classList\.add\('player-entered'\)/);
  assert.match(app, /playerPage\.classList\.remove\('player-entered'\)/);
  assert.match(app, /class=\"player-screen-icon\" onclick=\"App\.closePlayerPage\(\)\">⌄</);
  assert.doesNotMatch(app, /data-tip=\"收起播放器\"/);
  assert.doesNotMatch(app, /data-tip=\"返回\" onclick=\"App\.closePlayerPage\(\)\">←/);
  assert.match(css, /\.player-mode #page-player\{[^}]*transform:translateY\(100%\)/);
  assert.match(css, /\.player-mode #page-player\.player-entered\{transform:translateY\(0\)/);
  assert.doesNotMatch(css, /\.player-screen-toolbar\{[^}]*border-bottom/);
  assert.doesNotMatch(css, /\.player-page-main\{[^}]*border-right:1px/);
  assert.doesNotMatch(css, /\.lyrics-heading\{[^}]*border-bottom/);
});

test('player keeps lyrics optional and removes toolbar, scrollbar, and volume visual clutter', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(app, /showLyrics: true/);
  assert.match(app, /togglePlayerLyrics\(\)/);
  assert.match(app, /player-lyrics-hidden/);
  assert.match(app, /data-tip=\"显示\/隐藏歌词\"/);
  assert.doesNotMatch(app, /player-toolbar-title/);
  assert.doesNotMatch(app, /同步歌词 <span>浏览器播放<\/span>/);
  assert.match(css, /\.player-screen-icon\{[^}]*border:0/);
  assert.match(css, /\.player-page-layout\.player-lyrics-hidden\{grid-template-columns:1fr/);
  assert.match(css, /\.lyrics-list::-webkit-scrollbar\{display:none/);
  assert.match(css, /\.player-page-main::-webkit-scrollbar,.lyrics-list::-webkit-scrollbar\{display:none/);
  assert.match(app, /id=\"playerPageVolumeFill\"/);
  assert.match(app, /id=\"playerPageVolumeIcon\"/);
  assert.match(app, /playerPageVolumeIcon[^>]*onclick=\"App\.toggleMute\(\)\"/);
  assert.doesNotMatch(app, /<div class=\"player-page-volume\" data-tip=\"音量\"/);
  assert.match(app, /if \(volume === 0\) this\.isMuted = true/);
  assert.match(app, /this\.applyVolumeUI\(\);\s*this\.showToast\('已静音'/);
  assert.match(app, /startPlayerPageVolumeDrag\(event\)/);
  assert.match(css, /\.player-page-volume \.volume-slider\{[^}]*height:28px/);
  assert.match(css, /\.player-page-volume \.volume-fill\{[^}]*height:3px/);
  assert.match(css, /\.player-page-volume-icon\{/);
  assert.match(css, /\.player-page-main\{[^}]*overflow-x:hidden/);
});

test('player reuses playback mode and queue controls with accessible scrub targets', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const css = readFileSync('static/css/style.css', 'utf8');
  assert.match(app, /id=\"playerPageModeBtn\"/);
  assert.match(app, /id=\"playerPageQueueBtn\"/);
  assert.match(app, /cyclePlayerPageMode\(\)/);
  assert.match(app, /togglePlayerQueue\(\)/);
  assert.doesNotMatch(app, /player-equalizer/);
  assert.doesNotMatch(css, /player-equalizer/);
  assert.match(css, /\.player-page-progress\{[^}]*min-height:28px/);
  assert.match(css, /\.player-page-volume\{[^}]*min-height:28px/);
  assert.match(css, /\.player-mode\.queue-open \.queue-panel\{[^}]*z-index:741/);
  assert.match(css, /\.player-page-info h2\{[^}]*color:#fff/);
  assert.match(css, /\.player-page-controls \.pc-btn:hover\{[^}]*color:#fff/);
  assert.match(css, /\.pc-btn\.play-btn\{width:34px;height:34px/);
  assert.match(css, /\.player-page-layout\.player-lyrics-hidden \.player-page-main\{[^}]*background:#0f1413/);
  assert.match(app, /vinyl\.classList\.toggle\('playing', this\.isBrowserMode && this\.isPlaying\)/);
});

test('speaker playback advances once after a completed song and uses the shared queue icon', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  const template = readFileSync('static/index.template.html', 'utf8');
  assert.match(template, /id="btnQueue"[^>]*>☷</);
  assert.match(app, /speakerPlaybackEndPending/);
  assert.match(app, /speakerNextInFlight/);
  assert.match(app, /controlPlayback\('next'\)/);
  assert.match(app, /speakerPauseRequested/);
  assert.match(app, /speakerObservedPlaying/);
  assert.match(app, /state === 'idle' \|\| state === 'stopped' \|\| state === 'ended'/);
  assert.match(app, /refreshSpeakerPlaybackState[\s\S]*?advanceSpeakerAfterCompletion\(status\.state\)/);
  assert.match(app, /speakerStatusRequestInFlight/);
  assert.match(app, /fetchSpeakerStatus\(\)/);
});

test('speaker playback preserves songlist durations and prefers resolved song duration', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /var duration = fav\.interval\s*\|\|\s*fav\.duration/);
  assert.match(app, /duration:\s*duration,\s*interval:\s*fav\.interval/);
  assert.match(app, /var durationCandidates = \[resolvedSong\.duration, resolvedSong\.interval, song\.duration, song\.interval\]/);
});

test('returning from the player preserves an open artist detail', () => {
  const app = readFileSync('static/js/app.js', 'utf8');
  assert.match(app, /pageName === 'artist' && !preserveContent/);
  assert.match(app, /switchPage\(this\._playerPageFrom[^\n]+true\)/);
});
