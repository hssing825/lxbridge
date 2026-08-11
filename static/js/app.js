// Songloft-LX Web UI — 主应用逻辑 v1.0.65
var App = {
  isPlaying: false,
  currentVolume: 50,
  playMode: 'order',
  playModes: ['order', 'random', 'single', 'loop'],
  playModeIdx: 0,
  playModeIcons: { order: '🔁', random: '🔀', single: '🔂', loop: '🔄' },
  currentSong: null,
  devices: [],
  currentDevice: null,
  searchTimer: null,
  searchViewState: 'landing',
  searchType: 'song',
  searchActiveKeyword: '',
  _searchRequestId: 0,
  _entityLoadRequestId: 0,
  _entityUpstreamLimit: 20,
  entitySearchState: null,
  artistDetailState: null,
  _artistRequestId: 0,
  _artistAlbumRequestId: 0,
  _lyricRequestId: 0,
  _lyricSongKey: '',
  lyricLines: [],
  lyricActiveIndex: -1,
  lyricState: 'idle',
  _lyricScrollHoldUntil: 0,
  _playerPageFrom: 'home',
  showLyrics: true,
  suggestTimer: null,
  _suggestRequestId: 0,
  searchResults: [],  // 存储完整的搜索结果（包含 _raw）
  favoritesResults: [],  // 存储完整的收藏列表（包含 meta）
  playlistsResults: [],  // 存储歌单列表 (v1.5.0)
  currentPlaylistId: '',  // 当前选中的歌单ID
  historyResults: [],  // 存储历史记录列表

  // ===== 分页系统 (v1.8.21) =====
  _pageSize: 20,          // 每页条数，可选 10/20/50
  _pageSizeOptions: [10, 20, 50],

  // 渲染分页控件
  // container: 目标容器ID或元素
  // total: 总条数
  // currentPage: 当前页(1-based)
  // callback: 翻页回调 function(pageNum)
  _renderPagination(container, total, currentPage, callback) {
    var el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    var pageSize = this._pageSize;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1 && total <= pageSize) { el.innerHTML = ''; return; }

    var self = this;
    var html = '<div class="pagination">';

    // 上一页
    html += '<button class="pg-btn' + (currentPage <= 1 ? ' disabled' : '') + '" data-pg="' + (currentPage - 1) + '">‹</button>';

    // 页码：显示首页、末页、当前页前后各2页，中间用省略号
    var pages = [];
    var start = Math.max(1, currentPage - 2);
    var end = Math.min(totalPages, currentPage + 2);
    if (start > 1) { pages.push(1); if (start > 2) pages.push('...'); }
    for (var i = start; i <= end; i++) pages.push(i);
    if (end < totalPages) { if (end < totalPages - 1) pages.push('...'); pages.push(totalPages); }

    for (var p = 0; p < pages.length; p++) {
      if (pages[p] === '...') {
        html += '<span class="pg-ellipsis">…</span>';
      } else {
        var pn = pages[p];
        html += '<button class="pg-btn' + (pn === currentPage ? ' active' : '') + '" data-pg="' + pn + '">' + pn + '</button>';
      }
    }

    // 下一页
    html += '<button class="pg-btn' + (currentPage >= totalPages ? ' disabled' : '') + '" data-pg="' + (currentPage + 1) + '">›</button>';

    // 信息
    html += '<span class="pg-info">' + total + ' 条</span>';

    // 每页条数下拉菜单
    html += '<span class="pg-size">每页:<select data-pgsize>';
    for (var s = 0; s < this._pageSizeOptions.length; s++) {
      var sz = this._pageSizeOptions[s];
      html += '<option value="' + sz + '"' + (sz === pageSize ? ' selected' : '') + '>' + sz + '</option>';
    }
    html += '</select></span>';

    html += '</div>';
    el.innerHTML = html;

    // 绑定事件
    el.querySelectorAll('.pg-btn[data-pg]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var pg = parseInt(this.getAttribute('data-pg'), 10);
        if (pg >= 1 && pg <= totalPages && pg !== currentPage && callback) callback(pg);
      });
    });
    el.querySelectorAll('.pg-size select[data-pgsize]').forEach(function(sel) {
      sel.addEventListener('change', function() {
        var newSize = parseInt(this.value, 10);
        if (newSize !== self._pageSize) {
          self._pageSize = newSize;
          localStorage.setItem('lx-page-size', String(newSize));
          if (callback) callback(1); // 切换条数后回到第1页
        }
      });
    });
  },

  // 前端切片渲染辅助
  // allData: 全量数据数组, page: 当前页, renderFn: function(slicedData, pageStartIndex)
  // 返回 { sliced, start, end, total }
  _slicePage(allData, page) {
    var ps = this._pageSize;
    var start = (page - 1) * ps;
    var end = Math.min(start + ps, allData.length);
    return { sliced: allData.slice(start, end), start: start, end: end, total: allData.length };
  },

  // ===== 浏览器播放器 (v1.0.54 新增) =====
  audioPlayer: null,  // HTML5 Audio 对象
  isBrowserMode: false,  // 是否为浏览器播放模式
  isMuted: false,  // 静音状态
  volumeBeforeMute: 50,  // 静音前的音量
  playQueue: [],  // 播放队列
  currentQueueIndex: -1,  // 当前播放的队列索引
  currentQueueType: '',  // 当前队列类型: search/favorites/history
  statusSyncTimer: null,  // 音箱状态同步定时器 (v1.0.65)
  songStartedAt: 0,  // 音箱播放开始时间戳 (v1.0.82)
  songDuration: 0,   // 当前歌曲时长(秒) (v1.0.82)
  speakerPlayStateProtectedUntil: 0,  // 推送成功后等待 MIoT 状态稳定的截止时间
  speakerPlaybackEndPending: false,
  speakerNextInFlight: false,
  speakerPauseRequested: false,
  speakerStatusRequestInFlight: false,
  browserPlaybackSnapshot: null,
  speakerPlaybackSnapshots: {},  // 仅记录本插件推送到各音箱的播放信息
  _cacheTriggeredForCurrentSong: false,  // v1.8.22: 当前歌曲是否已触发缓存
  _sourcePriority: ['kg', 'tx', 'wy', 'mg', 'kw'],  // v1.8.22: 音源优先级（可拖拽排序）
  logEntries: [],  // 日志面板数据 (v1.0.85)
  logStartTime: 0,  // 日志筛选起始时间 (v1.0.85)

  // ===== 初始化 =====
  async init() {
    API.init();  // ← 关键！从localStorage读取songloft注入的access_token
    // 先确定连接配置，再加载依赖该配置的页面和设备数据
    await this.autoRestoreConfig();
    this.setupGlobalClicks();
    this.initBrowserPlayer();  // 初始化浏览器播放器
    this.restorePlayMode();  // 恢复播放模式

    // 恢复每页条数
    var savedSize = localStorage.getItem('lx-page-size');
    if (savedSize) this._pageSize = parseInt(savedSize, 10) || 20;
    this.initSearchControls();

    // URL hash 路由：从 #/pageName 恢复页面
    var hash = window.location.hash.replace('#/', '').replace('#', '') || 'home';
    var validPages = ['home', 'search', 'favorites', 'history', 'settings', 'about', 'songlists', 'leaderboard', 'artist', 'player', 'diagnostics'];
    if (validPages.indexOf(hash) === -1) hash = 'home';
    this.switchPage(hash, document.querySelector('[data-page="' + hash + '"]'));

    await this.loadTheme();
    await this.checkMIoTStatus();
    await this.loadDevices();
    await this.loadPlayerStatus();
    await this.refreshHistory();
    this.initPlayModeDisplay();  // 初始化播放模式图标和提示语
    this.checkOnboarding();
    this.setupKeyboardShortcuts();  // 设置快捷键
    this.setupLogPanelResize();  // 日志面板拖拽调整宽度 (v1.0.85)
    setInterval(function() { App.loadPlayerStatus(); }, 10000);

  },

  // 后端未配置时，从 localStorage 自动恢复配置
  async autoRestoreConfig() {
    try {
      var backendResp = await API.getConfig();
      if (!backendResp || backendResp.success !== true || !backendResp.data) {
        console.log('[LX] 后端配置读取失败，跳过本地自动恢复');
        return;
      }
      if (ConfigSyncPolicy.hasConnectionIdentity(backendResp.data)) {
        console.log('[LX] 后端已有配置，跳过本地自动恢复');
        return;
      }

      var raw = localStorage.getItem('lx-local-config');
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!ConfigSyncPolicy.shouldRestore(backendResp, data)) return;

      console.log('[LX] 后端尚未配置，使用浏览器备份恢复...');
      var resp = await API.saveConfig({
        host: data.host,
        username: data.username,
        password: data.password || '',
        webPlayerUrl: data.webPlayerUrl || '',
        defaultQuality: data.quality || '320k',
        allowQualityDowngrade: data.qualityDowngrade !== false,
        enableCustomSources: data.customSources !== false,
        enableFuzzyMatch: data.fuzzyMatch !== false,
      });
      if (resp.success) {
        console.log('[LX] ✓ 后端配置已自动恢复');

        // v1.8.13: 配置恢复成功后，自动测试连接
        console.log('[LX] 自动测试连接...');
        var testResp = await API.testConnection();
        if (testResp.success) {
          console.log('[LX] ✓ 自动连接成功');
          this.showToast('✓ lxserver 已自动连接', false);
        } else {
          console.log('[LX] 自动连接失败:', testResp.message || testResp.error);
        }
      } else {
        console.log('[LX] 后端配置恢复失败:', resp.error);
      }
    } catch(e) {
      console.log('[LX] 自动恢复配置失败:', e);
    }
  },

  // ===== 恢复播放模式 (v1.0.54) =====
  restorePlayMode() {
    var savedMode = localStorage.getItem('lx-play-mode');
    if (savedMode === 'browser') {
      this.isBrowserMode = true;
    } else if (savedMode === 'miot') {
      this.isBrowserMode = false;
    }
    // 恢复音量
    var savedVolume = localStorage.getItem('lx-volume');
    if (savedVolume) {
      this.currentVolume = parseInt(savedVolume, 10);
      if (this.audioPlayer) {
        this.audioPlayer.volume = this.currentVolume / 100;
      }
      document.getElementById('volumeFill').style.width = this.currentVolume + '%';
    }
    // 设备恢复在 loadDevices() 中的 restoreSelectedDevice() 完成
  },

  // ===== 键盘快捷键 (v1.0.55) =====
  setupKeyboardShortcuts() {
    var self = this;
    document.addEventListener('keydown', function(e) {
      // 如果焦点在输入框，不触发快捷键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch(e.key) {
        case ' ':  // 空格：播放/暂停
          e.preventDefault();
          self.togglePlay();
          break;
        case 'ArrowLeft':  // 左键：上一曲
          e.preventDefault();
          self.controlPlayback('prev');
          break;
        case 'ArrowRight':  // 右键：下一曲
          e.preventDefault();
          self.controlPlayback('next');
          break;
        case 'ArrowUp':  // 上键：音量+10
          e.preventDefault();
          self.setVolume(Math.min(100, self.currentVolume + 10));
          break;
        case 'ArrowDown':  // 下键：音量-10
          e.preventDefault();
          self.setVolume(Math.max(0, self.currentVolume - 10));
          break;
        case 'm':  // M键：静音/取消静音
          self.toggleMute();
          break;
        case 'Escape':  // Esc：关闭队列面板
          self.closeQueuePanel();
          break;
      }
    });
  },

  // ===== 浏览器播放器初始化 (v1.0.54) =====
  initBrowserPlayer() {
    var self = this;
    this.audioPlayer = new Audio();
    this.audioPlayer.volume = this.currentVolume / 100;

    // 监听播放事件
    this.audioPlayer.addEventListener('play', function() {
      self.isPlaying = true;
      self.updatePlayButton();
    });

    this.audioPlayer.addEventListener('pause', function() {
      self.isPlaying = false;
      self.updatePlayButton();
    });

    this.audioPlayer.addEventListener('ended', function() {
      self.isPlaying = false;
      self.browserPlaybackSnapshot = null;
      self.updatePlayButton();
      // v1.8.22: 播放完成触发缓存（不区分浏览器/音箱模式，说明是真正想听的歌）
      self.triggerCacheOnComplete();
      // 自动播放下一首
      if (self.playMode !== 'single') {
        self.controlPlayback('next');
      }
    });

    this.audioPlayer.addEventListener('timeupdate', function() {
      if (self.isBrowserMode) {
        self.renderBrowserProgress();
        self.updateLyricsForTime();
      }
    });

    this.audioPlayer.addEventListener('error', function(e) {
      console.error('[BrowserPlayer] Error:', e);
      self.showToast('播放失败: ' + (self.audioPlayer.error ? self.audioPlayer.error.message : '未知错误'), true);
    });
  },

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    var mins = Math.floor(seconds / 60);
    var secs = Math.floor(seconds % 60);
    return mins + ':' + (secs < 10 ? '0' : '') + secs;
  },

  getDeviceKey(device) {
    if (!device) return '';
    return String(device.account_id || '') + ':' + String(device.device_id || '');
  },

  resetNowPlaying() {
    this.currentSong = null;
    this.songStartedAt = 0;
    this.songDuration = 0;
    this._cacheTriggeredForCurrentSong = false;
    var title = document.getElementById('playerTitle'); if (title) title.textContent = '未在播放';
    var artist = document.getElementById('playerArtist'); if (artist) artist.textContent = '选择歌曲开始';
    var cover = document.getElementById('playerCover');
    if (cover) {
      cover.style.backgroundImage = 'none';
      cover.textContent = '🎵';
      cover.classList.remove('is-playing');
    }
    var progress = document.getElementById('progressFill'); if (progress) progress.style.width = '0%';
    var currentTime = document.getElementById('currentTime'); if (currentTime) currentTime.textContent = '0:00';
    var totalTime = document.getElementById('totalTime'); if (totalTime) totalTime.textContent = '0:00';
    this.clearLyrics();
    this.syncPlayerPage();
  },

  renderBrowserProgress() {
    if (!this.audioPlayer || !isFinite(this.audioPlayer.duration) || this.audioPlayer.duration <= 0) {
      var emptyProgress = document.getElementById('progressFill'); if (emptyProgress) emptyProgress.style.width = '0%';
      return;
    }
    var currentTime = Math.max(0, this.audioPlayer.currentTime || 0);
    var progress = Math.min(100, (currentTime / this.audioPlayer.duration) * 100);
    var fill = document.getElementById('progressFill'); if (fill) fill.style.width = progress + '%';
    var current = document.getElementById('currentTime'); if (current) current.textContent = this.formatTime(currentTime);
    var total = document.getElementById('totalTime'); if (total) total.textContent = this.formatTime(this.audioPlayer.duration);
    var playerFill = document.getElementById('playerPageProgressFill'); if (playerFill) playerFill.style.width = progress + '%';
    var playerCurrent = document.getElementById('playerPageCurrentTime'); if (playerCurrent) playerCurrent.textContent = this.formatTime(currentTime);
    var playerTotal = document.getElementById('playerPageTotalTime'); if (playerTotal) playerTotal.textContent = this.formatTime(this.audioPlayer.duration);
  },

  refreshBrowserPlaybackState() {
    if (!this.audioPlayer || !this.audioPlayer.src || this.audioPlayer.ended) {
      this.isPlaying = false;
      this.resetNowPlaying();
      this.updatePlayButton();
      return;
    }
    this.isPlaying = !this.audioPlayer.paused && !this.audioPlayer.ended;
    var snapshot = this.browserPlaybackSnapshot;
    if (snapshot && snapshot.song) {
      this.updateNowPlaying(snapshot.song, snapshot.source, snapshot.quality);
    } else {
      this.resetNowPlaying();
    }
    this.renderBrowserProgress();
    this.currentVolume = Math.round((this.audioPlayer.volume || 0) * 100);
    if (this.currentVolume > 0) this.isMuted = false;
    this.applyVolumeUI();
    this.updatePlayButton();
  },

  saveSpeakerPlaybackSnapshot(song, source, quality, duration) {
    var key = this.getDeviceKey(this.currentDevice);
    if (!key || !song) return;
    this.speakerPlaybackSnapshots[key] = {
      song: song,
      source: source || '',
      quality: quality || '',
      duration: duration || 0,
      startedAt: this.songStartedAt,
    };
  },

  saveBrowserPlaybackSnapshot(song, source, quality, lyricSong) {
    this.browserPlaybackSnapshot = { song: song, source: source || '', quality: quality || '', lyricSong: lyricSong || song };
  },

  restoreSpeakerPlaybackSnapshot() {
    var snapshot = this.speakerPlaybackSnapshots[this.getDeviceKey(this.currentDevice)];
    if (!snapshot) {
      this.resetNowPlaying();
      return false;
    }
    this.currentSong = snapshot.song;
    this.songDuration = snapshot.duration || 0;
    this.songStartedAt = snapshot.startedAt || 0;
    this.updateNowPlaying(snapshot.song, snapshot.source, snapshot.quality);
    return true;
  },

  clearSpeakerPlaybackSnapshot() {
    var key = this.getDeviceKey(this.currentDevice);
    if (key) delete this.speakerPlaybackSnapshots[key];
  },

  applyVolumeUI() {
    var volume = Math.max(0, Math.min(100, Math.round(this.currentVolume || 0)));
    this.currentVolume = volume;
    var visibleVolume = this.isMuted ? 0 : volume;
    var fill = document.getElementById('volumeFill'); if (fill) fill.style.width = visibleVolume + '%';
    if (volume === 0) this.isMuted = true;
    this.updateVolumeIcon();
    this.updateMobileVolumeUI();
    var playerFill = document.getElementById('playerPageVolumeFill');
    if (playerFill) playerFill.style.width = (this.isMuted ? 0 : volume) + '%';
    var playerSlider = document.getElementById('playerPageVolume');
    if (playerSlider) {
      playerSlider.setAttribute('aria-valuenow', String(volume));
      playerSlider.setAttribute('aria-valuetext', volume + '%');
    }
  },

  renderSpeakerProgress() {
    if (this.songStartedAt <= 0 || this.isBrowserMode) return;
    var duration = this.songDuration || 240;
    var elapsed = Date.now() / 1000 - this.songStartedAt;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > duration) elapsed = duration;
    var progress = document.getElementById('progressFill'); if (progress) progress.style.width = ((elapsed / duration) * 100) + '%';
    var currentTime = document.getElementById('currentTime'); if (currentTime) currentTime.textContent = this.formatTime(elapsed);
    var totalTime = document.getElementById('totalTime'); if (totalTime) totalTime.textContent = this.formatTime(duration);
  },

  async fetchSpeakerStatus() {
    if (this.speakerStatusRequestInFlight) return null;
    this.speakerStatusRequestInFlight = true;
    try {
      return await API.getPlayerStatus();
    } finally {
      this.speakerStatusRequestInFlight = false;
    }
  },

  async refreshSpeakerPlaybackState(clearWhenInactive) {
    if (this.isBrowserMode || !this.currentDevice) return;
    if (clearWhenInactive) {
      this.speakerPlaybackEndPending = false;
    }
    var resp = await this.fetchSpeakerStatus();
    if (resp === null) return;
    if (!resp || !resp.success) {
      this.restoreSpeakerPlaybackSnapshot();
      return;
    }
    var status = resp.data || resp;
    this.isPlaying = status.state === 'playing';
    if (status.volume !== undefined && status.volume >= 0) {
      this.currentVolume = Math.round(status.volume);
      if (this.currentVolume > 0) this.isMuted = false;
    }
    this.applyVolumeUI();
    if (status.state !== 'playing' && clearWhenInactive) {
      this.resetNowPlaying();
      this.updatePlayButton();
      return;
    }
    if (status.state === 'playing' && !this.restoreSpeakerPlaybackSnapshot()) {
      // MIoT currently does not reliably return song metadata or position.
      // Do not show the previous browser song for an unknown speaker session.
      this.resetNowPlaying();
    }
    this.renderSpeakerProgress();
    this.advanceSpeakerAfterCompletion(status.state);
    this.updatePlayButton();
  },

  // v1.0.82: 解析时长字符串 "03:45" → 225 秒
  parseDuration(str) {
    if (!str || typeof str !== 'string') return 0;
    var parts = str.split(':');
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    return parseInt(str) || 0;
  },

  // 解码HTML实体（lxserver返回URL可能包含 &amp; 或双重编码 &amp;amp; 等）
  // 使用 split/join 避免 QuickJS 正则可能的问题
  decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    var original = str;
    var prev;
    do {
      prev = str;
      str = str.split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'");
    } while (str !== prev);
    if (original !== str) {
      console.log('[DEBUG] decodeHtmlEntities: decoded', original.substring(0, 80), '->', str.substring(0, 80));
    }
    return str;
  },

  // ===== 本地设置持久化（浏览器 localStorage，填了就存，刷新不丢）=====
  saveLocalSettings() {
    var host = document.getElementById('cfgHost') ? document.getElementById('cfgHost').value : '';
    var username = document.getElementById('cfgUser') ? document.getElementById('cfgUser').value : '';
    var enteredPassword = document.getElementById('cfgPass') ? document.getElementById('cfgPass').value : '';
    var previousConfig = null;
    try {
      previousConfig = JSON.parse(localStorage.getItem('lx-local-config') || 'null');
    } catch(e) {}

    var data = {
      host: host,
      username: username,
      password: ConfigSyncPolicy.resolveLocalPassword(
        previousConfig,
        { host: host, username: username },
        enteredPassword,
      ),
      webPlayerUrl: document.getElementById('cfgWebPlayer') ? document.getElementById('cfgWebPlayer').value : '',
      quality: document.getElementById('cfgQuality') ? document.getElementById('cfgQuality').value : '320k',
      qualityDowngrade: document.getElementById('cfgQualityDowngrade') ? document.getElementById('cfgQualityDowngrade').checked : true,
      customSources: document.getElementById('cfgCustomSources') ? document.getElementById('cfgCustomSources').checked : true,
      fuzzyMatch: document.getElementById('cfgFuzzyMatch') ? document.getElementById('cfgFuzzyMatch').checked : true,
    };
    localStorage.setItem('lx-local-config', JSON.stringify(data));
  },

  restoreLocalSettings() {
    var raw = localStorage.getItem('lx-local-config');
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      var fields = {
        cfgHost: data.host || '',
        cfgUser: data.username || '',
        cfgPass: data.password || '',
        cfgWebPlayer: data.webPlayerUrl || '',
      };
      for (var id in fields) {
        var el = document.getElementById(id);
        if (el && fields[id]) el.value = fields[id];
      }
      if (data.quality && document.getElementById('cfgQuality')) document.getElementById('cfgQuality').value = data.quality;
      if (document.getElementById('cfgQualityDowngrade')) document.getElementById('cfgQualityDowngrade').checked = data.qualityDowngrade !== false;
      if (document.getElementById('cfgCustomSources')) document.getElementById('cfgCustomSources').checked = data.customSources !== false;
      if (document.getElementById('cfgFuzzyMatch')) document.getElementById('cfgFuzzyMatch').checked = data.fuzzyMatch !== false;
    } catch(e) {}
  },

  // 监听设置页输入变化，自动保存
  setupSettingsAutoSave() {
    var self = this;
    var ids = ['cfgHost', 'cfgUser', 'cfgPass', 'cfgWebPlayer'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) {
        el.addEventListener('input', function() { self.saveLocalSettings(); });
        el.addEventListener('change', function() { self.saveLocalSettings(); });
      }
    }
    var checkboxes = ['cfgQualityDowngrade', 'cfgCustomSources', 'cfgFuzzyMatch'];
    for (var j = 0; j < checkboxes.length; j++) {
      var cb = document.getElementById(checkboxes[j]);
      if (cb) cb.addEventListener('change', function() { self.saveLocalSettings(); });
    }
    var sel = document.getElementById('cfgQuality');
    if (sel) sel.addEventListener('change', function() { self.saveLocalSettings(); });
  },

  // ===== 页面切换 =====
  switchPage(pageName, el, preserveContent) {
    var pluginName = window.__PLUGIN_NAME__ || 'LX音乐桥';
    var pageTitles = {
      home: '首页',
      search: '搜索',
      songlists: '歌单',
      leaderboard: '排行榜',
      favorites: '收藏',
      history: '播放历史',
      settings: '设置',
      about: '关于',
      artist: '歌手',
      player: '播放器',
      diagnostics: '系统诊断'
    };
    document.title = (pageTitles[pageName] || pluginName) + ' - ' + pluginName;
    document.body.classList.toggle('player-mode', pageName === 'player');
    // 移动端：切换页面时自动关闭侧边栏
    if (window.innerWidth <= 768) {
      this.closeSidebar();
    }
    // 更新URL（兼容iframe + base标签）
    try {
      var url = window.location.pathname + window.location.search + '#/' + pageName;
      window.history.replaceState(null, '', url);
    } catch(e) {}

    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    var page = document.getElementById('page-' + pageName);
    if (page) {
      page.classList.add('active');
      if (pageName === 'player') page.classList.add('player-entered');
      else page.classList.remove('player-entered', 'player-exiting');
    }

    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    document.querySelectorAll('.mobile-nav-item').forEach(function(n) { n.classList.remove('active'); });

    var desktopBtn = document.querySelector('.nav-item[data-page="' + pageName + '"]');
    var mobileBtn = document.querySelector('.mobile-nav-item[data-page="' + pageName + '"]');
    if (desktopBtn) desktopBtn.classList.add('active');
    if (mobileBtn) mobileBtn.classList.add('active');

    if (pageName === 'history') this.refreshHistory();
    if (pageName === 'home') this.loadHomePage();
    if (pageName === 'search') {
      this.syncSearchControls();
      var si = document.getElementById('searchInput');
      if (!si || !si.value.trim()) this.setSearchViewState('landing');
    }
    if (pageName === 'songlists' && !preserveContent) this.loadSongListTags();
    if (pageName === 'leaderboard') this.loadLeaderBoards();
    if (pageName === 'artist' && !preserveContent) this.loadArtistPage();
    if (pageName === 'favorites') this.refreshPlaylists();
    if (pageName === 'settings') {
      this.restoreLocalSettings();
      this.setupSettingsAutoSave();
      this.renderSourcePriority();  // v1.8.22: 渲染音源优先级
    }
    if (pageName === 'diagnostics') {
      this.loadDiagnostics();
    }
  },

  goToSettings() {
    this.switchPage('settings', document.querySelector('[data-page=settings]'));
  },

  goToDiagnostics() {
    this.switchPage('diagnostics', null);
  },

  // ===== 系统诊断中心 (v2.6.0) =====
  async loadDiagnostics() {
    var container = document.getElementById('diagnosticsContent');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--text-tertiary);">加载中...</p>';
    var resp = await API.getDiagnosticsOverview();
    if (!resp.success || !resp.data) {
      container.innerHTML = '<div class="status-banner error">诊断数据加载失败: ' + this._escapeHtml(resp.error || '未知错误') + '</div>';
      return;
    }
    this.renderDiagnostics(resp.data);
  },

  renderDiagnostics(data) {
    var container = document.getElementById('diagnosticsContent');
    if (!container) return;
    var self = this;
    var state = function(label, level) {
      return '<span class="diag-state ' + level + '">' + self._escapeHtml(label) + '</span>';
    };
    var row = function(label, value) {
      return '<div class="diag-row"><span class="diag-label">' + self._escapeHtml(label) + '</span><span class="diag-value">' + value + '</span></div>';
    };
    var card = function(id, title, rows) {
      return '<section class="diag-card" data-diag-card="' + id + '"><h3>' + title + '</h3>' + rows.join('') + '</section>';
    };
    var overallLevel = data.health.overall === 'ok' ? 'success' : data.health.overall === 'warn' ? 'warn' : 'error';
    var overallText = data.health.overall === 'ok' ? '系统正常' : data.health.overall === 'warn' ? '部分项目需关注' : '系统存在异常';
    var lxLevel = data.lxserver.connected === true ? 'ok' : data.lxserver.connected === false ? 'error' : 'warn';
    var lxText = data.lxserver.connected === true ? '已连接' : data.lxserver.connected === false ? '连接失败' : '未检查';
    var miotLevel = data.miot.installed && data.miot.configured ? 'ok' : data.miot.installed ? 'warn' : 'error';
    var miotText = data.miot.installed ? (data.miot.configured ? '正常' : '未配置') : '未安装';
    var cooldownCount = data.platformCooldowns.active.length;
    var cooldownText = cooldownCount === 0 ? '无' : cooldownCount + ' 项';
    var cooldownLevel = cooldownCount === 0 ? 'ok' : 'warn';
    if (data.health.overall === 'ok' && cooldownCount > 0) {
      overallLevel = 'warn';
      overallText = '系统可用，部分来源冷却';
    }
    var sourcePriority = data.lxserver.sourcePriority && data.lxserver.sourcePriority.length > 0
      ? self._escapeHtml(data.lxserver.sourcePriority.join(' → '))
      : '未配置';

    var html = '<div class="status-banner diag-status-banner ' + overallLevel + '">';
    html += '<strong>● ' + overallText + '</strong>';
    html += '<div class="diag-status-points"><span>服务 ' + state(lxText, lxLevel) + '</span>';
    html += '<span>MIoT ' + state(miotText, miotLevel) + '</span>';
    html += '<span>来源冷却 ' + state(cooldownText, cooldownLevel) + '</span></div></div>';

    var coreRows = [
      row('lxserver', state(lxText, lxLevel)),
      row('登录令牌', state(data.lxserver.tokenValid ? '有效' : '无效', data.lxserver.tokenValid ? 'ok' : 'warn')),
      row('MIoT', state(miotText, miotLevel)),
      row('在线设备', data.miot.onlineDeviceCount + ' / ' + data.miot.deviceCount),
    ];
    var protectionRows = [
      row('来源冷却', state(cooldownText, cooldownLevel)),
      row('音质黑名单', data.cache.blacklistCount + ' 条'),
      row('降级记录', data.cache.fallbackLogCount + ' 条'),
      row('最近失败', state(data.errorSummary.total === 0 ? '无' : data.errorSummary.total + ' 条', data.errorSummary.total === 0 ? 'ok' : 'warn')),
    ];
    var sourceRows = [
      row('自定义源', data.customSources.enabled + ' / ' + data.customSources.total),
      row('默认音质', self._escapeHtml(data.lxserver.defaultQuality || '-')),
      row('音源顺序', sourcePriority),
      row('Web播放器', data.lxserver.webPlayerConfigured ? '已配置' : '未配置'),
    ];
    var localRows = [
      row('播放历史', data.cache.historyCount + ' 条'),
      row('播放追踪', data.recent.playback.total + ' 条'),
      row('自定义源统计', data.cache.customSourceStatCount + ' 条'),
      row('语音失败', data.recent.voice.failures + ' 次'),
    ];
    html += '<div class="diag-summary-grid">';
    html += card('core', '核心服务', coreRows);
    html += card('protection', '播放保护', protectionRows);
    html += card('sources', '音源与配置', sourceRows);
    html += card('local', '本地数据', localRows);
    html += '</div>';

    var issueCount = data.health.checks.filter(function(check) { return check.level !== 'ok'; }).length;
    html += '<details class="diag-disclosure"><summary>异常与最近活动 <span>' + (issueCount + cooldownCount + data.errorSummary.total) + '</span></summary><div class="diag-disclosure-body">';
    if (issueCount === 0 && cooldownCount === 0 && data.errorSummary.total === 0) {
      html += '<p class="diag-empty">当前未检测到异常</p>';
    }
    for (var h = 0; h < data.health.checks.length; h++) {
      var check = data.health.checks[h];
      if (check.level === 'ok') continue;
      html += row(check.label, state(check.detail, check.level));
    }
    for (var c = 0; c < data.platformCooldowns.active.length; c++) {
      var cooldown = data.platformCooldowns.active[c];
      html += row('来源冷却', self._escapeHtml(cooldown.platform) + '，剩余 ' + cooldown.remainingSeconds + ' 秒');
    }
    var errorLabels = {
      auth_config: '认证或配置', network: '网络', no_result: '无结果', invalid_url: '无效地址',
      platform_block: '访问限制', timeout: '超时', unknown: '其他'
    };
    for (var e = 0; e < data.errorSummary.byCategory.length; e++) {
      var err = data.errorSummary.byCategory[e];
      html += row(errorLabels[err.category] || '其他', err.count + ' 条');
    }
    if (data.recent.fallback.length > 0) {
      html += '<div class="diag-recent">';
      for (var r = 0; r < Math.min(5, data.recent.fallback.length); r++) {
        var rec = data.recent.fallback[r];
        html += '<div class="diag-recent-item">' + self._escapeHtml(rec.time ? new Date(rec.time).toLocaleString('zh-CN', {hour12: false}) : '--') +
          ' · ' + self._escapeHtml(rec.finalSource || '未知') + '/' + self._escapeHtml(rec.finalQuality || '-') +
          (rec.reason ? ' · ' + self._escapeHtml(rec.reason) : '') + '</div>';
      }
      html += '</div>';
    }
    html += '</div></details>';

    html += '<details class="diag-disclosure"><summary>高级事件</summary><div class="diag-disclosure-body diag-event-actions">';
    html += '<button class="btn btn-secondary btn-sm" onclick="App.toggleTimeline()">🕐 时间线</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="App.toggleLogPanel()">📊 日志</button>';
    html += '</div></details>';

    container.innerHTML = html;
  },

  async copyDiagnosticsReport() {
    var resp = await API.getDiagnosticsReport();
    if (!resp.success || !resp.data || !resp.data.report) {
      this.showToast('诊断报告生成失败: ' + (resp.error || '未知错误'));
      return;
    }
    var text = resp.data.report;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      this.showToast('诊断报告已复制');
    } catch (e) {
      console.error('[Diagnostics] copy failed:', e);
      this.showToast('复制失败，请手动复制');
    }
  },

  setupGlobalClicks() {
    var self = this;
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.device-switcher'))
        document.getElementById('deviceDropdown').classList.remove('show');
      if (!e.target.closest('.theme-wrap'))
        document.getElementById('themeDropdown').classList.remove('show');
    });
  },

  // ===== 设备 =====
  toggleDeviceDropdown() { document.getElementById('deviceDropdown').classList.toggle('show'); },

  async loadDevices() {
    var resp = await API.getDevices();
    console.log('[LX] loadDevices raw resp:', JSON.stringify(resp).substring(0, 500));
    if (resp.success && resp.data) {
      // MIoT 返回格式可能是 {success:true, data:{accounts:[...], devices:[...]}}
      // 也可能 devices 直接在 data 里或包裹在别的字段
      var data = resp.data;
      console.log('[LX] data keys:', Object.keys(data));
      console.log('[LX] data.devices:', data.devices);
      console.log('[LX] data.accounts:', data.accounts ? data.accounts.length : 'none');

      // MIoT 返回 data 是账号数组: [{account_id, devices:[{deviceID,name,...}]}]
      var devList = [];
      if (Array.isArray(data)) {
        // 从每个账号中提取设备
        for (var i = 0; i < data.length; i++) {
          var acc = data[i];
          if (Array.isArray(acc.devices)) {
            for (var j = 0; j < acc.devices.length; j++) {
              var d = acc.devices[j];
              devList.push({
                account_id: acc.account_id || acc.accountId || '',
                device_id: d.deviceID || d.device_id || '',
                device_name: d.name || d.alias || d.device_name || '未知',
                model: d.model || '',
                alias: d.alias || d.name || '',
                online: d.presence === 'online' || d.online === true
              });
            }
          }
        }
      } else if (data.devices) {
        devList = data.devices;
      }

      this.devices = devList;
      console.log('[LX] parsed devices count:', this.devices.length);
      this.currentDevice = null;
      // 恢复上次选择的设备
      this.restoreSelectedDevice();
      // 如果没恢复成功，选第一个在线设备
      if (!this.currentDevice) {
        for (var k = 0; k < devList.length; k++) {
          if (devList[k].online) { this.currentDevice = devList[k]; break; }
        }
      }
      this.renderDeviceDropdown();
      this.renderCurrentDevice();
    } else {
      console.log('[LX] loadDevices FAILED:', resp.error, 'httpStatus:', resp.httpStatus);
      document.getElementById('deviceDropdown').innerHTML = '<div class="device-item"><span style="color:var(--danger);">加载失败: ' + (resp.error || '') + '</span></div>';
    }
  },

  renderDeviceDropdown() {
    var dd = document.getElementById('deviceDropdown');
    var self = this;

    // 添加"当前浏览器"选项
    var browserOption = '<div class="device-item' + (this.isBrowserMode ? ' active' : '') + '" onclick="App.selectBrowserMode()">' +
      '<span class="dot"></span>' +
      '<span class="dev-name">🖥 当前浏览器</span>' +
      '<span class="dev-status">本地播放</span></div>';

    if (this.devices.length === 0) {
      dd.innerHTML = browserOption + '<div class="device-item"><span style="color:var(--text-tertiary);">暂无音箱设备，请先配置MIoT插件</span></div>';
      return;
    }

    var deviceItems = this.devices.map(function(d) {
      var active = !self.isBrowserMode && self.currentDevice && self.currentDevice.device_id === d.device_id;
      return '<div class="device-item' + (active ? ' active' : '') + '" onclick="App.selectDevice(\'' + d.account_id + '\',\'' + d.device_id + '\')">' +
        '<span class="dot' + (d.online ? '' : ' offline') + '"></span>' +
        '<span class="dev-name">' + (d.device_name || d.alias) + '</span>' +
        '<span class="dev-status">' + (d.online ? '在线' : '离线') + '</span></div>';
    }).join('');

    dd.innerHTML = browserOption + deviceItems;
  },

  renderCurrentDevice() {
    if (this.isBrowserMode) {
      document.getElementById('currentDeviceName').textContent = '🖥 当前浏览器';
      document.getElementById('deviceDot').className = 'dot';
    } else if (this.currentDevice) {
      document.getElementById('currentDeviceName').textContent = this.currentDevice.device_name || this.currentDevice.alias;
      document.getElementById('deviceDot').className = 'dot';
    }
  },

  // 选择浏览器播放模式 (v1.0.54)
  selectBrowserMode() {
    this.isBrowserMode = true;
    this.currentDevice = null;
    this.stopStatusSync();  // 停止音箱状态同步 (v1.0.79)
    localStorage.setItem('lx-play-mode', 'browser');
    this.refreshBrowserPlaybackState();
    this.renderDeviceDropdown();
    this.renderCurrentDevice();
    document.getElementById('deviceDropdown').classList.remove('show');
    this.showToast('已切换到浏览器播放模式');
  },

  async selectDevice(accountId, deviceId) {
    var found = null;
    for (var i = 0; i < this.devices.length; i++) {
      if (this.devices[i].device_id === deviceId && this.devices[i].account_id === accountId) {
        found = this.devices[i]; break;
      }
    }
    if (found) {
      this.isBrowserMode = false;  // 切换到音箱模式
      this.currentDevice = found;
      // 记住选择（刷新后恢复）
      localStorage.setItem('lx-selected-device', JSON.stringify({ account_id: accountId, device_id: deviceId, device_name: found.device_name }));
      localStorage.setItem('lx-play-mode', 'miot');
      this.renderDeviceDropdown();
      this.renderCurrentDevice();
      document.getElementById('deviceDropdown').classList.remove('show');
      this.showToast('已切换: ' + (found.device_name || found.alias));
      var selectResp = await API.selectDevice(accountId, deviceId);
      if (!selectResp || !selectResp.success) {
        this.showToast('音箱状态同步失败，将显示本地缓存信息', true);
      }
      await this.refreshSpeakerPlaybackState(true);
      this.startStatusSync();
    } else {
      this.showToast('设备未找到');
    }
  },

  restoreSelectedDevice() {
    try {
      var raw = localStorage.getItem('lx-selected-device');
      if (!raw) return;
      var saved = JSON.parse(raw);
      for (var i = 0; i < this.devices.length; i++) {
        var d = this.devices[i];
        if (d.device_id === saved.device_id && d.account_id === saved.account_id) {
          this.currentDevice = d;
          this.renderCurrentDevice();
          return;
        }
      }
      // 设备不可用则清除
      localStorage.removeItem('lx-selected-device');
    } catch(e) {}
  },

  // ===== MIoT 状态 =====
  async checkMIoTStatus() {
    var resp = await API.getMIoTStatus();
    var badge = document.getElementById('miotBadge');
    var statusText = document.getElementById('miotStatusText');
    if (resp.success && resp.data) {
      // MIoT /api/config 返回200即表示已安装
      badge.textContent = '✅ MIoT';
      badge.className = 'miot-status';
      if (statusText) statusText.textContent = '✅ MIoT 插件已连接';
    } else if (resp.httpStatus === 404) {
      badge.textContent = '⚠ MIoT 未安装';
      badge.className = 'miot-status error';
      if (statusText) statusText.textContent = '❌ MIoT 插件未安装，请先安装MIoT插件';
    } else {
      badge.textContent = '⚠ MIoT ?';
      badge.className = 'miot-status warn';
      if (statusText) statusText.textContent = 'MIoT状态未知: ' + (resp.error || resp.httpStatus || '');
    }
  },

  dismissMiotWarn() {
    document.getElementById('miotWarnOverlay').style.display = 'none';
    document.getElementById('miotWarnOverlay').classList.remove('show');
  },

  async configureMIoT() {
    this.showToast('正在配置MIoT搜索源...');
    var resp = await API.configureMIoT();
    if (resp.success) { this.showToast('✅ MIoT搜索源已配置'); return true; }
    else { this.showToast('❌ 配置失败: ' + (resp.error || '')); return false; }
  },

  // ===== 播放器 =====
  async loadPlayerStatus() {
    if (this.isBrowserMode) {
      this.refreshBrowserPlaybackState();
      return;
    }
    if (!this.currentDevice) return;
    await this.refreshSpeakerPlaybackState();
  },

  updatePlayButton() {
    var icon = this.isPlaying ? '⏸' : '▶';
    var bottomButton = document.getElementById('playBtn'); if (bottomButton) bottomButton.textContent = icon;
    var pageButton = document.getElementById('playerPagePlayBtn'); if (pageButton) pageButton.textContent = icon;
    var vinyl = document.getElementById('playerVinyl');
    if (vinyl) vinyl.classList.toggle('playing', this.isBrowserMode && this.isPlaying);
  },

  advanceSpeakerAfterCompletion(state) {
    if (!this.speakerPlaybackEndPending || this.speakerNextInFlight || this.speakerPauseRequested || state === 'playing') return;
    this.speakerPlaybackEndPending = false;
    this.songStartedAt = 0;
    this.speakerNextInFlight = true;
    var self = this;
    var hasQueue = Array.isArray(this.playQueue) && this.playQueue.length > 0 && this.currentQueueIndex >= 0;
    var request = hasQueue
      ? this.playNext()
      : this.controlPlayback('next', { _nativeSpeakerNext: true });
    Promise.resolve(request).finally(function() {
      self.speakerNextInFlight = false;
    });
  },

  togglePlay() {
    if (this.isBrowserMode) {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.updatePlayButton();
        this.audioPlayer.pause();
      } else {
        this.isPlaying = true;
        this.updatePlayButton();
        var self = this;
        var playResult = this.audioPlayer.play();
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(function() {
            self.isPlaying = false;
            self.updatePlayButton();
          });
        }
      }
    } else {
      this.controlPlayback(this.isPlaying ? 'pause' : 'play');
    }
  },

  async controlPlayback(action, params) {
    // 上一曲/下一曲在浏览器模式下使用本地队列
    if (action === 'prev') {
      this.playPrevious();
      return;
    }
    if (action === 'next' && (this.isBrowserMode || this.playQueue.length > 0)) {
      this.playNext();
      return;
    }

    // 浏览器播放模式
    if (this.isBrowserMode) {
      switch(action) {
        case 'play':
          this.audioPlayer.play();
          break;
        case 'pause':
          this.audioPlayer.pause();
          break;
        case 'stop':
          this.audioPlayer.pause();
          this.audioPlayer.currentTime = 0;
          this.isPlaying = false;
          this.updatePlayButton();
          break;
        case 'set_volume':
          this.currentVolume = (params && params.volume) || 50;
          this.audioPlayer.volume = this.currentVolume / 100;
          document.getElementById('volumeFill').style.width = this.currentVolume + '%';
          break;
      }
      return;
    }

    // 音箱播放模式 — 传递当前设备信息
    if (action === 'pause') {
      this.speakerPauseRequested = true;
    }
    if (action === 'play' || action === 'next') this.speakerPauseRequested = false;
    if (action === 'stop') {
      this.speakerPauseRequested = false;
      this.speakerPlaybackEndPending = false;
    }
    var requestParams = Object.assign({}, params || {});
    delete requestParams._nativeSpeakerNext;
    if (this.currentDevice) {
      requestParams.account_id = this.currentDevice.account_id;
      requestParams.device_id = this.currentDevice.device_id;
    }
    var resp = await API.controlPlayback(action, requestParams);
    var ok = resp.success;
    this.logDebug(action, ok ? '✅' : '❌ ' + (resp.error || '失败'));
    console.log('[LX] controlPlayback 响应:', action, JSON.stringify(resp).substring(0, 300));
    if (ok) {
      if (action === 'pause') {
        this.isPlaying = false;
        this.speakerPlayStateProtectedUntil = 0;
      }
      if (action === 'play') this.isPlaying = true;
      if (action === 'stop') {
        this.isPlaying = false;
        this.speakerPlayStateProtectedUntil = 0;
        this.clearSpeakerPlaybackSnapshot();
        this.resetNowPlaying();
        this.stopStatusSync();
      }
      if (action === 'set_volume') this.currentVolume = (params && params.volume) || 50;
      this.updatePlayButton();
      document.getElementById('volumeFill').style.width = this.currentVolume + '%';
    }
  },

  // ===== 上一曲/下一曲 (v1.0.55) =====
  playPrevious() {
    if (this.playQueue.length === 0) {
      this.showToast('播放列表为空');
      return;
    }
    if (this.currentQueueIndex > 0) {
      this.currentQueueIndex--;
      this.playSongFromQueue(this.currentQueueIndex);
    } else {
      this.showToast('已经是第一首');
    }
  },

  async playNext() {
    if (this.playQueue.length === 0) {
      this.showToast('播放列表为空');
      return;
    }

    var nextIndex = -1;

    // 根据播放模式决定下一首
    switch(this.playMode) {
      case 'order':  // 顺序播放
        if (this.currentQueueIndex < this.playQueue.length - 1) {
          nextIndex = this.currentQueueIndex + 1;
        } else {
          this.showToast('已经是最后一首');
          return;
        }
        break;

      case 'loop':  // 列表循环
        nextIndex = (this.currentQueueIndex + 1) % this.playQueue.length;
        break;

      case 'single':  // 单曲循环（不应该调用next，但保险起见）
        nextIndex = this.currentQueueIndex;
        break;

      case 'random':  // 随机播放
        if (this.playQueue.length === 1) {
          nextIndex = 0;
        } else {
          // 随机选一首，但不能是当前这首
          do {
            nextIndex = Math.floor(Math.random() * this.playQueue.length);
          } while (nextIndex === this.currentQueueIndex && this.playQueue.length > 1);
        }
        break;

      default:
        nextIndex = this.currentQueueIndex + 1;
    }

    if (nextIndex >= 0 && nextIndex < this.playQueue.length) {
      this.currentQueueIndex = nextIndex;
      console.log('[LX] 播放模式: ' + this.playMode + ', 下一首索引: ' + nextIndex);
      return this.playSongFromQueue(nextIndex);
    }
  },

  async playSongFromQueue(index) {
    if (index < 0 || index >= this.playQueue.length) return;
    var song = this.playQueue[index];
    this.currentQueueIndex = index;
    await this.playSongItem(song, song.source, true);  // skipQueueAdd = true
  },

  async playSongItem(song, source, skipQueueAdd) {
    this.showToast('正在获取播放链接...');
    console.log('[LX] playSongItem:', song.name, 'id:', song.id, 'source:', source || song.source, '_raw:', song._raw ? 'YES' : 'NO');

    // 添加到播放列表（除非是从队列播放）
    if (!skipQueueAdd) {
      // 检查是否已在队列中
      var exists = false;
      for (var i = 0; i < this.playQueue.length; i++) {
        if (this.playQueue[i].id === song.id && this.playQueue[i].source === (source || song.source)) {
          exists = true;
          this.currentQueueIndex = i;
          break;
        }
      }
      if (!exists) {
        this.playQueue.push(song);
        this.currentQueueIndex = this.playQueue.length - 1;
      }
    }

    // 队列已更新，刷新队列面板（面板未打开时自动跳过）
    this.renderPlayQueue();

    // ===== 智能音源记忆 (v1.0.78) =====
    // 查询历史记录，看是否有上次成功的音源
    var history = this.findHistoryBySong(song.name, song.singer);
    var preferredSource = null;

    if (history && history.lastSuccessSource && history.failCount < 3) {
      preferredSource = history.lastSuccessSource;
      console.log('[LX] 找到上次成功音源:', preferredSource, '失败次数:', history.failCount);
    }

    // ===== v1.0.79 优化：使用智能获取API（支持优选音源）=====
    // 统一使用智能获取API，后端会：
    // 1. 重新搜索对应平台，获取正确ID（解决跨平台ID不匹配）
    // 2. 如果有优选音源，调整搜索顺序优先尝试
    // 3. 自动降级、异常检测、音质调整
    console.log('[LX] 调用智能获取API，优选音源:', preferredSource || '无');
    var fallbackResp = await API.getSongUrlWithFallback(song.name, song.singer, song.album, source || song.source, song.id, preferredSource);
    console.log('[LX] 智能获取API响应:', JSON.stringify(fallbackResp).substring(0, 500));

    var url = null;
    var usedQuality = '';
    var usedSource = source || song.source;

    if (fallbackResp.success && fallbackResp.data && fallbackResp.data.url) {
      url = this.decodeHtmlEntities(fallbackResp.data.url);
      usedQuality = fallbackResp.data.quality;
      usedSource = fallbackResp.data.source;
      console.log('[LX] 获取成功:', usedSource, usedQuality, '步骤:', fallbackResp.data.fallbackSteps);

      // 更新音源记忆
      if (preferredSource && usedSource === preferredSource) {
        // 优选音源成功，重置失败次数
        if (history) {
          history.failCount = 0;
          this.saveHistory();
        }
        console.log('[LX] ✓ 优选音源成功');
      } else if (preferredSource && usedSource !== preferredSource) {
        // 优选音源失败，累计失败次数
        if (history) {
          history.failCount = (history.failCount || 0) + 1;
          this.saveHistory();
          console.log('[LX] 优选音源失败，failCount:', history.failCount);
        }
      }
    } else {
      // 完全失败
      this.showToast('所有音源都不可用: ' + (fallbackResp.error || '未知错误'), true);
      if (preferredSource && history) {
        history.failCount = (history.failCount || 0) + 1;
        this.saveHistory();
      }
      return;
    }

    if (!url) {
      console.log('[LX] 原音源无可用URL，尝试降级策略');
      this.showToast('当前音源不可用，尝试其他音源...');
      var fallbackResp = await API.getSongUrlWithFallback(song.name, song.singer, song.album, source || song.source, song.id);
      console.log('[LX] 降级API响应:', JSON.stringify(fallbackResp).substring(0, 500));
      if (fallbackResp.success && fallbackResp.data && fallbackResp.data.url) {
        url = this.decodeHtmlEntities(fallbackResp.data.url);
        usedQuality = fallbackResp.data.quality;
        usedSource = fallbackResp.data.source;
        console.log('[LX] 降级成功:', usedSource, usedQuality, '步骤:', fallbackResp.data.fallbackSteps);
      } else {
        var errorMsg = fallbackResp.error || fallbackResp.message || '未知错误';
        console.log('[LX] 降级失败:', errorMsg);
        this.showToast('获取播放链接失败: ' + errorMsg, true);
        return;
      }
    }

    // 浏览器播放模式 (v1.0.55)
    if (this.isBrowserMode) {
      this.stopStatusSync();  // 浏览器模式不需要状态同步
      console.log('[BrowserPlayer] Playing:', url);
      this.audioPlayer.src = url;
      this.audioPlayer.play();
      this.isPlaying = true;
      this.updatePlayButton();
      var lyricSong = (fallbackResp.data && fallbackResp.data.song) || song;
      this.saveBrowserPlaybackSnapshot(song, usedSource, usedQuality, lyricSong);
      this.updateNowPlaying(song, usedSource, usedQuality);
      this.loadLyricsForSong(lyricSong, usedSource, song);
      this.showToast('正在播放: ' + song.name + ' - ' + song.singer);
      this.logDebug('play', '浏览器播放', song.name + ' · ' + usedSource + ' ' + usedQuality, '▶');

      // 更新智能音源记录 (v1.0.78)
      this.updateHistoryAfterPlay(song, usedSource, usedQuality, skipQueueAdd ? 'queue' : 'manual');

      // 保留旧的 API 历史记录（向后兼容）
      API.addHistory({
        songId: song.id,
        title: song.name,
        artist: song.singer,
        album: song.album || '',
        cover: song.cover || song.img || '',
        source: usedSource,
        quality: usedQuality,
        duration: song.interval || 0
      });
      return;
    }

    // 音箱播放模式（原逻辑）
    if (!this.currentDevice) {
      this.showToast('请先选择播放设备', true);
      return;
    }

    // 需要兼容的音频来源交给 Songloft 原生远程流，避免 QuickJS 回传音频二进制。
    var lowerSpeakerUrl = String(url).toLowerCase();
    var needsSpeakerProxy = usedSource === 'tx' ||
      lowerSpeakerUrl.includes('qqmusic.qq.com') ||
      lowerSpeakerUrl.includes('music.qq.com');
    var resolvedSong = (fallbackResp.data && fallbackResp.data.song) || {};
    if (needsSpeakerProxy) {
      try {
        var resolvedDuration = resolvedSong.duration || song.duration || song.interval || 0;
        if (typeof resolvedDuration === 'string') resolvedDuration = this.parseDuration(resolvedDuration);
        var stableSongId = resolvedSong.songmid || resolvedSong.id || song.songmid || song.id || song.name;
        var proxyResp = await API.registerProxyUrl(url, {
          title: resolvedSong.name || song.name || '',
          artist: resolvedSong.singer || song.singer || '',
          album: resolvedSong.album || song.album || '',
          coverUrl: resolvedSong.img || resolvedSong.cover || song.cover || song.img || '',
          duration: Number(resolvedDuration) || 0,
          dedupKey: 'tx:' + String(stableSongId)
        });
        if (proxyResp.success && proxyResp.data && proxyResp.data.token) {
          var base = window.location.origin + API.basePath.replace(/\/+$/, '');
          url = base + '/api/proxy/play?token=' + proxyResp.data.token;
          console.log('[Speaker] Using Songloft native stream URL:', url);
        }
      } catch (e) {
        console.log('[Speaker] Native stream registration failed, using original URL:', e.message);
      }
    } else {
      console.log('[Speaker] Using direct URL for source:', usedSource, url.substring(0, 120));
    }

    console.log('[Speaker] Pushing URL to speaker:', url);
    var resp = await API.playSong(url, song.name, song.singer, this.currentDevice.account_id, this.currentDevice.device_id);
    console.log('[Speaker] playSong result:', JSON.stringify(resp).substring(0, 200));
    if (resp.success || resp.raw !== undefined) {
      this.isPlaying = true; this.updatePlayButton();
      this.speakerPauseRequested = false;
      this.speakerPlaybackEndPending = false;
      this.speakerPlayStateProtectedUntil = Date.now() + 5000;
      this.updateNowPlaying(song, usedSource, usedQuality);
      this.showToast('正在播放: ' + song.name + ' - ' + song.singer);
      // 记录播放开始时间，用于进度追踪 (v1.0.82)
      this.songStartedAt = Date.now() / 1000;
      // 时长优先使用解析后歌曲的标注时长，再回退到列表歌曲信息。
      var durationCandidates = [resolvedSong.duration, resolvedSong.interval, song.duration, song.interval];
      var dur = 0;
      for (var durationIndex = 0; durationIndex < durationCandidates.length; durationIndex++) {
        var durationValue = durationCandidates[durationIndex];
        if (typeof durationValue === 'string') {
          dur = this.parseDuration(durationValue);
        } else {
          dur = parseInt(durationValue) || 0;
        }
        if (dur > 0) break;
      }
      if (!dur || dur <= 0) dur = 240; // 默认4分钟兜底
      this.songDuration = dur;
      this.saveSpeakerPlaybackSnapshot(song, usedSource, usedQuality, dur);
      this.renderSpeakerProgress();
      this.logDebug('play', '推送音箱', song.name + ' · ' + usedSource + ' ' + usedQuality + ' (' + dur + 's)', '播放中');
      // 启动音箱状态同步 (v1.0.65)
      this.startStatusSync();

      // 更新智能音源记录 (v1.0.78)
      this.updateHistoryAfterPlay(song, usedSource, usedQuality, skipQueueAdd ? 'queue' : 'manual');

      // 保留旧的 API 历史记录（向后兼容）
      API.addHistory({
        songId: song.id,
        title: song.name,
        artist: song.singer,
        album: song.album || '',
        cover: song.cover || song.img || '',
        source: usedSource,
        quality: usedQuality,
        duration: song.interval || 0
      });
    } else {
      this.showToast('推送到音箱失败: ' + (resp.error || ''), true);
    }
  },

  updateNowPlaying(song, source, quality) {
    this.currentSong = song;
    // v1.8.22: 记录实际使用的音源和音质，供触发缓存时使用
    this.currentSong._cachedSource = source;
    this.currentSong._cachedQuality = quality;
    // v1.8.22: 每次切歌重置缓存触发标记
    this._cacheTriggeredForCurrentSong = false;
    var npTitle = document.getElementById('npTitle'); if (npTitle) npTitle.textContent = song.name;
    var npArtist = document.getElementById('npArtist'); if (npArtist) npArtist.textContent = song.singer + (song.album ? ' · ' + song.album : '');
    var ns = document.getElementById('npSource'); if (ns) { ns.style.display = 'inline-block'; ns.textContent = source + ' · ' + quality; }
    var pt = document.getElementById('playerTitle'); if (pt) pt.textContent = song.name;
    var details = [source, quality].filter(function(item) { return !!item; }).join(' · ');
    var pa = document.getElementById('playerArtist'); if (pa) pa.innerHTML = this._artistLink(song.singer || '', source) + (details ? ' · ' + details : '');

    // 更新封面显示 (v1.0.63)
    var coverEl = document.getElementById('playerCover');
    if (coverEl) {
      if (song.cover || song.img) {
        var coverUrl = song.cover || song.img;
        coverEl.style.backgroundImage = 'url(' + coverUrl + ')';
        coverEl.style.backgroundSize = 'cover';
        coverEl.style.backgroundPosition = 'center';
        coverEl.textContent = '';
      } else {
        coverEl.style.backgroundImage = 'none';
        coverEl.textContent = '🎵';
      }
      coverEl.classList.toggle('is-playing', this.isPlaying);
    }
    this.syncPlayerPage();
  },

  openPlayerPage() {
    var activePage = document.querySelector('.page.active');
    var from = activePage && activePage.id ? activePage.id.replace('page-', '') : 'home';
    if (from !== 'player') this._playerPageFrom = from;
    this.switchPage('player', null, true);
    var playerPage = document.getElementById('page-player');
    if (playerPage) {
      playerPage.classList.remove('player-exiting', 'player-entered');
      void playerPage.offsetHeight;
      requestAnimationFrame(function() { playerPage.classList.add('player-entered'); });
    }
    this.renderPlayerPage();
    if (this.isBrowserMode && this.browserPlaybackSnapshot) {
      this.loadLyricsForSong(this.browserPlaybackSnapshot.lyricSong || this.browserPlaybackSnapshot.song, this.browserPlaybackSnapshot.source, this.browserPlaybackSnapshot.song);
    }
  },
  closePlayerPage() {
    var playerPage = document.getElementById('page-player');
    var self = this;
    if (!playerPage || !playerPage.classList.contains('active')) {
      this.switchPage(this._playerPageFrom || 'home', document.querySelector('[data-page="' + (this._playerPageFrom || 'home') + '"]'), true);
      return;
    }
    playerPage.classList.remove('player-entered');
    playerPage.classList.add('player-exiting');
    setTimeout(function() {
      if (!playerPage.classList.contains('player-exiting')) return;
      playerPage.classList.remove('player-exiting');
      self.switchPage(self._playerPageFrom || 'home', document.querySelector('[data-page="' + (self._playerPageFrom || 'home') + '"]'), true);
    }, 260);
  },
  renderPlayerPage() {
    var content = document.getElementById('playerPageContent');
    if (!content) return;
    var song = this.currentSong || {};
    var source = song._cachedSource || song.source || '';
    var quality = song._cachedQuality || song.quality || '';
    var details = [source, quality].filter(function(item) { return !!item; }).join(' · ');
    var cover = song.cover || song.img || '';
    content.innerHTML = '<section class="player-screen"><header class="player-screen-toolbar"><button class="player-screen-icon" onclick="App.closePlayerPage()">⌄</button></header>' +
      '<div class="player-page-layout' + (this.showLyrics ? '' : ' player-lyrics-hidden') + '" id="playerPageLayout"><div class="player-page-main"><div class="player-vinyl' + (this.isBrowserMode && this.isPlaying ? ' playing' : '') + '" id="playerVinyl"><div class="player-page-cover" id="playerPageCover">' +
      (cover ? '<img src="' + this._escapeHtml(cover) + '" alt="" onerror="this.style.display=\'none\'">' : '🎵') +
      '</div><span class="player-vinyl-hole"></span></div><div class="player-page-info"><h2 id="playerPageTitle">' + this._escapeHtml(song.name || '未在播放') + '</h2>' +
      '<p id="playerPageArtist">' + this._escapeHtml(song.singer || '选择歌曲开始') + '</p>' +
      '<p class="player-page-details" id="playerPageDetails">' + this._escapeHtml(details) + '</p></div>' +
      '<div class="player-page-controls"><button class="pc-btn" id="playerPageModeBtn" data-tip="播放模式" onclick="App.cyclePlayerPageMode()">' + (this.playModeIcons[this.playMode] || '🔁') + '</button><button class="pc-btn" data-tip="上一曲" onclick="App.controlPlayback(\'prev\')">⏮</button>' +
      '<button class="pc-btn play-btn" id="playerPagePlayBtn" data-tip="播放/暂停" onclick="App.togglePlay()">' + (this.isPlaying ? '⏸' : '▶') + '</button>' +
      '<button class="pc-btn" data-tip="下一曲" onclick="App.controlPlayback(\'next\')">⏭</button><button class="pc-btn" id="playerPageQueueBtn" data-tip="播放队列" onclick="App.togglePlayerQueue()">☷</button><button class="pc-btn player-lyrics-toggle" id="playerLyricsToggle" data-tip="显示/隐藏歌词" aria-pressed="' + (this.showLyrics ? 'true' : 'false') + '" onclick="App.togglePlayerLyrics()">≋</button></div>' +
      '<div class="player-page-progress"><span id="playerPageCurrentTime">0:00</span><div class="progress-bar" onmousedown="App.startPlayerPageSeekDrag(event)" onclick="App.seekPlayerPage(event)"><div class="progress-fill" id="playerPageProgressFill"></div></div><span id="playerPageTotalTime">0:00</span></div>' +
      '<div class="player-page-volume"><button class="player-page-volume-icon" id="playerPageVolumeIcon" aria-label="' + (this.isMuted ? '取消静音' : '静音') + '" onclick="App.toggleMute()">' + (this.isMuted || this.currentVolume === 0 ? '🔇' : (this.currentVolume <= 35 ? '🔉' : '🔊')) + '</button><div class="volume-slider" id="playerPageVolume" role="slider" tabindex="0" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + this.currentVolume + '" aria-valuetext="' + this.currentVolume + '%" onmousedown="App.startPlayerPageVolumeDrag(event)" onclick="App.adjustPlayerPageVolume(event)" onkeydown="App.handlePlayerPageVolumeKey(event)"><div class="volume-fill" id="playerPageVolumeFill" style="width:' + (this.isMuted ? 0 : this.currentVolume) + '%"></div></div></div></div>' +
      '<aside class="player-page-lyrics"><div class="lyrics-list" id="playerLyrics"></div></aside></div></section>';
    this.renderBrowserProgress();
    this.renderPlayerLyrics();
  },
  syncPlayerPage() {
    if (!document.getElementById('page-player') || !document.getElementById('page-player').classList.contains('active')) return;
    var title = document.getElementById('playerPageTitle');
    var artist = document.getElementById('playerPageArtist');
    var details = document.getElementById('playerPageDetails');
    var cover = document.getElementById('playerPageCover');
    var song = this.currentSong || {};
    var source = song._cachedSource || song.source || '';
    var quality = song._cachedQuality || song.quality || '';
    if (title) title.textContent = song.name || '未在播放';
    if (artist) artist.textContent = song.singer || '选择歌曲开始';
    if (details) details.textContent = [source, quality].filter(function(item) { return !!item; }).join(' · ');
    if (cover) cover.innerHTML = song.cover || song.img ? '<img src="' + this._escapeHtml(song.cover || song.img) + '" alt="" onerror="this.style.display=\'none\'">' : '🎵';
    this.applyVolumeUI();
    var vinyl = document.getElementById('playerVinyl');
    if (vinyl) vinyl.classList.toggle('playing', this.isBrowserMode && this.isPlaying);
  },
  seekPlayerPage(e) {
    this.seekTo(e);
    this.updateLyricsForTime();
  },
  startPlayerPageSeekDrag(e) {
    this.startSeekDrag(e);
  },
  adjustPlayerPageVolume(e) {
    var rect = e.currentTarget.getBoundingClientRect();
    var pct = Math.round((e.clientX - rect.left) / rect.width * 100);
    this.setVolume(Math.max(0, Math.min(100, pct)));
  },
  startPlayerPageVolumeDrag(e) {
    e.preventDefault();
    var self = this;
    var slider = e.currentTarget;
    function setFromEvent(ev) {
      var rect = slider.getBoundingClientRect();
      var pct = Math.round((ev.clientX - rect.left) / rect.width * 100);
      self.setVolume(Math.max(0, Math.min(100, pct)));
    }
    function onMove(ev) { setFromEvent(ev); }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    setFromEvent(e);
  },
  handlePlayerPageVolumeKey(e) {
    var change = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 :
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
    if (change === 0) return;
    e.preventDefault();
    this.setVolume(this.currentVolume + change);
  },
  togglePlayerLyrics() {
    this.showLyrics = !this.showLyrics;
    var layout = document.getElementById('playerPageLayout');
    var toggle = document.getElementById('playerLyricsToggle');
    if (layout) layout.classList.toggle('player-lyrics-hidden', !this.showLyrics);
    if (toggle) toggle.setAttribute('aria-pressed', this.showLyrics ? 'true' : 'false');
  },
  cyclePlayerPageMode() {
    this.cyclePlayMode();
    var button = document.getElementById('playerPageModeBtn');
    if (button) {
      button.textContent = this.playModeIcons[this.playMode] || '🔁';
      button.setAttribute('data-tip', this.playModeNames[this.playMode] || '播放模式');
    }
  },
  togglePlayerQueue() {
    this.toggleQueuePanel();
  },
  clearLyrics() {
    this._lyricRequestId++;
    this._lyricSongKey = '';
    this.lyricLines = [];
    this.lyricActiveIndex = -1;
    this.lyricState = 'idle';
    this.renderPlayerLyrics();
  },
  getLyricCacheKey(requestSong) {
    return [requestSong.source || '', requestSong.id || '', requestSong.lyricId || ''].join(':');
  },
  getCachedLyric(key) {
    try {
      var cache = JSON.parse(localStorage.getItem('lx-lyric-cache-v1') || '{}');
      var entry = cache[key];
      if (!entry || typeof entry.lyric !== 'string') return '';
      if (!entry.savedAt || Date.now() - entry.savedAt > 7 * 24 * 60 * 60 * 1000) {
        delete cache[key];
        localStorage.setItem('lx-lyric-cache-v1', JSON.stringify(cache));
        return '';
      }
      return entry.lyric;
    } catch (e) {
      return '';
    }
  },
  saveCachedLyric(key, lyric) {
    if (!key || typeof lyric !== 'string' || !lyric.trim()) return;
    try {
      var cache = JSON.parse(localStorage.getItem('lx-lyric-cache-v1') || '{}');
      cache[key] = { lyric: lyric, savedAt: Date.now() };
      var keys = Object.keys(cache).sort(function(a, b) {
        return (cache[b].savedAt || 0) - (cache[a].savedAt || 0);
      }).slice(0, 50);
      var compact = {};
      for (var i = 0; i < keys.length; i++) compact[keys[i]] = cache[keys[i]];
      localStorage.setItem('lx-lyric-cache-v1', JSON.stringify(compact));
    } catch (e) {
      // 缓存失败不影响歌词在线加载。
    }
  },
  loadLyricsForSong(song, source, fallbackSong) {
    var requestSong = LyricsModel.requestForSong(song, source, fallbackSong);
    if (!this.isBrowserMode || !requestSong.id || !requestSong.source) {
      this.clearLyrics();
      return;
    }
    var key = this.getLyricCacheKey(requestSong);
    if (key === this._lyricSongKey && this.lyricState !== 'idle') return;
    this._lyricSongKey = key;
    this.lyricLines = [];
    this.lyricActiveIndex = -1;
    this.lyricState = 'loading';
    var requestId = ++this._lyricRequestId;
    this.renderPlayerLyrics();
    var self = this;
    var cachedLyric = this.getCachedLyric(key);
    if (cachedLyric) {
      this.lyricLines = LyricsModel.parse(cachedLyric);
      this.lyricState = this.lyricLines.length ? 'ready' : 'empty';
      this.lyricActiveIndex = -1;
      this.renderPlayerLyrics();
      this.updateLyricsForTime();
      return;
    }
    API.getLyric(requestSong).then(function(resp) {
      if (requestId !== self._lyricRequestId || key !== self._lyricSongKey) return;
      var lrc = resp && resp.success && resp.data ? resp.data.lyric : '';
      if (lrc) self.saveCachedLyric(key, lrc);
      self.lyricLines = LyricsModel.parse(lrc || '');
      self.lyricState = self.lyricLines.length ? 'ready' : (resp && resp.data && resp.data.available === false ? 'unavailable' : 'empty');
      self.lyricActiveIndex = -1;
      self.renderPlayerLyrics();
      self.updateLyricsForTime();
    }).catch(function() {
      if (requestId !== self._lyricRequestId || key !== self._lyricSongKey) return;
      self.lyricState = 'unavailable';
      self.lyricLines = [];
      self.renderPlayerLyrics();
    });
  },
  renderPlayerLyrics() {
    var root = document.getElementById('playerLyrics');
    if (!root) return;
    if (!this.isBrowserMode) {
      root.innerHTML = '<p class="lyrics-empty">当前设备不支持同步歌词</p>';
      return;
    }
    if (this.lyricState === 'loading') {
      root.innerHTML = '<p class="lyrics-empty">正在加载歌词...</p>';
      return;
    }
    if (this.lyricState === 'unavailable') {
      root.innerHTML = '<p class="lyrics-empty">歌词暂不可用</p>';
      return;
    }
    if (!this.lyricLines.length) {
      root.innerHTML = '<p class="lyrics-empty">暂无可同步歌词</p>';
      return;
    }
    var self = this;
    root.innerHTML = this.lyricLines.map(function(line, index) {
      return '<p class="lyric-line' + (index === self.lyricActiveIndex ? ' active' : '') + '" data-lyric-index="' + index + '" onclick="App.seekToLyric(' + index + ')">' + self._escapeHtml(line.text) + '</p>';
    }).join('');
    root.onwheel = function() { self._lyricScrollHoldUntil = Date.now() + 3000; };
    root.ontouchmove = function() { self._lyricScrollHoldUntil = Date.now() + 3000; };
  },
  seekToLyric(index) {
    if (!this.isBrowserMode || !this.audioPlayer || !this.lyricLines[index]) return;
    var target = Math.max(0, Number(this.lyricLines[index].time) || 0);
    if (isFinite(this.audioPlayer.duration) && this.audioPlayer.duration > 0) {
      target = Math.min(target, this.audioPlayer.duration);
    }
    this.audioPlayer.currentTime = target;
    this._lyricScrollHoldUntil = 0;
    this.updateLyricsForTime();
  },
  updateLyricsForTime() {
    if (!this.isBrowserMode || !this.audioPlayer || !this.lyricLines.length) return;
    var next = LyricsModel.activeIndex(this.lyricLines, this.audioPlayer.currentTime || 0);
    if (next === this.lyricActiveIndex) return;
    var root = document.getElementById('playerLyrics');
    if (!root) {
      this.lyricActiveIndex = next;
      return;
    }
    var previousEl = root.querySelector('[data-lyric-index="' + this.lyricActiveIndex + '"]');
    if (previousEl) previousEl.classList.remove('active');
    this.lyricActiveIndex = next;
    var activeEl = root.querySelector('[data-lyric-index="' + next + '"]');
    if (activeEl) {
      activeEl.classList.add('active');
      if (Date.now() >= this._lyricScrollHoldUntil) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },

  // ===== 搜索 =====
  // ===== 首页 (v1.7.0) =====
  async loadHomePage() {
    var hotTags = document.getElementById('homeHotTags');
    if (hotTags) {
      var hotResp = await API.getHotSearch('mg');
      if (hotResp.success && hotResp.data) {
        var tags = [], seen = {};
        for (var i = 0; i < hotResp.data.length && tags.length < 10; i++) {
          var text = typeof hotResp.data[i] === 'string' ? hotResp.data[i] : (hotResp.data[i].name || hotResp.data[i].keyword || String(hotResp.data[i]));
          if (!seen[text]) { seen[text] = true; tags.push(text); }
        }
        hotTags.innerHTML = tags.map(function(t) {
          return '<span class="hot-tag" onclick="App.searchFromHome(\'' + t.replace(/'/g, "\\'") + '\')">' + t + '</span>';
        }).join('');
      }
    }
    var content = document.getElementById('homeContent');
    if (!content) return;
    content.innerHTML = '<p style="text-align:center;padding:10px;color:var(--text-tertiary);">加载中...</p>';
    var html = '';

    // 1. 用户歌单：卡片点击→展示歌曲列表，▶→播放全部
    var plResp = await API.getPlaylists();
    if (plResp.success && plResp.data && plResp.data.length > 0) {
      this._homePlaylists = plResp.data;
      html += '<div class="home-section"><div class="home-section-title">📋 我的歌单</div><div class="home-pl-grid">';
      for (var p = 0; p < plResp.data.length; p++) {
        var pl = plResp.data[p];
        var icon = pl.id === 'love' ? '❤️' : (pl.system ? '🎵' : '📋');
        html += '<div class="home-pl-card" onclick="App._showHomePlaylistDetail(\'' + pl.id + '\')" style="cursor:pointer">' +
          '<span class="home-pl-play-btn" onclick="event.stopPropagation();App._playPlaylistAll(\'' + pl.id + '\')" title="播放">▶</span>' +
          '<div class="home-pl-icon">' + icon + '</div>' +
          '<div class="home-pl-name">' + pl.name + '</div>' +
          '<div class="home-pl-count">' + pl.songCount + '首</div></div>';
      }
      html += '</div></div>';
    }

    // 2. 榜单横向排列（3个榜单并排，每个有标题和歌曲）
    var boardResp = await API.getLeaderBoards('kg');
    if (boardResp.success && boardResp.data) {
      var boards = boardResp.data.slice(0, 3);
      html += '<div class="home-section"><div class="home-section-title">🏆 排行榜</div><div class="home-board-row">';
      for (var b = 0; b < boards.length; b++) {
        var board = boards[b];
        var listResp = await API.getLeaderList('kg', board.bangid || board.id);
        if (listResp.success && listResp.data && listResp.data.length > 0) {
          var songs = listResp.data.slice(0, 5);
          html += '<div class="home-board-col">' +
            '<div class="home-board-title" onclick="App._openBoardDetail(\'' + (board.bangid || board.id) + '\',\'' + (board.name || '').replace(/'/g, "\\'") + '\')">' + (board.name || '') + '</div>';
          for (var k = 0; k < songs.length; k++) {
            var bs = songs[k];
            html += '<div class="home-board-song" onclick="App._playHomeBoardSong(' + b + ',' + k + ')">' +
              '<span class="hbs-num">' + String(k + 1) + '</span>' +
              '<span class="hbs-name">' + (bs.name || '') + '</span>' +
              '<span class="hbs-singer">' + (bs.singer || '') + '</span></div>';
          }
          html += '</div>';
          if (!this._homeBoardSongs) this._homeBoardSongs = {};
          this._homeBoardSongs[b] = songs;
        }
      }
      html += '</div></div>';
    }

    content.innerHTML = html || '<p style="text-align:center;padding:40px;color:var(--text-tertiary);">加载完成，暂无内容</p>';
  },
  _showHomePlaylistDetail(plId) {
    // 在首页直接展示歌单详情（不入收藏页）
    var content = document.getElementById('homeContent');
    if (!content) return;
    var pl = null;
    var lists = this._homePlaylists || this.playlistsResults;
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].id === plId) { pl = lists[i]; break; }
    }
    if (!pl) return;
    this.favoritesResults = pl.songs;
    var html = '<div style="margin-bottom:8px;"><button class="btn btn-sm btn-secondary" onclick="App.loadHomePage()">← 返回首页</button>' +
      '<span style="font-size:15px;font-weight:600;margin-left:8px;">' + pl.name + '</span>' +
      '<span style="color:var(--text-tertiary);font-size:12px;margin-left:4px;">' + pl.songCount + '首</span></div>';
    html += '<div class="song-list">';
    for (var j = 0; j < pl.songs.length; j++) {
      var s = pl.songs[j];
      var dur = s.interval || '--:--';
      var coverUrl = s.meta?.picUrl || s.meta?.img || '';
      var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + j + ')">' +
        '<div class="song-number">' + String(j + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
        '<div class="song-info"><div class="song-title">' + s.name + '</div><div class="song-meta">' + (s.singer || '') + ' · ' + (s.source || '') + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + j + ')">▶</button></div>';
    }
    html += '</div>';
    content.innerHTML = html;
  },
  _playPlaylistAll(id) {
    var lists = this._homePlaylists || this.playlistsResults;
    for (var i = 0; i < lists.length; i++) {
      if (lists[i].id === id) {
        var songs = lists[i].songs;
        if (songs.length > 0) {
          this.favoritesResults = songs;
          this.playQueue = songs.map(function(s) {
            var duration = s.interval || s.duration || s.meta?.interval || s.meta?.duration || 0;
            return { id: s.id, name: s.name, singer: s.singer, source: s.source, cover: s.meta?.picUrl, duration: duration, interval: s.interval || duration, _raw: s.meta };
          });
          this.currentQueueIndex = 0;
          this.currentQueueType = 'favorites';
          this.playSongFromQueue(0);
        }
        break;
      }
    }
  },
  _openBoardDetail(bangid, name) {
    // 在首页直接展示榜单歌曲详情（不跳转页面）
    var content = document.getElementById('homeContent');
    if (!content) return;
    content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">加载中...</p>';
    var self = this;
    API.getLeaderList('kg', bangid).then(function(resp) {
      if (resp.success && resp.data && resp.data.length > 0) {
        var songs = resp.data;
        self.favoritesResults = songs;
        var html = '<div style="margin-bottom:8px;"><button class="btn btn-sm btn-secondary" onclick="App.loadHomePage()">← 返回首页</button>' +
          '<span style="font-size:15px;font-weight:600;margin-left:8px;">' + (name || '') + '</span>' +
          '<span style="color:var(--text-tertiary);font-size:12px;margin-left:4px;">' + songs.length + '首</span></div>';
        html += '<div class="song-list">';
        for (var i = 0; i < Math.min(songs.length, 30); i++) {
          var s = songs[i];
          var coverUrl = s.img || '';
          var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
          html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + i + ', \'leaderboard\')">' +
            '<div class="song-number">' + String(i + 1).padStart(2, '0') + '</div>' +
            '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
            '<div class="song-info"><div class="song-title">' + (s.name || '') + '</div><div class="song-meta">' + (s.singer || '') + '</div></div>' +
            '<div class="song-duration">' + (s.interval || '--:--') + '</div>' +
            '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + i + ', \'leaderboard\')">▶</button></div>';
        }
        html += '</div>';
        content.innerHTML = html;
      }
    });
  },
  _playHomeBoardSong(bIdx, sIdx) {
    if (this._homeBoardSongs && this._homeBoardSongs[bIdx] && this._homeBoardSongs[bIdx][sIdx]) {
      var s = this._homeBoardSongs[bIdx][sIdx];
      this.favoritesResults = this._homeBoardSongs[bIdx];
      // 建立排行榜播放队列
      this.playQueue = this._homeBoardSongs[bIdx].map(function(hs) {
        return { id: hs.source + '_' + hs.songmid, name: hs.name, singer: hs.singer, source: hs.source, cover: hs.img, _raw: { songId: hs.songmid, songmid: String(hs.songmid), source: hs.source, name: hs.name, singer: hs.singer, interval: hs.interval, img: hs.img, albumName: hs.albumName, types: hs.types, hash: hs.hash } };
      });
      this.currentQueueIndex = sIdx;
      this.currentQueueType = 'leaderboard';
      // 构建标准songInfo用于URL获取：source + songmid
      var songObj = {
        id: s.source + '_' + s.songmid,
        name: s.name, singer: s.singer, source: s.source, cover: s.img,
        _raw: { songId: s.songmid, songmid: String(s.songmid), source: s.source, name: s.name, singer: s.singer, interval: s.interval, img: s.img, albumName: s.albumName, types: s.types, hash: s.hash }
      };
      this.playSongItem(songObj, s.source);
    }
  },
  searchFromHome(text) {
    this.searchType = 'song';
    localStorage.setItem('lx-search-type', 'song');
    this.syncSearchControls();
    document.getElementById('searchInput').value = text;
    this.switchPage('search', document.querySelector('[data-page=search]'));
    this.doSearch();
  },

  // ===== 歌手页 (v1.8.3) =====
  async loadArtistPage() {
    var content = document.getElementById('artistContent');
    if (!content) return;
    // 展示热搜标签作为热门歌手入口
    var resp = await API.getHotSearch('mg');
    if (resp.success && resp.data && resp.data.length > 0) {
      var tags = [], seen = {};
      for (var i = 0; i < resp.data.length && tags.length < 24; i++) {
        var text = typeof resp.data[i] === 'string' ? resp.data[i] : (resp.data[i].name || resp.data[i].keyword || String(resp.data[i]));
        if (!seen[text]) { seen[text] = true; tags.push(text); }
      }
      content.innerHTML = '<h2 class="page-title">🎤 热门歌手</h2>' +
        '<p class="page-subtitle">点击标签搜索歌手歌曲</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
        tags.map(function(t) {
          return '<span class="hot-tag" onclick="App.showArtist(\'' + t.replace(/'/g, "\\'") + '\')">' + t + '</span>';
        }).join('') + '</div>';
    }
  },
  _goBackFromArtist() {
    this._artistRequestId++;
    var backTo = this._artistFromPage || 'home';
    this.switchPage(backTo, document.querySelector('[data-page="' + backTo + '"]'));
  },
  _artistLink(name, source, id) {
    var artistName = name || '未知';
    return '<span class="artist-name" onclick="event.stopPropagation();App.showArtist(decodeURIComponent(\'' +
      this._encodeInlineArg(artistName) + '\'),decodeURIComponent(\'' + this._encodeInlineArg(source || '') +
      '\'),decodeURIComponent(\'' + this._encodeInlineArg(id || '') + '\'))" title="查看歌手: ' +
      this._escapeHtml(artistName) + '">' + this._escapeHtml(artistName) + '</span>';
  },
  async showArtist(artistName, source, artistId) {
    var activePage = document.querySelector('.page.active')?.id?.replace('page-', '') || 'home';
    if (activePage !== 'artist') this._artistFromPage = activePage;
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    var page = document.getElementById('page-artist'); if (page) page.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    var content = document.getElementById('artistContent');
    if (!content) return;
    var safeName = this._escapeHtml(artistName || '未知歌手');
    content.innerHTML = '<div class="artist-toolbar"><button class="btn btn-sm btn-secondary" onclick="App._goBackFromArtist()">← 返回</button></div>' +
      '<p class="artist-loading">正在加载 ' + safeName + '...</p>';

    var requestId = ++this._artistRequestId;
    var resolvedSource = source === 'tx' || source === 'wy' ? source : '';
    var resolvedId = String(artistId || '').trim();
    var resolvedName = String(artistName || '').trim();
    var resolvedCover = '';

    try {
      if (!resolvedId) {
        var searchSources = resolvedSource ? [resolvedSource] : ['tx', 'wy'];
        var searchResp = await API.searchEntities('singer', resolvedName, searchSources, 1, 20);
        if (requestId !== this._artistRequestId) return;
        var candidates = searchResp.success && searchResp.data && Array.isArray(searchResp.data.items)
          ? searchResp.data.items : [];
        if (!candidates.length) throw new Error('未找到对应歌手');
        var normalizedName = resolvedName.toLocaleLowerCase();
        var candidate = candidates.find(function(item) {
          return String(item.name || '').trim().toLocaleLowerCase() === normalizedName;
        }) || candidates[0];
        resolvedId = String(candidate.id || '');
        resolvedSource = candidate.source;
        resolvedName = candidate.name || resolvedName;
        resolvedCover = candidate.cover || '';
      }

      var responses = await Promise.all([
        API.getArtistDetail(resolvedSource, resolvedId, resolvedName, resolvedCover),
        API.getArtistSongs(resolvedSource, resolvedId)
      ]);
      if (requestId !== this._artistRequestId) return;
      var detailResp = responses[0];
      var songsResp = responses[1];
      if (!songsResp.success || !Array.isArray(songsResp.data)) {
        throw new Error(songsResp.error || '歌手歌曲加载失败');
      }
      var detail = detailResp.success && detailResp.data ? detailResp.data : {
        id: resolvedId,
        name: resolvedName || '未知歌手',
        cover: resolvedCover,
        description: '',
        songCount: songsResp.data.length,
        albumCount: 0,
        source: resolvedSource
      };
      this.artistDetailState = {
        id: resolvedId,
        source: resolvedSource,
        detail: detail,
        songs: songsResp.data,
        page: 1,
        activeTab: 'songs',
        albums: [],
        albumsLoaded: false,
        albumPage: 1,
        albumView: null
      };
      this.renderArtistSongs(1);
    } catch (error) {
      if (requestId !== this._artistRequestId) return;
      content.innerHTML = '<div class="artist-toolbar"><button class="btn btn-sm btn-secondary" onclick="App._goBackFromArtist()">← 返回</button></div>' +
        '<p class="artist-empty">' + this._escapeHtml(error.message || '歌手页面加载失败') + '</p>';
    }
  },
  renderArtistSongs(page) {
    var state = this.artistDetailState;
    var content = document.getElementById('artistContent');
    if (!state || !content) return;
    var songs = state.songs || [];
    var maxPage = Math.max(1, Math.ceil(songs.length / this._pageSize));
    page = Math.max(1, Math.min(page || 1, maxPage));
    state.page = page;
    var pg = this._slicePage(songs, page);
    state.activeTab = 'songs';
    var html = this._renderArtistHeader(state, 'songs');
    if (!songs.length) {
      html += '<p class="artist-empty">暂无歌曲</p><div id="artistPagination"></div>';
      content.innerHTML = html;
      return;
    }
    html += '<div class="song-list">';
    for (var i = 0; i < pg.sliced.length; i++) {
      var s = pg.sliced[i];
      var globalIndex = pg.start + i;
      var dur = s.duration ? Math.floor(s.duration / 60) + ':' + String(Math.floor(s.duration % 60)).padStart(2, '0') : '--:--';
      var songCover = s.cover
        ? '<img src="' + this._escapeHtml(s.cover) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">'
        : '🎵';
      html += '<div class="song-item" onclick="App.playArtistSongByIndex(' + globalIndex + ')">' +
        '<div class="song-number">' + String(globalIndex + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + songCover + '</div>' +
        '<div class="song-info"><div class="song-title">' + this._escapeHtml(s.name) + '</div>' +
        '<div class="song-meta">' + this._escapeHtml(s.singer || '') + (s.album ? ' · ' + this._escapeHtml(s.album) : '') +
        ' · ' + this._escapeHtml(String(s.source || '').toUpperCase()) + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playArtistSongByIndex(' + globalIndex + ')">▶</button></div>';
    }
    html += '</div><div id="artistPagination"></div>';
    content.innerHTML = html;
    var self = this;
    this._renderPagination('artistPagination', songs.length, page, function(nextPage) {
      self.renderArtistSongs(nextPage);
      var scroll = document.querySelector('.content'); if (scroll) scroll.scrollTop = 0;
    });
  },
  _renderArtistHeader(state, activeTab) {
    var detail = state.detail || {};
    var cover = detail.cover
      ? '<img src="' + this._escapeHtml(detail.cover) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<span>🎤</span>';
    var counts = (state.songs || []).length + ' 首歌曲';
    if (detail.albumCount) counts += ' · ' + detail.albumCount + ' 张专辑';
    return '<div class="artist-toolbar"><button class="btn btn-sm btn-secondary" onclick="App._goBackFromArtist()">← 返回</button></div>' +
      '<div class="artist-detail-header"><div class="artist-avatar">' + cover + '</div>' +
      '<div class="artist-detail-info"><h2>' + this._escapeHtml(detail.name || '未知歌手') + '</h2>' +
      '<div class="artist-detail-meta">' + this._escapeHtml(String(state.source || '').toUpperCase()) + ' · ' + counts + '</div>' +
      (detail.description ? '<p>' + this._escapeHtml(detail.description) + '</p>' : '') + '</div></div>' +
      '<div class="artist-tabs"><button class="artist-tab' + (activeTab === 'songs' ? ' active' : '') + '" onclick="App.renderArtistSongs(1)">歌曲</button>' +
      '<button class="artist-tab' + (activeTab === 'albums' ? ' active' : '') + '" onclick="App.showArtistAlbums(1)">专辑</button></div>';
  },
  async showArtistAlbums(page) {
    var state = this.artistDetailState;
    var content = document.getElementById('artistContent');
    if (!state || !content) return;
    page = Math.max(1, Number(page) || 1);
    if (state.albumsLoaded) {
      this.renderArtistAlbums(page);
      return;
    }
    var requestId = ++this._artistAlbumRequestId;
    content.innerHTML = this._renderArtistHeader(state, 'albums') + '<p class="artist-loading">正在加载专辑...</p>';
    try {
      var resp = await API.getArtistAlbums(state.source, state.id);
      if (requestId !== this._artistAlbumRequestId || state !== this.artistDetailState) return;
      if (!resp.success || !Array.isArray(resp.data)) {
        throw new Error(resp.error || '当前来源暂不支持专辑浏览');
      }
      state.albums = resp.data;
      state.albumsLoaded = true;
      state.albumView = null;
      state.activeTab = 'albums';
      this.renderArtistAlbums(page);
    } catch (error) {
      if (requestId !== this._artistAlbumRequestId || state !== this.artistDetailState) return;
      content.innerHTML = this._renderArtistHeader(state, 'albums') +
        '<p class="artist-empty">' + this._escapeHtml(error.message || '当前来源暂不支持专辑浏览') + '</p>';
    }
  },
  renderArtistAlbums(page) {
    var state = this.artistDetailState;
    var content = document.getElementById('artistContent');
    if (!state || !content) return;
    var albums = state.albums || [];
    var maxPage = Math.max(1, Math.ceil(albums.length / this._pageSize));
    page = Math.max(1, Math.min(page || state.albumPage || 1, maxPage));
    state.albumPage = page;
    var pg = this._slicePage(albums, page);
    var html = this._renderArtistHeader(state, 'albums');
    if (!albums.length) {
      content.innerHTML = html + '<p class="artist-empty">暂无专辑</p>';
      return;
    }
    html += '<div class="album-grid">';
    for (var i = 0; i < pg.sliced.length; i++) {
      var album = pg.sliced[i];
      var albumCover = album.cover
        ? '<img src="' + this._escapeHtml(album.cover) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
        : '💿';
      html += '<button class="album-item" onclick="App.showAlbum(decodeURIComponent(\'' + this._encodeInlineArg(album.name) + '\'),decodeURIComponent(\'' + this._encodeInlineArg(album.source || state.source) + '\'),decodeURIComponent(\'' + this._encodeInlineArg(album.id) + '\'),decodeURIComponent(\'' + this._encodeInlineArg(album.cover || '') + '\'))">' +
        '<span class="album-cover">' + albumCover + '</span><span class="album-name">' + this._escapeHtml(album.name) + '</span>' +
        '<span class="album-meta">' + this._escapeHtml(album.publishDate || '') + (album.songCount ? ' · ' + album.songCount + ' 首' : '') + '</span></button>';
    }
    html += '</div><div id="artistAlbumPagination"></div>';
    content.innerHTML = html;
    var self = this;
    this._renderPagination('artistAlbumPagination', albums.length, page, function(nextPage) {
      self.renderArtistAlbums(nextPage);
      var scroll = document.querySelector('.content'); if (scroll) scroll.scrollTop = 0;
    });
  },
  async showAlbum(albumName, source, albumId, cover) {
    var state = this.artistDetailState;
    var content = document.getElementById('artistContent');
    if (!state || !content || !albumId) return;
    var requestId = ++this._artistAlbumRequestId;
    state.albumView = { id: albumId, name: albumName || '未知专辑', source: source || state.source, cover: cover || '', songs: [] };
    content.innerHTML = this._renderArtistHeader(state, 'albums') + '<p class="artist-loading">正在加载专辑歌曲...</p>';
    try {
      var resp = await API.getAlbumSongs(state.albumView.source, albumId);
      if (requestId !== this._artistAlbumRequestId || state !== this.artistDetailState) return;
      if (!resp.success || !Array.isArray(resp.data)) throw new Error(resp.error || '专辑歌曲加载失败');
      state.albumView.songs = resp.data;
      this.renderAlbumSongs(1);
    } catch (error) {
      if (requestId !== this._artistAlbumRequestId || state !== this.artistDetailState) return;
      content.innerHTML = this._renderArtistHeader(state, 'albums') + '<p class="artist-empty">' + this._escapeHtml(error.message || '专辑歌曲加载失败') + '</p>';
    }
  },
  renderAlbumSongs(page) {
    var state = this.artistDetailState;
    var content = document.getElementById('artistContent');
    var album = state && state.albumView;
    if (!state || !content || !album) return;
    var songs = album.songs || [];
    var maxPage = Math.max(1, Math.ceil(songs.length / this._pageSize));
    page = Math.max(1, Math.min(page || 1, maxPage));
    album.page = page;
    var pg = this._slicePage(songs, page);
    var albumCover = album.cover ? '<img src="' + this._escapeHtml(album.cover) + '" alt="" onerror="this.style.display=\'none\'">' : '💿';
    var html = '<div class="artist-toolbar"><button class="btn btn-sm btn-secondary" onclick="App.backToArtistAlbums()">← 返回专辑</button></div>' +
      '<div class="album-detail-header"><div class="album-detail-cover">' + albumCover + '</div><div><h2>' + this._escapeHtml(album.name) + '</h2><div class="artist-detail-meta">' + this._escapeHtml(String(album.source || '').toUpperCase()) + ' · ' + songs.length + ' 首歌曲</div></div></div>';
    if (!songs.length) {
      content.innerHTML = html + '<p class="artist-empty">暂无歌曲</p><div id="albumSongsPagination"></div>';
      return;
    }
    html += '<div class="song-list">';
    for (var i = 0; i < pg.sliced.length; i++) {
      var s = pg.sliced[i];
      var globalIndex = pg.start + i;
      var dur = s.duration ? Math.floor(s.duration / 60) + ':' + String(Math.floor(s.duration % 60)).padStart(2, '0') : '--:--';
      html += '<div class="song-item" onclick="App.playAlbumSongByIndex(' + globalIndex + ')"><div class="song-number">' + String(globalIndex + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + (s.cover ? '<img src="' + this._escapeHtml(s.cover) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵') + '</div>' +
        '<div class="song-info"><div class="song-title">' + this._escapeHtml(s.name) + '</div><div class="song-meta">' + this._escapeHtml(s.singer || '') + ' · ' + this._escapeHtml(String(s.source || '').toUpperCase()) + '</div></div>' +
        '<div class="song-duration">' + dur + '</div><button class="song-action" onclick="event.stopPropagation();App.playAlbumSongByIndex(' + globalIndex + ')">▶</button></div>';
    }
    html += '</div><div id="albumSongsPagination"></div>';
    content.innerHTML = html;
    var self = this;
    this._renderPagination('albumSongsPagination', songs.length, page, function(nextPage) {
      self.renderAlbumSongs(nextPage);
      var scroll = document.querySelector('.content'); if (scroll) scroll.scrollTop = 0;
    });
  },
  backToArtistAlbums() {
    var state = this.artistDetailState;
    if (!state) return;
    state.albumView = null;
    this.renderArtistAlbums(state.albumPage);
  },
  playAlbumSongByIndex(index) {
    var album = this.artistDetailState && this.artistDetailState.albumView;
    var songs = album && album.songs;
    if (!songs || index < 0 || index >= songs.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    this.playQueue = songs.slice();
    this.currentQueueIndex = index;
    this.currentQueueType = 'album';
    this.playSongItem(songs[index], songs[index].source);
  },
  playArtistSongByIndex(index) {
    var songs = this.artistDetailState && this.artistDetailState.songs;
    if (!songs || index < 0 || index >= songs.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    this.playQueue = songs.slice();
    this.currentQueueIndex = index;
    this.currentQueueType = 'artist';
    this.playSongItem(songs[index], songs[index].source);
  },

  // ===== 搜索联想+热搜 (v1.5.1) =====
  initSearchControls() {
    this.searchType = EntitySearchModel.normalizeType(localStorage.getItem('lx-search-type'));
    this.syncSearchControls(localStorage.getItem('lx-search-source') || '');
  },
  syncSearchControls(preferredSource) {
    var typeSelect = document.getElementById('searchTypeSelect');
    if (typeSelect) typeSelect.value = this.searchType;
    var sourceSelect = document.getElementById('sourceSelect');
    var currentSource = preferredSource !== undefined
      ? preferredSource
      : (sourceSelect ? sourceSelect.value : (localStorage.getItem('lx-search-source') || ''));
    var supported = EntitySearchModel.sourcesForType(this.searchType);
    if (supported.indexOf(currentSource) === -1) currentSource = '';
    var labels = { kg: '🐶 KG', kw: '🎵 KW', tx: '🐧 TX', wy: '☁️ WY', mg: '📻 MG' };
    if (sourceSelect) {
      sourceSelect.innerHTML = '<option value="">全部音源</option>' + supported.map(function(source) {
        return '<option value="' + source + '">' + labels[source] + '</option>';
      }).join('');
      sourceSelect.value = currentSource;
    }
    localStorage.setItem('lx-search-source', currentSource);
    var input = document.getElementById('searchInput');
    var placeholders = { song: '输入歌名、歌手...', singer: '输入歌手名称...', playlist: '输入歌单名称...' };
    if (input) input.placeholder = placeholders[this.searchType] || placeholders.song;
  },
  onSearchTypeChange() {
    var typeSelect = document.getElementById('searchTypeSelect');
    this.searchType = EntitySearchModel.normalizeType(typeSelect ? typeSelect.value : 'song');
    localStorage.setItem('lx-search-type', this.searchType);
    this._searchRequestId++;
    this._entityLoadRequestId++;
    this.entitySearchState = null;
    this.dismissSuggest();
    this.syncSearchControls();
    var keyword = ((document.getElementById('searchInput') || {}).value || '').trim();
    if (keyword) this.doSearch();
    else this.setSearchViewState('landing');
  },
  setSearchViewState(state, message) {
    this.searchViewState = state;
    var landing = document.getElementById('searchLanding');
    var outcome = document.getElementById('searchOutcome');
    var results = document.getElementById('searchResults');
    var pagination = document.getElementById('searchPagination');
    var notice = document.getElementById('searchNotice');
    var isLanding = state === 'landing';

    if (landing) landing.style.display = isLanding ? 'block' : 'none';
    if (outcome) outcome.style.display = isLanding ? 'none' : 'block';
    if (pagination && state !== 'results') pagination.innerHTML = '';
    if (notice && state !== 'results') { notice.style.display = 'none'; notice.textContent = ''; }

    if (isLanding) {
      if (results) results.innerHTML = '';
      this.renderSearchHistory();
      if (this.searchType === 'song') this.loadHotSearch();
      else {
        var hot = document.getElementById('hotSearch');
        if (hot) hot.style.display = 'none';
      }
    } else if (message && results) {
      results.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">' + message + '</p>';
    }
  },

  onSourceChange() {
    var sel = document.getElementById('sourceSelect');
    if (sel) localStorage.setItem('lx-search-source', sel.value);
    this._hotCache = null;  // 清除热搜缓存
    this._searchRequestId++;
    this._entityLoadRequestId++;
    this.entitySearchState = null;
    var keyword = (document.getElementById('searchInput') || {}).value || '';
    if (keyword.trim()) this.doSearch();
    else this.setSearchViewState('landing');
  },
  clearSearch() {
    var kw = document.getElementById('searchInput');
    if (kw) kw.value = '';
    this._searchRequestId++;
    this._suggestRequestId++;
    clearTimeout(this.searchTimer);
    clearTimeout(this.suggestTimer);
    this.searchResults = [];
    this.entitySearchState = null;
    this._entityLoadRequestId++;
    this.searchActiveKeyword = '';
    var clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    this.dismissSuggest();
    this.setSearchViewState('landing');
  },
  _searchHasKeyword: false,
  async onSearchInput() {
    var kw = document.getElementById('searchInput');
    var keyword = (kw ? kw.value.trim() : '');
    var clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = keyword ? 'flex' : 'none';

    if (!keyword) {
      this.clearSearch();
      return;
    } else {
      this._searchRequestId++;
      clearTimeout(this.searchTimer);
      this.searchActiveKeyword = '';
    }

    this._searchHasKeyword = !!keyword;
    clearTimeout(this.suggestTimer);
    if (this.searchType !== 'song') {
      this.dismissSuggest();
      return;
    }
    var self = this;
    var suggestRequestId = ++this._suggestRequestId;
    this.suggestTimer = setTimeout(async function() {
      var resp = await API.searchSuggest(keyword);
      var currentKeyword = ((document.getElementById('searchInput') || {}).value || '').trim();
      if (suggestRequestId !== self._suggestRequestId || currentKeyword !== keyword) return;
      if (resp.success && resp.data && resp.data.length > 0) self.showSuggest(resp.data);
      else self.dismissSuggest();
    }, 180);
  },
  showSuggest(items) {
    var dd = document.getElementById('suggestDropdown');
    if (!dd) return;
    var self = this;
    dd.innerHTML = items.slice(0, 8).map(function(s, i) {
      var text = typeof s === 'string' ? s : (s.name || s.keyword || String(s));
      return '<div class="suggest-item" onmousedown="App.selectSuggest(\'' + text.replace(/'/g, "\\'") + '\')">' +
        '<span class="si-icon">🔍</span>' + text + '</div>';
    }).join('');
    dd.style.display = 'block';
  },
  dismissSuggest() {
    this._suggestRequestId++;
    var dd = document.getElementById('suggestDropdown');
    if (dd) dd.style.display = 'none';
  },
  selectSuggest(text) {
    var kw = document.getElementById('searchInput');
    if (kw) kw.value = text;
    this.dismissSuggest();
    this.doSearch();
  },
  async loadHotSearch() {
    var hs = document.getElementById('hotSearch');
    var list = document.getElementById('hotSearchList');
    if (!hs || !list || this.searchViewState !== 'landing') return;
    if (this.searchType !== 'song') { hs.style.display = 'none'; return; }
    var sel = document.getElementById('sourceSelect');
    var src = sel ? sel.value : '';
    var sources = src ? [src] : ['kg', 'kw', 'tx', 'wy', 'mg'];
    var srcLabel = { kg: '🐶 KG', kw: '🎵 KW', tx: '🐧 TX', wy: '☁️ WY', mg: '📻 MG' };
    var results = [];  // [{source, items}]
    for (var i = 0; i < sources.length; i++) {
      var resp = await API.getHotSearch(sources[i]);
      if (resp.success && resp.data && resp.data.length > 0) {
        var items = [];
        var seen = {};
        for (var j = 0; j < resp.data.length; j++) {
          var item = resp.data[j];
          var text = typeof item === 'string' ? item : (item.name || item.keyword || String(item));
          if (!seen[text]) { seen[text] = true; items.push(text); }
        }
        results.push({ source: sources[i], items: items.slice(0, src ? 20 : 10) });
      }
    }
    if (this.searchViewState !== 'landing') return;
    if (results.length > 0) {
      var html = '';
      for (var k = 0; k < results.length; k++) {
        var r = results[k];
        html += '<div class="hot-section">';
        html += '<div class="hot-section-title">' + (srcLabel[r.source] || r.source) + '</div>';
        html += '<div class="hot-section-tags">';
        for (var m = 0; m < r.items.length; m++) {
          html += '<span class="hot-tag" onclick="App.searchHot(\'' + r.items[m].replace(/'/g, "\\'") + '\')">' + r.items[m] + '</span>';
        }
        html += '</div></div>';
      }
      list.innerHTML = html;
      hs.style.display = 'block';
    }
  },
  searchHot(text) {
    var kw = document.getElementById('searchInput');
    if (kw) kw.value = text;
    this.doSearch();
  },

  async doSearch() {
    console.log('[LX] doSearch called');
    var kw = document.getElementById('searchInput');
    if (!kw) { console.log('[LX] searchInput not found'); return; }
    var keyword = kw.value.trim();
    console.log('[LX] keyword:', keyword);
    if (!keyword) { this.clearSearch(); return; }
    var clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = 'flex';

    // v1.8.14: 保存搜索历史
    this.saveSearchHistory(keyword);

    if (this.searchType !== 'song') {
      this.searchEntities(keyword);
      return;
    }

    clearTimeout(this.searchTimer);
    var self = this;
    var requestId = ++this._searchRequestId;
    this.searchActiveKeyword = keyword;
    this.setSearchViewState('searching', '搜索中...');

    // 读取下拉菜单音源选择
    var sel = document.getElementById('sourceSelect');
    var sourceValue = sel ? sel.value : '';
    // 记住选择
    if (sel) { localStorage.setItem('lx-search-source', sourceValue); sel.value = sourceValue; }

    this.searchTimer = setTimeout(async function() {
      if (requestId !== self._searchRequestId) return;
      var sources = sourceValue ? [sourceValue] : null;
      self._searchCurrentPage = 1;
      var resp = await API.searchWeb(keyword, sources, self._pageSize * 3);
      if (requestId !== self._searchRequestId) return;
      console.log('[LX] searchWeb resp:', JSON.stringify(resp).substring(0, 500));
      if (resp.success && resp.data) {
        var count = Array.isArray(resp.data) ? resp.data.length : 0;
        if (count > 0) {
          self.setSearchViewState('results');
          self.renderSearchResults(resp.data);
        } else {
          self.setSearchViewState('empty', '未找到结果（lxserver返回空，请确认音乐源已配置）');
        }
      } else {
        console.log('[LX] search FAILED:', resp.error, 'httpStatus:', resp.httpStatus);
        self.setSearchViewState('error', '<span style="color:var(--danger);">搜索失败: ' + (resp.error || '未知') + '</span>');
      }
    }, 400);
  },

  async searchEntities(keyword) {
    clearTimeout(this.searchTimer);
    var type = EntitySearchModel.normalizeType(this.searchType);
    var sourceSelect = document.getElementById('sourceSelect');
    var source = sourceSelect ? sourceSelect.value : '';
    if (sourceSelect) localStorage.setItem('lx-search-source', source);
    var state = EntitySearchModel.resetState(this.entitySearchState, type, keyword, source);
    this.entitySearchState = state;
    this.searchResults = [];
    this._searchCurrentPage = 1;
    this.searchActiveKeyword = keyword;
    var requestId = ++this._searchRequestId;
    var loadId = ++this._entityLoadRequestId;
    this.setSearchViewState('searching', '搜索中...');

    var sources = source ? [source] : EntitySearchModel.sourcesForType(type);
    var resp = await API.searchEntities(type, keyword, sources, 1, this._entityUpstreamLimit);
    if (requestId !== this._searchRequestId || loadId !== this._entityLoadRequestId ||
        !this.entitySearchState || this.entitySearchState.conditionId !== state.conditionId) return;

    if (!resp.success || !resp.data) {
      this.setSearchViewState('error', '<span style="color:var(--danger);">搜索失败: ' +
        this._escapeHtml(resp.error || '未知错误') + '</span>');
      return;
    }

    EntitySearchModel.mergeBatch(state, resp.data);
    if (state.items.length === 0) {
      this.setSearchViewState('empty', '未找到相关' + (type === 'singer' ? '歌手' : '歌单'));
      return;
    }
    this.setSearchViewState('results');
    this.renderEntitySearchPage(1);
  },

  async loadEntitySearchPage(page) {
    var state = this.entitySearchState;
    if (!state) return;
    page = Math.max(1, parseInt(page, 10) || 1);
    var conditionId = state.conditionId;
    var loadId = ++this._entityLoadRequestId;
    var attempted = {};
    var targetCount = page * this._pageSize;

    while (state.items.length < targetCount) {
      var candidates = [];
      Object.keys(state.sourceHasMore).forEach(function(source) {
        var nextPage = (state.sourcePages[source] || 0) + 1;
        if (state.sourceHasMore[source] && !attempted[source + '@' + nextPage]) {
          candidates.push({ source: source, page: nextPage });
        }
      });
      if (candidates.length === 0) break;
      var nextUpstreamPage = candidates.reduce(function(min, item) {
        return Math.min(min, item.page);
      }, candidates[0].page);
      var sources = candidates.filter(function(item) {
        return item.page === nextUpstreamPage;
      }).map(function(item) {
        attempted[item.source + '@' + item.page] = true;
        return item.source;
      });

      var resp = await API.searchEntities(
        state.type,
        state.keyword,
        sources,
        nextUpstreamPage,
        this._entityUpstreamLimit
      );
      if (loadId !== this._entityLoadRequestId || !this.entitySearchState ||
          this.entitySearchState.conditionId !== conditionId) return;
      if (!resp.success || !resp.data) break;
      EntitySearchModel.mergeBatch(state, resp.data);
    }

    if (loadId !== this._entityLoadRequestId || !this.entitySearchState ||
        this.entitySearchState.conditionId !== conditionId) return;
    this.renderEntitySearchPage(page);
    var content = document.querySelector('.content');
    if (content) content.scrollTop = 0;
  },

  renderEntitySearchPage(page) {
    var state = this.entitySearchState;
    var container = document.getElementById('searchResults');
    if (!state || !container) return;
    var maxCachedPage = Math.max(1, Math.ceil(state.items.length / this._pageSize));
    if ((page - 1) * this._pageSize >= state.items.length) page = maxCachedPage;
    this._searchCurrentPage = page;
    var pg = this._slicePage(state.items, page);
    if (state.type === 'singer') this.renderSingerResults(pg.sliced, pg.start);
    else this.renderPlaylistResults(pg.sliced);
    this.renderEntitySearchNotice();

    var self = this;
    this._renderPagination(
      'searchPagination',
      EntitySearchModel.paginationTotal(state),
      page,
      function(nextPage) { self.loadEntitySearchPage(nextPage); }
    );
  },

  renderSingerResults(items, start) {
    var container = document.getElementById('searchResults');
    if (!container) return;
    var self = this;
    container.className = 'song-list';
    container.innerHTML = items.map(function(item, index) {
      var cover = item.cover
        ? '<img src="' + self._escapeHtml(item.cover) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">'
        : '🎤';
      var meta = item.alias ? '<span class="entity-alias">' + self._escapeHtml(item.alias) + '</span>' : '歌手';
      if (item.albumCount) meta += ' · ' + item.albumCount + ' 张专辑';
      return '<div class="song-item" onclick="App.showArtist(decodeURIComponent(\'' + self._encodeInlineArg(item.name) + '\'),decodeURIComponent(\'' + self._encodeInlineArg(item.source) + '\'),decodeURIComponent(\'' + self._encodeInlineArg(item.id) + '\'))" data-artist-source="' + self._escapeHtml(item.source) + '">' +
        '<div class="song-number">' + String(start + index + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + cover + '</div>' +
        '<div class="song-info"><div class="song-title">' + self._escapeHtml(item.name) +
        '<span class="entity-source">' + self._escapeHtml(item.source.toUpperCase()) + '</span></div>' +
        '<div class="song-meta">' + meta + '</div></div>' +
        '<button class="song-action" title="查看歌手">›</button></div>';
    }).join('');
  },

  renderPlaylistResults(items) {
    var container = document.getElementById('searchResults');
    if (!container) return;
    var self = this;
    container.className = 'playlist-grid entity-playlist-grid';
    container.innerHTML = items.map(function(item) {
      var coverStyle = item.cover ? ' style="background-image:url(&quot;' + self._escapeHtml(item.cover) + '&quot;)"' : '';
      var cover = '<div class="entity-playlist-cover"' + coverStyle + '>' + (item.cover ? '' : '📋') + '</div>';
      var creator = item.creator ? self._escapeHtml(item.creator) : '未知创建者';
      var count = item.songCount ? ' · ' + item.songCount + ' 首' : '';
      return '<div class="playlist-card" onclick="App.showSongListDetail(decodeURIComponent(\'' +
        self._encodeInlineArg(item.id) + '\'),\'' + item.source + '\',decodeURIComponent(\'' +
        self._encodeInlineArg(item.name) + '\'))">' + cover +
        '<div class="playlist-card-name">' + self._escapeHtml(item.name) + '</div>' +
        '<div class="entity-playlist-meta">' + creator + count + '</div>' +
        '<div class="playlist-card-count"><span class="entity-source">' +
        self._escapeHtml(item.source.toUpperCase()) + '</span></div></div>';
    }).join('');
  },

  renderEntitySearchNotice() {
    var notice = document.getElementById('searchNotice');
    var state = this.entitySearchState;
    if (!notice || !state || !state.failedSources.length) {
      if (notice) { notice.style.display = 'none'; notice.textContent = ''; }
      return;
    }
    notice.textContent = '部分音源暂不可用：' + state.failedSources.map(function(source) {
      return String(source).toUpperCase();
    }).join('、');
    notice.style.display = 'block';
  },

  _escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function(char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  },
  _encodeInlineArg(value) {
    return encodeURIComponent(String(value === undefined || value === null ? '' : value)).replace(/'/g, '%27');
  },

  _searchCurrentPage: 1,  // 搜索结果当前页
  renderSearchResults(songs, page) {
    var container = document.getElementById('searchResults');
    var self = this;
    if (!songs || songs.length === 0) {
      container.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">未找到结果</p>';
      return;
    }

    // 存储完整的搜索结果（包含 _raw）
    this.searchResults = songs;
    container.className = 'song-list';
    page = page || this._searchCurrentPage || 1;
    this._searchCurrentPage = page;

    // 前端分页切片
    var pg = this._slicePage(songs, page);
    var start = pg.start;
    var list = pg.sliced;
    container.innerHTML = list.map(function(s, index) {
      var globalIdx = start + index;
      var dur = s.duration ? Math.floor(s.duration / 60) + ':' + String(Math.floor(s.duration % 60)).padStart(2, '0') : '--:--';
      var coverHtml = s.cover ? '<img src="' + s.cover + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      var num = (globalIdx + 1).toString().padStart(2, '0');
      // 传递全局索引而不是页内索引
      return '<div class="song-item" onclick="App.playSongByIndexWithQueue(' + globalIdx + ', \'search\')">' +
        '<div class="song-number">' + num + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
        '<div class="song-info"><div class="song-title">' + s.name + '</div><div class="song-meta">' + self._artistLink(s.singer||'未知', s.source) + (s.album ? ' · ' + s.album : '') + ' · ' + (s.source||'') + (s.quality ? ' · ' + s.quality : '') + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playSongByIndexWithQueue(' + globalIdx + ', \'search\')">▶</button></div>';
    }).join('');

    // 分页控件
    var pgEl = document.getElementById('searchPagination');
    this._renderPagination(pgEl, pg.total, page, function(p) {
      self.renderSearchResults(songs, p);
      // 滚动到顶部
      var content = document.querySelector('.content');
      if (content) content.scrollTop = 0;
    });
  },

  // 通过索引播放歌曲（保留完整的 _raw 数据）
  playSongByIndex(index) {
    if (index < 0 || index >= this.searchResults.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    var song = this.searchResults[index];
    this.playSongItem(song, song.source);
  },

  // 带队列管理的播放（搜索列表）
  playSongByIndexWithQueue(index, listType) {
    if (index < 0 || index >= this.searchResults.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    // 设置播放队列
    this.playQueue = this.searchResults.slice();
    this.currentQueueIndex = index;
    this.currentQueueType = listType;

    var song = this.searchResults[index];
    this.playSongItem(song, song.source);
    console.log('[LX] 设置播放队列: ' + listType + ', 当前索引: ' + index + ', 队列长度: ' + this.playQueue.length);
  },

  // ===== 收藏列表 =====
  _favoritesCurrentPage: 1,
  async refreshFavorites() {
    var resp = await API.getFavorites();
    console.log('[LX] refreshFavorites response:', JSON.stringify(resp).substring(0, 500));
    var container = document.getElementById('favoritesList');
    if (!container) return;

    if (resp.success && resp.data && resp.data.length > 0) {
      console.log('[LX] Got', resp.data.length, 'favorites');
      this.favoritesResults = resp.data;
      this._favoritesCurrentPage = 1;
      this._renderFavoritesPage(1);
    } else {
      container.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">暂无收藏</p>';
    }
  },
  _renderFavoritesPage(page) {
    var container = document.getElementById('favoritesList');
    if (!container) return;
    this._favoritesCurrentPage = page;
    var pg = this._slicePage(this.favoritesResults, page);
    var start = pg.start;
    var list = pg.sliced;
    var self = this;
    var html = '<div class="song-list">';
    for (var i = 0; i < list.length; i++) {
      var fav = list[i];
      var globalIdx = start + i;
      var dur = fav.interval || '--:--';
      var coverUrl = fav.meta?.picUrl || fav.meta?.img || '';
      var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      var num = (globalIdx + 1).toString().padStart(2, '0');
      html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + globalIdx + ')">';
      html += '<div class="song-number">' + num + '</div>';
      html += '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>';
      html += '<div class="song-info"><div class="song-title">' + fav.name + '</div>';
      html += '<div class="song-meta">' + (fav.singer || '未知') + ' · ' + fav.source + '</div></div>';
      html += '<div class="song-duration">' + dur + '</div>';
      html += '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + globalIdx + ')">▶</button></div>';
    }
    html += '</div>';
    html += '<div id="favPagination"></div>';
    container.innerHTML = html;
    this._renderPagination('favPagination', pg.total, page, function(p) {
      self._renderFavoritesPage(p);
      var content = document.querySelector('.content');
      if (content) content.scrollTop = 0;
    });
  },

  // 通过索引播放收藏歌曲（使用 meta 作为 _raw）
  playFavoriteByIndex(index) {
    if (index < 0 || index >= this.favoritesResults.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    var fav = this.favoritesResults[index];
    // 构建完整的 songInfo：合并顶层字段和 meta 字段
    var songInfo = Object.assign({}, fav.meta || {}, {
      name: fav.name,
      singer: fav.singer,
      source: fav.source,
      interval: fav.interval
    });
    // 构建歌曲对象
    var song = {
      id: fav.meta?.songId || fav.meta?.songmid || fav.id,
      name: fav.name,
      singer: fav.singer,
      album: fav.meta?.albumName || '',
      source: fav.source,
      cover: EntitySearchModel.resolveSongCover(fav),
      _raw: songInfo  // 使用合并后的完整 songInfo
    };
    this.playSongItem(song, song.source);
  },

  // 带队列管理的播放（收藏列表/歌单/排行榜详情复用）
  playFavoriteByIndexWithQueue(index, listType) {
    if (index < 0 || index >= this.favoritesResults.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    // 设置播放队列（转换为统一格式）
    this.playQueue = this.favoritesResults.map(function(fav) {
      var duration = fav.interval || fav.duration || fav.meta?.interval || fav.meta?.duration || 0;
      var songInfo = Object.assign({}, fav.meta || {}, {
        name: fav.name,
        singer: fav.singer,
        source: fav.source,
        interval: fav.interval || fav.meta?.interval || duration,
        duration: duration
      });
      return {
        id: fav.meta?.songId || fav.meta?.songmid || fav.songmid || fav.hash || fav.id,
        name: fav.name,
        singer: fav.singer,
        album: fav.meta?.albumName || '',
        source: fav.source,
        cover: EntitySearchModel.resolveSongCover(fav),
        duration: duration,
        interval: fav.interval || fav.meta?.interval || duration,
        _raw: songInfo
      };
    });
    this.currentQueueIndex = index;
    this.currentQueueType = listType || 'favorites';

    var fav = this.favoritesResults[index];
    var duration = fav.interval || fav.duration || fav.meta?.interval || fav.meta?.duration || 0;
    var songInfo = Object.assign({}, fav.meta || {}, {
      name: fav.name,
      singer: fav.singer,
      source: fav.source,
      interval: fav.interval || fav.meta?.interval || duration,
      duration: duration
    });
    var song = {
      id: fav.meta?.songId || fav.meta?.songmid || fav.songmid || fav.hash || fav.id,
      name: fav.name,
      singer: fav.singer,
      album: fav.meta?.albumName || '',
      source: fav.source,
      cover: EntitySearchModel.resolveSongCover(fav),
      duration: duration,
      interval: fav.interval || fav.meta?.interval || duration,
      _raw: songInfo
    };
    this.playSongItem(song, song.source);
    console.log('[LX] 设置播放队列: favorites, 当前索引: ' + index + ', 队列长度: ' + this.playQueue.length);
  },

  // ===== 歌单列表 (v1.5.0) =====
  async refreshPlaylists() {
    var resp = await API.getPlaylists();
    console.log('[LX] refreshPlaylists:', JSON.stringify(resp).substring(0, 500));
    var container = document.getElementById('favoritesList');
    if (!container) return;

    if (resp.success && resp.data && resp.data.length > 0) {
      this.playlistsResults = resp.data;
      // 显示歌单列表
      var html = '<div class="playlist-grid">';
      for (var i = 0; i < resp.data.length; i++) {
        var pl = resp.data[i];
        var icon = pl.system ? (pl.id === 'love' ? '❤️' : '🎵') : '📋';
        html += '<div class="playlist-card" onclick="App.showPlaylistDetail(\'' + pl.id + '\')">' +
          '<span class="playlist-card-play-btn" onclick="event.stopPropagation();App._playPlaylistAll(\'' + pl.id + '\')" title="播放">▶</span>' +
          '<div class="playlist-card-icon">' + icon + '</div>' +
          '<div class="playlist-card-name">' + pl.name + '</div>' +
          '<div class="playlist-card-count">' + pl.songCount + ' 首</div>' +
          '</div>';
      }
      html += '</div>';
      container.innerHTML = html;
    } else {
      container.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">暂无歌单</p>';
    }
  },

  _playlistDetailCurrentPage: 1,
  showPlaylistDetail(playlistId) {
    var pl = null;
    for (var i = 0; i < this.playlistsResults.length; i++) {
      if (this.playlistsResults[i].id === playlistId) { pl = this.playlistsResults[i]; break; }
    }
    if (!pl) return;
    this.currentPlaylistId = playlistId;

    // 用歌单歌曲替换收藏列表用于播放
    this.favoritesResults = pl.songs;
    this._playlistDetailCurrentPage = 1;
    this._renderPlaylistDetailPage(1);
  },
  _renderPlaylistDetailPage(page) {
    var container = document.getElementById('favoritesList');
    if (!container) return;
    this._playlistDetailCurrentPage = page;
    var pg = this._slicePage(this.favoritesResults, page);
    var start = pg.start;
    var list = pg.sliced;
    var self = this;
    var pl = null;
    for (var i = 0; i < this.playlistsResults.length; i++) {
      if (this.playlistsResults[i].id === this.currentPlaylistId) { pl = this.playlistsResults[i]; break; }
    }
    var html = '<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;">' +
      '<button class="btn btn-sm btn-secondary" onclick="App.refreshPlaylists()">← 返回歌单</button>' +
      '<span style="font-size:14px;font-weight:600;">' + (pl ? pl.name : '') + '</span>' +
      '<span style="color:var(--text-tertiary);font-size:12px;">' + (pl ? pl.songCount : '') + '首</span></div>';

    html += '<div class="song-list">';
    for (var i = 0; i < list.length; i++) {
      var fav = list[i];
      var globalIdx = start + i;
      var dur = fav.interval || '--:--';
      var coverUrl = fav.meta?.picUrl || fav.meta?.img || '';
      var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      var num = (globalIdx + 1).toString().padStart(2, '0');
      html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + globalIdx + ')">' +
        '<div class="song-number">' + num + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
        '<div class="song-info"><div class="song-title">' + fav.name + '</div>' +
        '<div class="song-meta">' + (fav.singer || '未知') + ' · ' + fav.source + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + globalIdx + ')">▶</button></div>';
    }
    html += '</div>';
    html += '<div id="playlistDetailPagination"></div>';
    container.innerHTML = html;
    this._renderPagination('playlistDetailPagination', pg.total, page, function(p) {
      self._renderPlaylistDetailPage(p);
      var content = document.querySelector('.content');
      if (content) content.scrollTop = 0;
    });
  },

  // ===== 精选歌单 (v1.6.0) =====
  _songlistTagsData: null, _songlistPlatform: 'wy',
  async loadSongListTags() {
    var platEl = document.getElementById('songlistPlatform');
    if (platEl) {
      var platforms = [{k:'wy',n:'☁️ WY'},{k:'kg',n:'🐶 KG'},{k:'tx',n:'🐧 TX'}];
      var self = this;
      platEl.innerHTML = platforms.map(function(p) {
        var cls = p.k === self._songlistPlatform ? 'hot-tag active' : 'hot-tag';
        return '<span class="' + cls + '" onclick="App._setSonglistPlatform(\'' + p.k + '\')">' + p.n + '</span>';
      }).join('');
    }
    var tagsEl = document.getElementById('songlistTags');
    if (!tagsEl) return;
    var resp = await API.getSongListTags(this._songlistPlatform);
    if (resp.success && resp.data) {
      this._songlistTagsData = resp.data;
      tagsEl.innerHTML = resp.data.map(function(cat) {
        var name = cat.name || cat.tag || String(cat);
        return '<span class="hot-tag cat-tag" onclick="App.toggleSongCat(\'' + name.replace(/'/g, "\\'") + '\')">' + name + '</span>';
      }).join('');
      if (resp.data.length > 0 && resp.data[0].list && resp.data[0].list.length > 0) {
        this.loadSongLists(resp.data[0].list[0].id || resp.data[0].list[0].name);
      }
    }
  },
  _playSonglistCard(id) {
    // 获取歌单详情并播放全部
    var self = this;
    API.getSongListDetail(this._songlistPlatform, id).then(function(resp) {
      if (resp.success && resp.data && resp.data.length > 0) {
        var songs = resp.data;
        self.favoritesResults = songs;
        self.playQueue = songs.map(function(s) {
          var duration = s.interval || s.duration || 0;
          return { id: s.songmid || s.id, name: s.name, singer: s.singer, source: s.source, cover: s.img, duration: duration, interval: s.interval || duration, _raw: s };
        });
        self.currentQueueIndex = 0;
        self.currentQueueType = 'songlist';
        self.playSongFromQueue(0);
      }
    });
  },
  _setSonglistPlatform(p) {
    this._songlistPlatform = p;
    // 清除子标签和内容
    var subEl = document.getElementById('songlistSubTags');
    if (subEl) subEl.innerHTML = '';
    var content = document.getElementById('songlistContent');
    if (content) content.innerHTML = '';
    // 清除一级标签选中态
    document.querySelectorAll('#songlistTags .hot-tag').forEach(function(t) { t.classList.remove('active'); });
    this.loadSongListTags();
  },
  _playLeaderboardCard(bangid) {
    var self = this;
    API.getLeaderList(this._boardPlatform, bangid).then(function(resp) {
      if (resp.success && resp.data && resp.data.length > 0) {
        var songs = resp.data;
        self.favoritesResults = songs;
        self.playQueue = songs.map(function(s) {
          return { id: s.source + '_' + s.songmid, name: s.name, singer: s.singer, source: s.source, cover: s.img, _raw: { songId: s.songmid, songmid: String(s.songmid), source: s.source, name: s.name, singer: s.singer, interval: s.interval, img: s.img, albumName: s.albumName, types: s.types, hash: s.hash } };
        });
        self.currentQueueIndex = 0;
        self.currentQueueType = 'leaderboard';
        self.playSongFromQueue(0);
      }
    });
  },
  _setBoardPlatform(p) { this._boardPlatform = p; this.loadLeaderBoards(); },
  toggleSongCat(catName) {
    var cats = this._songlistTagsData;
    if (!cats) return;
    console.log('[LX] toggleSongCat:', catName, 'tagsData:', cats ? cats.length : 0, 'categories');
    // 高亮选中的一级标签
    document.querySelectorAll('#songlistTags .hot-tag').forEach(function(t) {
      t.classList.toggle('active', t.textContent === catName);
    });
    var subEl = document.getElementById('songlistSubTags');
    var found = null;
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].name === catName) { found = cats[i]; break; }
    }
    if (found && found.list) {
      subEl.innerHTML = found.list.map(function(t) {
        var tid = String(t.id || t.name || '');
        var tname = String(t.name || t.id || '');
        return '<span class="hot-tag" onclick="App.selectSubTag(\'' + tid.replace(/'/g, "\\'") + '\',this)">' + tname + '</span>';
      }).join('');
      subEl.style.display = 'flex';
      subEl.style.flexWrap = 'wrap';
      subEl.style.gap = '4px';
      // 默认加载第一个
      this.loadSongLists(found.list[0].id || found.list[0].name);
    }
  },
  selectSubTag(tag, el) {
    document.querySelectorAll('#songlistSubTags .hot-tag').forEach(function(t) {
      t.classList.remove('active');
    });
    if (el) el.classList.add('active');
    this.loadSongLists(tag);
  },
  _songlistAllData: [],  // 全部歌单列表数据（用于前端分页）
  async loadSongLists(tag, page) {
    page = page || 1;
    console.log('[LX] loadSongLists tag:', tag, 'page:', page);
    var content = document.getElementById('songlistContent');
    if (!content) return;

    // 第一页：重新加载
    if (page === 1) {
      content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">加载中...</p>';
      this._songlistCurrentTag = tag;
      this._songlistCurrentPage = 1;
    }

    var resp = await API.getSongLists(this._songlistPlatform, tag, page, this._pageSize);
    console.log('[LX] songLists resp:', this._songlistPlatform, tag, 'page:', page, 'count:', resp.data ? resp.data.length : 0);

    if (resp.success && resp.data && resp.data.length > 0) {
      // 如果后端返回的数据不足pageSize，说明已到末尾，不再分页
      var allData = resp.data;
      if (allData.length < this._pageSize) {
        // 只有一页数据或最后一页，直接渲染
        this._songlistAllData = allData;
        this._renderSonglistCardsPage(1, allData, true);
      } else {
        // 服务端分页：加载全部页的数据用于前端分页展示
        // 简化方案：仅当前页数据 + 分页控件（每次翻页重新请求后端）
        this._songlistAllData = allData;
        this._renderSonglistCardsPage(page, allData, false);
      }
      this._songlistCurrentPage = page;
    } else if (page === 1) {
      content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">暂无数据</p>';
    } else {
      // 翻页无更多数据
      var btn = document.getElementById('loadMoreSonglistBtn');
      if (btn) btn.style.display = 'none';
    }
  },

  _renderSonglistCardsPage(page, data, isLastPage) {
    var content = document.getElementById('songlistContent');
    if (!content) return;
    var self = this;
    var html = '<div class="playlist-grid">';
    for (var i = 0; i < data.length; i++) {
      var pl = data[i];
      var cover = pl.img || pl.picUrl || pl.cover || '';
      var count = pl.total || pl.songCount || pl.song_count || pl.playCount || pl.play_count;
      if (!count && count !== 0) count = ''; else if (count === 0) count = '';
      var coverHtml = cover ? '<div class="playlist-card-icon" style="background-image:url(' + cover + ');background-size:cover;background-position:center;width:60px;height:60px;border-radius:8px;margin:0 auto 10px;"></div>' : '<div class="playlist-card-icon">📋</div>';
      html += '<div class="playlist-card" onclick="App.showSongListDetail(\'' + (pl.id || pl.list_id || '') + '\')">' +
        '<span class="playlist-card-play-btn" onclick="event.stopPropagation();App._playSonglistCard(\'' + (pl.id || pl.list_id || '') + '\')" title="播放">▶</span>' +
        coverHtml +
        '<div class="playlist-card-name">' + (pl.name || pl.title || '') + '</div>' +
        '<div class="playlist-card-count">' + (count || '') + (count ? ' 首' : '') + '</div></div>';
    }
    html += '</div>';

    // 加载更多按钮（服务端分页模式）
    if (!isLastPage) {
      var nextPage = page + 1;
      html += '<div style="text-align:center;margin-top:16px;">' +
        '<button class="btn btn-secondary" onclick="App.loadSongLists(App._songlistCurrentTag, ' + nextPage + ')">加载更多</button></div>';
    }

    content.innerHTML = html;
  },
  _songlistDetailCurrentPage: 1,
  async showSongListDetail(id, source, title) {
    var detailRequestId = (this._songlistDetailRequestId || 0) + 1;
    this._songlistDetailRequestId = detailRequestId;
    var activePage = document.querySelector('.page.active');
    var fromPage = activePage ? activePage.id.replace('page-', '') : 'songlists';
    this._songlistDetailFromPage = fromPage;
    if (source) this._songlistPlatform = source;
    this._songlistDetailTitle = title || '';
    if (fromPage !== 'songlists') {
      this.switchPage('songlists', document.querySelector('[data-page="songlists"]'), true);
    }
    var content = document.getElementById('songlistContent');
    if (!content) return;
    content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">加载中...</p>';
    var resp = await API.getSongListDetail(this._songlistPlatform, id);
    if (detailRequestId !== this._songlistDetailRequestId) return;
    if (resp.success && resp.data && resp.data.length > 0) {
      this.favoritesResults = resp.data.map(function(song) {
        if (!song.source) song.source = source || App._songlistPlatform;
        return song;
      });
      this._songlistDetailCurrentPage = 1;
      this._renderSonglistDetailPage(1);
    } else {
      content.innerHTML = '<div style="margin-bottom:12px;"><button class="btn btn-sm btn-secondary" onclick="App._goBackFromSongListDetail()">← 返回</button></div>' +
        '<p style="text-align:center;padding:40px;color:var(--text-tertiary);">歌单暂无可播放歌曲</p>';
    }
  },
  _goBackFromSongListDetail() {
    this._songlistDetailRequestId = (this._songlistDetailRequestId || 0) + 1;
    if (this._songlistDetailFromPage === 'search') {
      this.switchPage('search', document.querySelector('[data-page="search"]'), true);
      return;
    }
    this.loadSongLists(this._songlistCurrentTag || '');
  },
  _renderSonglistDetailPage(page) {
    var content = document.getElementById('songlistContent');
    if (!content) return;
    this._songlistDetailCurrentPage = page;
    var songs = this.favoritesResults;
    var pg = this._slicePage(songs, page);
    var start = pg.start;
    var list = pg.sliced;
    var self = this;
    var html = '<div class="detail-toolbar"><button class="btn btn-sm btn-secondary" onclick="App._goBackFromSongListDetail()">← 返回</button>' +
      (this._songlistDetailTitle ? '<span class="detail-title">' + this._escapeHtml(this._songlistDetailTitle) + '</span>' : '') +
      (songs.length ? '<button class="btn btn-sm btn-primary" onclick="App.playFavoriteByIndexWithQueue(0, \'songlist\')">▶ 播放全部</button>' : '') + '</div>';
    html += '<div class="song-list">';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var globalIdx = start + i;
      var dur = s.interval || s.duration || '--:--';
      var coverUrl = s.img || s.picUrl || s.cover || '';
      var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + globalIdx + ', \'songlist\')">' +
        '<div class="song-number">' + String(globalIdx + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
        '<div class="song-info"><div class="song-title">' + (s.name || s.title || '') + '</div>' +
        '<div class="song-meta">' + (s.singer || s.artist || '') + ' · ' + (s.source || '') + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + globalIdx + ', \'songlist\')">▶</button></div>';
    }
    html += '</div>';
    html += '<div id="songlistDetailPagination"></div>';
    content.innerHTML = html;
    this._renderPagination('songlistDetailPagination', pg.total, page, function(p) {
      self._renderSonglistDetailPage(p);
      var ct = document.querySelector('.content');
      if (ct) ct.scrollTop = 0;
    });
  },

  // ===== 排行榜 (v1.6.0) =====
  _boardsData: [], _boardPlatform: 'kg',
  async loadLeaderBoards() {
    var platEl = document.getElementById('boardPlatform');
    if (platEl) {
      var platforms = [{k:'kg',n:'🐶 KG'},{k:'wy',n:'☁️ WY'},{k:'tx',n:'🐧 TX'}];
      var self = this;
      platEl.innerHTML = platforms.map(function(p) {
        var cls = p.k === self._boardPlatform ? 'hot-tag active' : 'hot-tag';
        return '<span class="' + cls + '" onclick="App._setBoardPlatform(\'' + p.k + '\')">' + p.n + '</span>';
      }).join('');
    }
    var content = document.getElementById('leaderboardContent');
    if (!content) return;
    content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">加载中...</p>';
    var resp = await API.getLeaderBoards(this._boardPlatform);
    if (resp.success && resp.data && resp.data.length > 0) {
      this._boardsData = resp.data;
      var icons = ['🥇','🥈','🥉','🔥','📈','🎵','🎸','🎤','💃','🌍'];
      var html = '<div class="playlist-grid">';
      for (var i = 0; i < resp.data.length; i++) {
        var b = resp.data[i];
        var icon = icons[i % icons.length];
        html += '<div class="playlist-card" onclick="App.loadLeaderList(\'' + (b.bangid || b.id || '') + '\',\'' + (b.name || b.title || '').replace(/'/g, "\\'") + '\')">' +
          '<span class="playlist-card-play-btn" onclick="event.stopPropagation();App._playLeaderboardCard(\'' + (b.bangid || b.id || '') + '\')" title="播放">▶</span>' +
          '<div class="playlist-card-icon">' + icon + '</div>' +
          '<div class="playlist-card-name">' + (b.name || b.title || '') + '</div></div>';
      }
      html += '</div>';
      content.innerHTML = html;
    }
  },
  _leaderListCurrentPage: 1,
  async loadLeaderList(bangid, name) {
    var content = document.getElementById('leaderboardContent');
    if (!content) return;
    content.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-tertiary);">加载中...</p>';
    this._currentBangid = bangid;
    this._currentBangName = name;
    var resp = await API.getLeaderList(this._boardPlatform, bangid);
    if (resp.success && resp.data && resp.data.length > 0) {
      this.favoritesResults = resp.data;
      this._leaderListCurrentPage = 1;
      this._renderLeaderListPage(1);
    }
  },
  _renderLeaderListPage(page) {
    var content = document.getElementById('leaderboardContent');
    if (!content) return;
    this._leaderListCurrentPage = page;
    var songs = this.favoritesResults;
    var pg = this._slicePage(songs, page);
    var start = pg.start;
    var list = pg.sliced;
    var self = this;
    var html = '<button class="btn btn-sm btn-secondary" onclick="App.loadLeaderBoards()" style="margin-bottom:12px;">← 返回排行榜</button>';
    html += '<span style="font-size:16px;font-weight:600;margin-left:8px;">' + (this._currentBangName || '') + '</span>';
    html += '<div class="song-list" style="margin-top:12px;">';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var globalIdx = start + i;
      var dur = s.interval || s.duration || '--:--';
      var coverUrl = s.img || s.picUrl || '';
      var coverHtml = coverUrl ? '<img src="' + coverUrl + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">' : '🎵';
      html += '<div class="song-item" onclick="App.playFavoriteByIndexWithQueue(' + globalIdx + ', \'leaderboard\')">' +
        '<div class="song-number">' + String(globalIdx + 1).padStart(2, '0') + '</div>' +
        '<div class="song-cover" style="overflow:hidden;">' + coverHtml + '</div>' +
        '<div class="song-info"><div class="song-title">' + (s.name || s.title || '') + '</div>' +
        '<div class="song-meta">' + (s.singer || s.artist || '') + ' · ' + (s.source || '') + '</div></div>' +
        '<div class="song-duration">' + dur + '</div>' +
        '<button class="song-action" onclick="event.stopPropagation();App.playFavoriteByIndexWithQueue(' + globalIdx + ', \'leaderboard\')">▶</button></div>';
    }
    html += '</div>';
    html += '<div id="leaderListPagination"></div>';
    content.innerHTML = html;
    this._renderPagination('leaderListPagination', pg.total, page, function(p) {
      self._renderLeaderListPage(p);
      var ct = document.querySelector('.content');
      if (ct) ct.scrollTop = 0;
    });
  },

  // ===== 播放历史 =====

  // 智能音源记忆 (v1.0.78) - 查找历史记录
  findHistoryBySong(name, singer) {
    try {
      var history = JSON.parse(localStorage.getItem('lx-play-history') || '[]');
      var key = name + '-' + singer;
      for (var i = 0; i < history.length; i++) {
        if ((history[i].title + '-' + history[i].artist) === key) {
          return history[i];
        }
      }
      return null;
    } catch(e) {
      console.error('[LX] findHistoryBySong error:', e);
      return null;
    }
  },

  // 智能音源记忆 (v1.0.78) - 更新历史记录
  updateHistoryAfterPlay(song, source, quality, playType) {
    try {
      var history = JSON.parse(localStorage.getItem('lx-play-history') || '[]');
      var key = song.name + '-' + song.singer;
      var found = false;

      for (var i = 0; i < history.length; i++) {
        if ((history[i].title + '-' + history[i].artist) === key) {
          // 找到记录，更新
          history[i].lastSuccessSource = source;
          history[i].lastSuccessQuality = quality;
          history[i].successCount = (history[i].successCount || 0) + 1;
          history[i].failCount = 0;  // 成功后重置失败次数
          history[i].playCount = (history[i].playCount || 0) + 1;
          history[i].playType = playType || 'manual';
          history[i].playedAt = new Date().toISOString();
          found = true;
          console.log('[LX] 更新音源记录:', source, quality, '播放次数:', history[i].playCount);
          break;
        }
      }

      if (!found) {
        // 新建记录
        history.push({
          title: song.name,
          artist: song.singer,
          album: song.album || '',
          cover: song.cover || song.img || '',
          lastSuccessSource: source,
          lastSuccessQuality: quality,
          successCount: 1,
          failCount: 0,
          playCount: 1,
          playType: playType || 'manual',
          isCached: false,
          playedAt: new Date().toISOString()
        });
        console.log('[LX] 创建音源记录:', source, quality);
      }

      // 只保留最近 100 条记录
      if (history.length > 100) {
        history = history.slice(-100);
      }

      localStorage.setItem('lx-play-history', JSON.stringify(history));

      // 检查是否需要缓存 (v1.0.78)
      this.checkAndCacheSong(song, source, quality, playType);
    } catch(e) {
      console.error('[LX] updateHistoryAfterPlay error:', e);
    }
  },

  // 智能缓存 (v1.0.78) - 检查并触发缓存
  async checkAndCacheSong(song, source, quality, playType) {
    try {
      var history = this.findHistoryBySong(song.name, song.singer);
      if (!history || history.isCached) return;

      // 缓存阈值
      var threshold = {
        voice: 2,    // 语音点歌2次缓存
        manual: 5,   // 手动播放5次缓存
        random: 10   // 随机播放10次缓存
      }[playType] || 5;

      if (history.playCount >= threshold) {
        console.log('[LX] 达到缓存阈值，触发缓存:', song.name, '播放次数:', history.playCount);

        var resp = await API.cacheDownload({
          songId: song.id,
          source: source,
          quality: quality,
          name: song.name,
          singer: song.singer,
          album: song.album || '',
          cover: song.cover || song.img || ''
        });

        if (resp.success) {
          history.isCached = true;
          this.saveHistory();
          this.showToast('✓ 已缓存到服务器');
          console.log('[LX] 缓存成功');
        } else {
          console.log('[LX] 缓存失败:', resp.error);
        }
      }
    } catch(e) {
      console.error('[LX] checkAndCacheSong error:', e);
    }
  },

  // v1.8.22: 播放完成触发缓存（不区分浏览器/音箱模式）
  // 无论是浏览器播放还是小爱音箱语音点歌，播放完成说明是真正想听的歌
  async triggerCacheOnComplete() {
    try {
      if (!this.currentSong) return;
      var song = this.currentSong;
      var history = this.findHistoryBySong(song.name, song.singer);
      // 已缓存则跳过
      if (history && history.isCached) {
        console.log('[LX] 播放完成缓存跳过: 已缓存 -', song.name);
        return;
      }
      // 获取实际使用的音源和音质
      var source = song._cachedSource || song.source || '';
      var quality = song._cachedQuality || '320k';
      console.log('[LX] 播放完成，触发缓存:', song.name, source, quality);
      var resp = await API.cacheDownload({
        songId: song.id,
        source: source,
        quality: quality,
        name: song.name,
        singer: song.singer,
        album: song.album || '',
        cover: song.cover || song.img || ''
      });
      if (resp.success) {
        if (history) { history.isCached = true; this.saveHistory(); }
        console.log('[LX] ✓ 播放完成自动缓存成功:', song.name);
      } else {
        console.log('[LX] 播放完成缓存失败:', resp.error);
      }
    } catch(e) {
      console.error('[LX] triggerCacheOnComplete error:', e);
    }
  },

  // 保存历史记录到 localStorage
  saveHistory() {
    try {
      var history = JSON.parse(localStorage.getItem('lx-play-history') || '[]');
      localStorage.setItem('lx-play-history', JSON.stringify(history));
    } catch(e) {
      console.error('[LX] saveHistory error:', e);
    }
  },

  _historyCurrentPage: 1,
  async refreshHistory() {
    var resp = await API.getHistory(500);
    var container = document.getElementById('historyList');
    if (resp.success && resp.data && resp.data.length > 0) {
      // 存储历史记录用于播放
      this.historyResults = resp.data;
      console.log('[LX] 历史记录样本:', JSON.stringify(resp.data[0])); // 调试日志
      this._historyCurrentPage = 1;
      this._renderHistoryPage(1);
    } else {
      container.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:40px;">暂无播放记录</p>';
    }
  },
  _renderHistoryPage(page) {
    var container = document.getElementById('historyList');
    if (!container) return;
    this._historyCurrentPage = page;
    var pg = this._slicePage(this.historyResults, page);
    var start = pg.start;
    var list = pg.sliced;
    var self = this;
    var html = '<div class="history-group"><div class="history-date">最近播放</div><div class="song-list">';
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      var globalIdx = start + i;
      var coverHtml = '<div class="song-cover">🎵</div>';
      if (h.cover) {
        coverHtml = '<div class="song-cover" style="background-image:url(' + h.cover + ');background-size:cover;background-position:center;"></div>';
      }
      var num = (globalIdx + 1).toString().padStart(2, '0');
      // 时长格式化
      var durationText = '--:--';
      var dur = h.duration;
      if (dur && typeof dur === 'number' && dur > 0) {
        if (dur > 7200) { dur = Math.round(dur / 1000); }
        var min = Math.floor(dur / 60);
        var sec = Math.floor(dur % 60);
        durationText = min + ':' + String(sec).padStart(2, '0');
      } else if (typeof dur === 'string' && dur.includes(':')) {
        durationText = dur;
      } else if (h.playedAt) {
        durationText = h.playedAt.substring(11, 16);
      }
      html += '<div class="song-item" onclick="App.playHistoryByIndex(' + globalIdx + ')">';
      html += '<div class="song-number">' + num + '</div>';
      html += coverHtml;
      html += '<div class="song-info"><div class="song-title">' + h.title + '</div><div class="song-meta">' + h.artist + ' · ' + h.source + ' · ' + h.quality + '</div></div>';
      html += '<div class="song-duration">' + durationText + '</div>';
      html += '<button class="song-action" onclick="event.stopPropagation();App.playHistoryByIndex(' + globalIdx + ')">▶</button></div>';
    }
    html += '</div></div>';
    html += '<div id="historyPagination"></div>';
    container.innerHTML = html;
    this._renderPagination('historyPagination', pg.total, page, function(p) {
      self._renderHistoryPage(p);
      var ct = document.querySelector('.content');
      if (ct) ct.scrollTop = 0;
    });
  },

  // 播放历史记录歌曲
  playHistoryByIndex(index) {
    if (index < 0 || index >= this.historyResults.length) {
      this.showToast('歌曲索引无效');
      return;
    }
    // 建立历史播放队列
    this.playQueue = this.historyResults.map(function(h) {
      return {
        id: h.songId || h.id,
        name: h.title,
        singer: h.artist,
        album: h.album || '',
        source: h.source,
        cover: h.cover || '',
        quality: h.quality
      };
    });
    this.currentQueueIndex = index;
    this.currentQueueType = 'history';
    var h = this.historyResults[index];
    // 构建歌曲对象
    var song = {
      id: h.songId || h.id,
      name: h.title,
      singer: h.artist,
      album: h.album || '',
      source: h.source,
      cover: h.cover || '',
      quality: h.quality
    };
    this.playSongItem(song, song.source);
    console.log('[LX] 设置播放队列: history, 当前索引: ' + index + ', 队列长度: ' + this.playQueue.length);
  },

  async clearHistory() {
    if (confirm('确定清空所有播放历史？')) { await API.clearHistory(); await this.refreshHistory(); this.showToast('历史已清空'); }
  },

  // ===== 设置（服务器+本地双保存）=====
  async restoreSettings() {
    this.setupSettingsAutoSave();
    var resp = null;
    try {
      resp = await API.getConfig();
    } catch(e) {}

    var hasBackendConfig = !!(
      resp && resp.success && resp.data &&
      ConfigSyncPolicy.hasConnectionIdentity(resp.data)
    );
    if (!hasBackendConfig) {
      this.restoreLocalSettings();
    }

    try {
      if (resp && resp.success && resp.data) {
        var c = resp.data;
        var fields = { cfgHost: c.host || '', cfgUser: c.username || '', cfgWebPlayer: c.webPlayerUrl || '' };
        for (var id in fields) { var el = document.getElementById(id); if (el && fields[id]) el.value = fields[id]; }
        if (hasBackendConfig && document.getElementById('cfgPass')) {
          document.getElementById('cfgPass').value = '';
        }
        if (c.defaultQuality && document.getElementById('cfgQuality')) document.getElementById('cfgQuality').value = c.defaultQuality;
        if (document.getElementById('cfgQualityDowngrade')) document.getElementById('cfgQualityDowngrade').checked = c.allowQualityDowngrade !== false;
        if (document.getElementById('cfgCustomSources')) document.getElementById('cfgCustomSources').checked = c.enableCustomSources !== false;
        if (document.getElementById('cfgFuzzyMatch')) document.getElementById('cfgFuzzyMatch').checked = c.enableFuzzyMatch !== false;
        // v1.8.22: 恢复音源优先级
        if (c.sourcePriority && Array.isArray(c.sourcePriority)) {
          this._sourcePriority = c.sourcePriority;
          this.renderSourcePriority();
        }
      }
    } catch(e) {}
  },

  async saveSettings() {
    // 1) 始终保存到本地（不丢数据）
    this.saveLocalSettings();

    // 2) 尝试保存到服务器
    var config = {
      host: document.getElementById('cfgHost').value.trim(),
      username: document.getElementById('cfgUser').value.trim(),
      webPlayerUrl: document.getElementById('cfgWebPlayer').value.trim(),
      defaultQuality: document.getElementById('cfgQuality').value,
      allowQualityDowngrade: document.getElementById('cfgQualityDowngrade').checked,
      enableCustomSources: document.getElementById('cfgCustomSources').checked,
      enableFuzzyMatch: document.getElementById('cfgFuzzyMatch').checked,
      sourcePriority: this._sourcePriority,  // v1.8.22: 保存音源优先级
    };
    var enteredPassword = document.getElementById('cfgPass').value;
    if (enteredPassword) config.password = enteredPassword;

    var resp = await API.saveConfig(config);
    if (resp.success) {
      this.showToast('✅ 设置已保存');

      // 自动测试连接（如果配置完整）
      if (config.host && config.username) {
        var self = this;
        setTimeout(function() {
          API.testConnection().then(function(testResp) {
            if (testResp && testResp.success) {
              console.log('[AutoLogin] ✅ 自动连接成功');
            } else {
              console.warn('[AutoLogin] ⚠️ 自动连接失败:', testResp ? (testResp.message || testResp.error) : 'no response');
            }
          }).catch(function(e) {
            console.warn('[AutoLogin] ❌ 自动连接出错:', e);
          });
        }, 500);
      }
    } else {
      this.showToast('⚠ 服务器保存失败(' + (resp.httpStatus || resp.error || '') + ')，但已保存到浏览器本地，刷新不丢');
    }
  },

  togglePassword() { var el = document.getElementById('cfgPass'); var btn = el.nextElementSibling; el.type = el.type === 'password' ? 'text' : 'password'; btn.textContent = el.type === 'password' ? '👁' : '🙈'; },

  // ===== 自定义源管理 (v2.1.0) =====
  customSources: [],
  customSourceStats: {},

  async refreshCustomSources() {
    try {
      var resp = await API.getCustomSources();
      if (resp.success && resp.data) {
        this.customSources = resp.data;
        this.renderCustomSourceList();
      }
      // 同时获取统计数据
      var statsResp = await API.getCustomSourceStats();
      if (statsResp.success && statsResp.data) {
        this.customSourceStats = statsResp.data;
        this.renderCustomSourceStats();
      }
    } catch (e) {
      console.error('[App] 刷新自定义源失败:', e);
      this.showToast('刷新自定义源列表失败');
    }
  },

  renderCustomSourceList() {
    var container = document.getElementById('customSourceList');
    if (!container) return;
    if (this.customSources.length === 0) {
      container.innerHTML = '<div style="padding:12px;color:var(--text-secondary);text-align:center;">未找到自定义源</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < this.customSources.length; i++) {
      var src = this.customSources[i];
      var stateClass = src.enabled ? 'cs-enabled' : 'cs-disabled';
      var platforms = (src.supportedSources || []).join(', ');
      var version = src.version || '';
      html += '<div class="cs-item ' + stateClass + '" draggable="true" data-idx="' + i + '">';
      html += '<span class="cs-handle" title="拖拽排序">⠿</span>';
      html += '<span class="cs-name">' + src.name + '</span>';
      if (version) html += '<span class="cs-version">' + (version.startsWith('v') ? version : 'v' + version) + '</span>';
      html += '<button class="cs-toggle ' + (src.enabled ? 'cs-on' : 'cs-off') + '" onclick="App.toggleCustomSource(' + i + ')">' + (src.enabled ? '禁用' : '启用') + '</button>';
      if (platforms) html += '<span class="cs-platforms">' + platforms + '</span>';
      html += '</div>';
    }
    container.innerHTML = html;
    this._bindDragSort(container);
  },

  _bindDragSort(container) {
    var self = this;
    var items = container.querySelectorAll('.cs-item');
    var dragIdx = null;
    items.forEach(function(item) {
      item.addEventListener('dragstart', function(e) {
        dragIdx = parseInt(item.dataset.idx);
        item.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', function() {
        item.style.opacity = '';
        container.querySelectorAll('.cs-item').forEach(function(el) { el.style.borderTopColor = ''; });
      });
      item.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.style.borderTopColor = 'var(--accent)';
      });
      item.addEventListener('dragleave', function() {
        item.style.borderTopColor = '';
      });
      item.addEventListener('drop', function(e) {
        e.preventDefault();
        item.style.borderTopColor = '';
        var dropIdx = parseInt(item.dataset.idx);
        if (dragIdx === null || dragIdx === dropIdx) return;
        var arr = self.customSources;
        var moved = arr.splice(dragIdx, 1)[0];
        arr.splice(dropIdx, 0, moved);
        self.renderCustomSourceList();
        self._saveCustomSourceOrder();
      });
    });
  },

  async _saveCustomSourceOrder() {
    var ids = this.customSources.map(function(s) { return s.id; });
    console.log('[App] _saveCustomSourceOrder: ids=' + JSON.stringify(ids));
    try {
      var resp = await API.reorderCustomSources(ids);
      console.log('[App] _saveCustomSourceOrder response:', resp);
    } catch (e) {
      console.error('[App] _saveCustomSourceOrder error:', e);
    }
  },

  renderCustomSourceStats() {
    var container = document.getElementById('customSourceStats');
    if (!container) return;
    var stats = this.customSourceStats;
    var totalKeys = Object.keys(stats);
    if (totalKeys.length === 0) {
      container.innerHTML = '<div style="padding:8px;color:var(--text-secondary);font-size:12px;">暂无统计数据</div>';
      return;
    }
    var html = '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
    for (var key of totalKeys) {
      var s = stats[key];
      html += '<div style="padding:6px 10px;background:var(--bg-secondary);border-radius:6px;font-size:11px;">';
      html += '<span style="color:var(--text-secondary);">' + key + ':</span> ';
      html += '<span style="color:var(--success);">✓' + s.success + '</span> ';
      html += '<span style="color:var(--danger);">✗' + s.fail + '</span>';
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  },

  async toggleCustomSource(index) {
    var src = this.customSources[index];
    if (!src) return;
    var newEnabled = !src.enabled;
    console.log('[App] toggleCustomSource: id=' + src.id + ' current=' + src.enabled + ' → ' + newEnabled);
    try {
      var resp = await API.toggleCustomSource(src.id, newEnabled);
      console.log('[App] toggleCustomSource response:', resp);
      if (resp.success) {
        src.enabled = newEnabled;
        this.renderCustomSourceList();
        this.showToast(src.name + ' 已' + (src.enabled ? '启用' : '禁用'));
      } else {
        this.showToast('操作失败: ' + (resp.error || JSON.stringify(resp)));
      }
    } catch (e) {
      console.error('[App] toggleCustomSource error:', e);
      this.showToast('操作失败: ' + String(e));
    }
  },

  async resetCustomSourceStats() {
    if (!confirm('确定要重置所有自定义源统计数据吗？')) return;
    try {
      var resp = await API.resetCustomSourceStats();
      if (resp.success) {
        this.customSourceStats = {};
        this.renderCustomSourceStats();
        this.showToast('统计数据已重置');
      }
    } catch (e) {
      this.showToast('重置失败: ' + String(e));
    }
  },

  async testConnection() {
    var status = document.getElementById('connStatus');
    status.textContent = '保存并测试中...'; status.className = 'status-badge status-idle';

    // 先保存到本地
    this.saveLocalSettings();

    // 尝试保存到服务器
    var saveResp = await API.saveConfig({
      host: document.getElementById('cfgHost').value.trim(),
      username: document.getElementById('cfgUser').value.trim(),
      password: document.getElementById('cfgPass').value,
      webPlayerUrl: document.getElementById('cfgWebPlayer').value.trim(),
      defaultQuality: document.getElementById('cfgQuality').value,
      allowQualityDowngrade: document.getElementById('cfgQualityDowngrade').checked,
      enableCustomSources: document.getElementById('cfgCustomSources').checked,
      enableFuzzyMatch: document.getElementById('cfgFuzzyMatch').checked,
    });

    if (!saveResp.success) {
      status.textContent = '❌ API ' + (saveResp.httpStatus || '?') + ': ' + (saveResp.error || '保存失败');
      status.className = 'status-badge status-error';
      this.showToast('保存失败(' + (saveResp.httpStatus || '?') + ')，但已保留在本地');
      return;
    }

    var resp = await API.testConnection();
    if (resp.success) {
      status.textContent = '✅ 连接成功'; status.className = 'status-badge status-success';
      this.showToast('LXServer连接成功！');
    } else {
      var err = resp.error || resp.message || '连接失败';
      status.textContent = '❌ ' + err; status.className = 'status-badge status-error';
      this.showToast('连接失败: ' + err);
    }
    setTimeout(function() { status.textContent = '等待测试'; status.className = 'status-badge status-idle'; }, 8000);
  },

  // ===== 播放模式 / 音量 =====
  playModeNames: { order: '顺序播放', random: '随机播放', single: '单曲循环', loop: '列表循环' },
  initPlayModeDisplay() {
    var btn = document.getElementById('btnMode');
    if (btn) {
      btn.textContent = this.playModeIcons[this.playMode] || '▶️';
      btn.setAttribute('data-tip', this.playModeNames[this.playMode] || '播放模式');
    }
    var playerButton = document.getElementById('playerPageModeBtn');
    if (playerButton) {
      playerButton.textContent = this.playModeIcons[this.playMode] || '🔁';
      playerButton.setAttribute('data-tip', this.playModeNames[this.playMode] || '播放模式');
    }
  },
  cyclePlayMode() {
    this.playModeIdx = (this.playModeIdx + 1) % this.playModes.length;
    this.playMode = this.playModes[this.playModeIdx];
    var btn = document.getElementById('btnMode');
    if (btn) {
      btn.textContent = this.playModeIcons[this.playMode] || '🔁';
      btn.setAttribute('data-tip', this.playModeNames[this.playMode] || '播放模式');
    }
    var playerBtn = document.getElementById('playerPageModeBtn');
    if (playerBtn) {
      playerBtn.textContent = this.playModeIcons[this.playMode] || '🔁';
      playerBtn.setAttribute('data-tip', this.playModeNames[this.playMode] || '播放模式');
    }
    // 只在浏览器模式下调用后端API（音箱不支持set_mode）
    if (this.isBrowserMode) {
      this.controlPlayback('set_mode', { mode: this.playMode });
    }
    console.log('[LX] 播放模式切换为: ' + this.playModeNames[this.playMode]);
  },

  adjustVolume(e) {
    var rect = e.currentTarget.getBoundingClientRect();
    var pct = Math.round((e.clientX - rect.left) / rect.width * 100);
    pct = Math.max(0, Math.min(100, pct));
    this.setVolume(pct);
  },

  // ===== 进度条拖拽/点击 (v2.2.0) =====
  seekTo(e) {
    if (!this.isBrowserMode || !this.audioPlayer) return;
    var rect = e.currentTarget.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    this.audioPlayer.currentTime = pct * this.audioPlayer.duration;
  },

  startSeekDrag(e) {
    if (!this.isBrowserMode || !this.audioPlayer) return;
    e.preventDefault();
    this._seekDragging = true;
    var self = this;
    var bar = e.currentTarget;

    function onMove(ev) {
      if (!self._seekDragging) return;
      var rect = bar.getBoundingClientRect();
      var pct = (ev.clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      document.getElementById('progressFill').style.width = (pct * 100) + '%';
      if (self.audioPlayer.duration) {
        document.getElementById('currentTime').textContent = self.formatTime(pct * self.audioPlayer.duration);
      }
    }

    function onUp(ev) {
      if (!self._seekDragging) return;
      self._seekDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // 跳转
      var rect = bar.getBoundingClientRect();
      var pct = (ev.clientX - rect.left) / rect.width;
      pct = Math.max(0, Math.min(1, pct));
      if (self.audioPlayer.duration) {
        self.audioPlayer.currentTime = pct * self.audioPlayer.duration;
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    onMove(e);
  },

  // v1.0.82: 音量拖拽支持
  startVolumeDrag(e) {
    e.preventDefault();
    this._volumeDragging = true;
    var self = this;
    var slider = document.querySelector('.volume-slider');

    function onMove(ev) {
      if (!self._volumeDragging) return;
      var rect = slider.getBoundingClientRect();
      var pct = Math.round((ev.clientX - rect.left) / rect.width * 100);
      pct = Math.max(0, Math.min(100, pct));
      self.setVolume(pct);
    }

    function onUp() {
      self._volumeDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // 也处理初始点击位置
    onMove(e);
  },

  // ===== 音量控制增强 (v1.0.55) =====
  setVolume(vol) {
    vol = Math.max(0, Math.min(100, vol));  // 确保范围 0-100
    this.currentVolume = vol;
    // 如果手动调整音量（且音量>0），取消静音状态
    if (this.isMuted && vol > 0) {
      this.isMuted = false;
    }
    this.applyVolumeUI();
    localStorage.setItem('lx-volume', vol);
    this.updateMobileVolumeUI();  // 同步移动端音量UI

    // 应用到播放器
    if (this.isBrowserMode && this.audioPlayer) {
      this.audioPlayer.volume = vol / 100;
    } else if (this.currentDevice) {
      // v1.0.84: 拖拽时频繁调用，节流300ms
      this.logDebug('volume', '设置音量', vol + '%');
      clearTimeout(this._volumeThrottle);
      var self = this;
      this._volumeThrottle = setTimeout(function() {
        self.controlPlayback('set_volume', { volume: self.currentVolume });
      }, 300);
    }
  },

  updateVolumeIcon() {
    var icon = document.getElementById('volumeIcon');
    var playerIcon = document.getElementById('playerPageVolumeIcon');
    var text = this.isMuted || this.currentVolume === 0 ? '🔇' : (this.currentVolume <= 35 ? '🔉' : '🔊');
    if (icon) {
      icon.textContent = text;
    }
    if (playerIcon) {
      playerIcon.textContent = text;
      playerIcon.setAttribute('aria-label', this.isMuted ? '取消静音' : '静音');
    }
  },

  toggleMute() {
    if (this.isMuted) {
      // 取消静音：恢复之前的音量
      this.isMuted = false;
      var restoreVol = Math.max(10, this.volumeBeforeMute);  // 至少恢复到10%
      this.currentVolume = restoreVol;
      localStorage.setItem('lx-volume', restoreVol);
      if (this.isBrowserMode && this.audioPlayer) {
        this.audioPlayer.volume = restoreVol / 100;
      } else {
        this.controlPlayback('set_volume', { volume: restoreVol });
      }
      this.applyVolumeUI();
      this.showToast('已取消静音');
    } else {
      // 静音：保存当前音量（至少记住10%）
      this.isMuted = true;
      this.volumeBeforeMute = Math.max(10, this.currentVolume);
      if (this.isBrowserMode && this.audioPlayer) {
        this.audioPlayer.volume = 0;
      } else {
        this.controlPlayback('set_volume', { volume: 0 });
      }
      this.applyVolumeUI();
      this.showToast('已静音');
    }
  },

  // ===== 音箱状态同步 (v1.0.65) =====
  startStatusSync() {
    // 只在音箱模式下同步
    if (this.isBrowserMode) return;

    // 清除旧定时器
    if (this.statusSyncTimer) {
      clearInterval(this.statusSyncTimer);
    }

    // 每1秒同步一次 (v1.0.83: 2s→1s，进度条更流畅)
    var self = this;
    this.statusSyncTimer = setInterval(function() {
      self.syncPlayerStatus();
    }, 1000);

    // 立即同步一次
    this.syncPlayerStatus();
  },

  stopStatusSync() {
    if (this.statusSyncTimer) {
      clearInterval(this.statusSyncTimer);
      this.statusSyncTimer = null;
    }
  },

  async syncPlayerStatus() {
    if (this.isBrowserMode) return;  // 浏览器模式不需要同步

    var resp = await this.fetchSpeakerStatus();
    if (resp === null) return;
    if (!resp || !resp.success) return;

    var status = resp.data || resp;

    // 更新播放状态 (v1.0.82: 后端返回state字段)
    if (status.state !== undefined) {
      var isNowPlaying = status.state === 'playing';
      var keepPushedPlayingState = this.isPlaying && !isNowPlaying && Date.now() < this.speakerPlayStateProtectedUntil;
      if (this.isPlaying !== isNowPlaying && !keepPushedPlayingState) {
        this.isPlaying = isNowPlaying;
        this.updatePlayButton();
      }
      // MIoT 状态可能在推送后的数秒内仍返回 paused。
      // 当前会话的假进度只由明确停止或切换设备时清空。
    }

    // 更新音量 (v1.0.82: 后端已返回0-100范围，不需要*100)
    if (status.volume !== undefined && status.volume >= 0) {
      var vol = Math.round(status.volume);
      if (Math.abs(this.currentVolume - vol) > 2) {  // 差异超过2%才更新
        this.currentVolume = vol;
        this.applyVolumeUI();
      }
    }

    // 更新播放进度 (v1.0.84: 前端自计时，MIoT不返回position)
    // 假进度条：只要有开始时间就更新，不依赖isPlaying（会被status sync覆盖）
    if (this.songStartedAt > 0 && !this.isBrowserMode) {
      var dur = this.songDuration || 240;  // 兜底4分钟
      var elapsed = Date.now() / 1000 - this.songStartedAt;
      if (elapsed < 0) elapsed = 0;
      var reachedEnd = elapsed >= dur;
      if (reachedEnd) {
        elapsed = dur;
        this.speakerPlaybackEndPending = true;
      }
      this.renderSpeakerProgress();
      var pct = (elapsed / dur) * 100;

      // v1.8.22: 音箱模式播放完成检测（进度>=98%）
      if (pct >= 98 && !this._cacheTriggeredForCurrentSong) {
        this._cacheTriggeredForCurrentSong = true;
        this.triggerCacheOnComplete();
      }
      this.advanceSpeakerAfterCompletion(status.state);
    }
    // 停止/切歌时 playSongItem 会重新设置 songStartedAt/songDuration
  },

  // ===== 新手引导 =====
  checkOnboarding() {
    if (localStorage.getItem('lx-onboarding-dismissed')) {
      var card = document.getElementById('onboardingCard'); if (card) card.style.display = 'none';
    }
  },
  dismissOnboarding() {
    var card = document.getElementById('onboardingCard'); if (card) card.style.display = 'none';
    localStorage.setItem('lx-onboarding-dismissed', '1'); this.showToast('引导已隐藏');
  },
  markObStep(n) {
    var step = document.getElementById('obStep' + n); if (step) { step.classList.add('done'); step.classList.remove('current'); }
    var next = document.getElementById('obStep' + (n + 1)); if (next) next.classList.add('current');
    this.updateObProgress(); if (n >= 2) this.completeOnboarding();
  },
  updateObProgress() {
    var done = document.querySelectorAll('.onboarding-step.done').length;
    var t = document.getElementById('obProgressText'); var b = document.getElementById('obProgressBar');
    if (t) t.textContent = '完成 ' + done + '/2 步'; if (b) b.style.width = (done / 2 * 100) + '%';
  },
  completeOnboarding() {
    var self = this, card = document.getElementById('onboardingCard');
    if (card) card.classList.add('completed');
    setTimeout(function() { self.showToast('🎉 配置完成！'); setTimeout(function() { if (card) card.style.display = 'none'; }, 2000); }, 300);
  },

  // ===== 主题 =====
  async loadTheme() {
    var resp = await API.getTheme();
    var theme = (resp.success && resp.data && resp.data.theme) ? resp.data.theme : 'auto';
    this.applyTheme(theme);
    document.querySelectorAll('.theme-item').forEach(function(i) { i.classList.remove('active'); });
    var active = document.querySelector('.theme-item[data-theme="' + theme + '"]');
    if (active) active.classList.add('active');
  },
  toggleThemeDropdown() { document.getElementById('themeDropdown').classList.toggle('show'); },
  cycleTheme() {
    // 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统
    var current = document.documentElement.getAttribute('data-theme') || 'auto';
    var order = ['auto', 'light', 'dark'];
    var idx = order.indexOf(current);
    if (idx < 0) idx = 0;
    var next = order[(idx + 1) % 3];
    // 直接调用 applyTheme + 保存（不依赖 setTheme 的 el 参数）
    this.applyTheme(next);
    API.saveTheme(next);
    localStorage.setItem('lx-theme', next === 'auto' ? '' : next);
    var labels = { auto: '🖥 跟随系统', light: '☀️ 浅色', dark: '🌙 深色' };
    this.showToast(labels[next] || next);
  },
  async setTheme(mode, el) {
    document.querySelectorAll('.theme-item').forEach(function(i) { i.classList.remove('active'); });
    el.classList.add('active'); document.getElementById('themeDropdown').classList.remove('show');
    this.applyTheme(mode); await API.saveTheme(mode);
    localStorage.setItem('lx-theme', mode === 'auto' ? '' : mode);
    this.showToast('主题: ' + (mode === 'dark' ? '深色' : mode === 'light' ? '浅色' : '跟随系统'));
  },
  applyTheme(mode) {
    var btn = document.getElementById('themeBtn');
    if (mode === 'auto') {
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', mode);
    }
    if (btn) btn.textContent = '🎨';
  },

  // ===== 日志面板 (v1.0.85) =====
  logDebug(type, action, detail, result) {
    // 兼容旧调用: logDebug(action, detail) → type默认'speaker'
    if (arguments.length <= 2) {
      result = detail;
      detail = action;
      action = type;
      type = 'speaker';
    }

    console.log('[LX]', type, action, detail, result);

    var deviceName = this.isBrowserMode ? '🖥 浏览器' : (this.currentDevice ? '🔊 ' + this.currentDevice.device_name : '🔊 音箱');
    var entry = {
      time: Date.now(),
      device: deviceName,
      type: type,
      action: action,
      detail: String(detail||''),
      result: result || null
    };
    this.logEntries.push(entry);
    if (this.logEntries.length > 200) this.logEntries.shift();

    // 日志面板可见时实时刷新
    if (document.body.classList.contains('log-panel-open')) {
      this.renderLogs();
    }
  },

  // 日志面板拖拽移动 (v1.0.86: 悬浮窗口，拖头部移动)
  setupLogPanelResize() {
    var panel = document.getElementById('logPanel');
    var header = panel ? panel.querySelector('.log-panel-header') : null;
    if (!panel || !header) return;

    var self = this;
    header.addEventListener('mousedown', function(e) {
      e.preventDefault();
      panel.classList.add('dragging');
      var startX = e.clientX;
      var startY = e.clientY;
      var panelLeft = panel.offsetLeft;
      var panelTop = panel.offsetTop;

      function onMove(ev) {
        panel.style.left = (panelLeft + ev.clientX - startX) + 'px';
        panel.style.top = (panelTop + ev.clientY - startY) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }

      function onUp() {
        panel.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },

  // 切换日志面板 (v1.0.86: body class 控制，不遮挡内容)
  toggleLogPanel() {
    var isOpen = document.body.classList.contains('log-panel-open');
    if (!isOpen) {
      document.body.classList.add('log-panel-open');
      this.logStartTime = Date.now() - 60000; // 默认1分钟前
      this.updateTimeBtn();
      this.updateDeviceFilter();  // 刷新设备列表
      this.fetchVoiceLogs();  // 拉取后端语音日志
      this.renderLogs();

      // 每10秒轮询语音日志
      var self = this;
      this._voiceLogTimer = setInterval(function() { self.fetchVoiceLogs(); }, 10000);
    } else {
      document.body.classList.remove('log-panel-open');
      if (this._voiceLogTimer) { clearInterval(this._voiceLogTimer); this._voiceLogTimer = null; }
    }
  },

  // 拉取后端语音交互日志和播放追踪日志
  async fetchVoiceLogs() {
    try {
      // 并行获取语音日志和播放追踪日志
      var voiceResp = await API.getVoiceLogs();
      var playbackResp = await API.getPlaybackLogs();

      console.log('[LX] getVoiceLogs:', JSON.stringify(voiceResp).substring(0, 300));
      console.log('[LX] getPlaybackLogs:', JSON.stringify(playbackResp).substring(0, 300));

      var newEntries = [];

      // 处理语音日志
      if (voiceResp.success && Array.isArray(voiceResp.data)) {
        newEntries = newEntries.concat(voiceResp.data.map(function(v) {
          return { time: v.time, type: 'voice', action: v.action, detail: v.detail, result: v.result, extra: v.extra };
        }));
      }

      // 处理播放追踪日志
      if (playbackResp.success && Array.isArray(playbackResp.data)) {
        newEntries = newEntries.concat(playbackResp.data.map(function(p) {
          return {
            time: p.time,
            type: 'playback',
            action: '播放追踪',
            detail: p.songTitle + ' - ' + p.songArtist,
            result: 'success',
            extra: {
              keyword: p.keyword,
              source: p.source,
              platform: p.platform,
              urlPrefix: p.urlPrefix
            }
          };
        }));
      }

      // 合并到本地日志（去重）
      var merged = [];
      var allEntries = this.logEntries.concat(newEntries);
      // 按时间排序去重
      allEntries.sort(function(a, b) { return a.time - b.time; });
      var seen = {};
      for (var i = 0; i < allEntries.length; i++) {
        var key = allEntries[i].time + '|' + allEntries[i].action + '|' + allEntries[i].detail;
        if (!seen[key]) { seen[key] = true; merged.push(allEntries[i]); }
      }
      this.logEntries = merged.slice(-200);
      if (document.body.classList.contains('log-panel-open')) {
        this.renderLogs();
      }
    } catch(e) {
      // 静默失败
      console.warn('[LX] fetchVoiceLogs error:', e);
    }
  },

  // 渲染过滤后的日志
  renderLogs() {
    var body = document.getElementById('logPanelBody');
    if (!body) return;

    var deviceFilter = document.getElementById('logDeviceFilter');
    var typeFilter = document.getElementById('logTypeFilter');
    var filterDevice = deviceFilter ? deviceFilter.value : 'all';
    var filterType = typeFilter ? typeFilter.value : 'all';
    var startTime = this.logStartTime || (Date.now() - 60000);
    var iconMap = { play: '▶', volume: '🔊', voice: '🎤', search: '🔍', error: '❌', playback: '🎵' };

    var filtered = this.logEntries.filter(function(e) {
      if (filterDevice !== 'all' && e.device !== filterDevice) return false;
      if (filterType !== 'all' && e.type !== filterType) return false;
      if (startTime && e.time < startTime) return false;
      return true;
    });

    if (filtered.length === 0) {
      body.innerHTML = '<div class="log-empty">暂无匹配日志</div>';
    } else {
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var e = filtered[i];
        var d = new Date(e.time);
        var ts = d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
        var icon = iconMap[e.type] || '📌';
        var rCls = e.result === 'success' || e.result === '✅' ? 'le-ok' : (e.result === 'fail' || e.result === '❌' ? 'le-fail' : '');
        var rText = e.result || '';

        // 播放追踪显示额外信息
        var extraInfo = '';
        if (e.type === 'playback' && e.extra) {
          var sourceLabel = e.extra.source === 'miot-voice' ? '🎤语音' : (e.extra.source === 'web-ui' ? '🖥网页' : e.extra.source);
          var platformLabel = e.extra.platform || 'unknown';
          extraInfo = '<span class="le-extra" style="color: var(--text-tertiary); font-size: 11px; margin-left: 8px;">' +
            '[' + sourceLabel + ' | ' + platformLabel + ']' +
            (e.extra.keyword ? ' 关键词:"' + e.extra.keyword + '"' : '') +
            '</span>';
        }

        html += '<div class="log-entry type-' + e.type + '"><span class="le-time">' + ts + '</span><span class="le-icon">' + icon + '</span><span class="le-action">' + e.action + '</span><span class="le-detail">' + (e.detail||'') + '</span>' + extraInfo + '<span class="le-result ' + rCls + '">' + rText + '</span></div>';
      }
      body.innerHTML = html;
      body.scrollTop = body.scrollHeight; // 滚动到底部
    }

    document.getElementById('logCount').textContent = '共 ' + filtered.length + ' 条';
  },

  // 动态填充设备筛选下拉 (v1.0.89)
  updateDeviceFilter() {
    var sel = document.getElementById('logDeviceFilter');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '<option value="all">全部设备</option>';

    // 从已有日志中提取所有设备名
    var devices = {};
    for (var i = 0; i < this.logEntries.length; i++) {
      var d = this.logEntries[i].device;
      if (d && d !== 'all') devices[d] = true;
    }
    // 加上当前设备
    if (this.isBrowserMode) {
      devices['🖥 浏览器'] = true;
    } else if (this.currentDevice) {
      devices['🔊 ' + this.currentDevice.device_name] = true;
    }

    var names = Object.keys(devices).sort();
    for (var j = 0; j < names.length; j++) {
      var selected = names[j] === current ? ' selected' : '';
      sel.innerHTML += '<option value="' + names[j] + '"' + selected + '>' + names[j] + '</option>';
    }
  },

  // 更新时间按钮显示
  updateTimeBtn() {
    var btn = document.getElementById('logStartTimeBtn');
    if (!btn) return;
    if (!this.logStartTime) {
      btn.textContent = '--:--:--';
      return;
    }
    var d = new Date(this.logStartTime);
    btn.textContent = d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
  },

  // 显示时间选择器 (v1.0.86: 定位在按钮附近)
  showTimePicker(e) {
    var now = this.logStartTime ? new Date(this.logStartTime) : new Date(Date.now() - 60000);
    document.getElementById('logTpH').value = now.getHours();
    document.getElementById('logTpM').value = now.getMinutes();
    document.getElementById('logTpS').value = now.getSeconds();
    this.updateTimePreview();

    // 定位在时间按钮右下
    var btn = document.getElementById('logStartTimeBtn');
    var box = document.getElementById('logTpBox');
    var rect = btn.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.left = (rect.right - 280) + 'px';  // 右对齐按钮
    box.style.top = (rect.bottom + 4) + 'px';

    document.getElementById('timePickerOverlay').style.display = 'block';
  },

  // 隐藏时间选择器
  hideTimePicker() {
    document.getElementById('timePickerOverlay').style.display = 'none';
  },

  // 重置时间筛选
  resetTimeFilter() {
    this.logStartTime = 0;
    this.updateTimeBtn();
    document.getElementById('timePickerOverlay').style.display = 'none';
    this.renderLogs();
  },

  // 更新时间预览
  updateTimePreview() {
    var h = document.getElementById('logTpH').value.toString().padStart(2,'0');
    var m = document.getElementById('logTpM').value.toString().padStart(2,'0');
    var s = document.getElementById('logTpS').value.toString().padStart(2,'0');
    document.getElementById('logTpPreview').textContent = '显示 ' + h + ':' + m + ':' + s + ' 之后的日志';
  },

  // 应用时间筛选
  applyTimeFilter() {
    var h = parseInt(document.getElementById('logTpH').value) || 0;
    var m = parseInt(document.getElementById('logTpM').value) || 0;
    var s = parseInt(document.getElementById('logTpS').value) || 0;
    var now = new Date();
    now.setHours(h, m, s, 0);
    this.logStartTime = now.getTime();
    this.updateTimeBtn();
    document.getElementById('timePickerOverlay').style.display = 'none';
    this.renderLogs();
  },

  // 清屏
  clearLogs() {
    this.logEntries = [];
    this.renderLogs();
  },

  // 复制日志
  copyLogs() {
    var typeFilter = document.getElementById('logTypeFilter');
    var filterType = typeFilter ? typeFilter.value : 'all';
    var startTime = this.logStartTime || 0;

    var filtered = this.logEntries.filter(function(e) {
      if (filterType !== 'all' && e.type !== filterType) return false;
      if (startTime && e.time < startTime) return false;
      return true;
    });

    var lines = [];
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      var d = new Date(e.time);
      var ts = d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
      lines.push(ts + ' [' + e.type + '] ' + e.action + ': ' + (e.detail||'') + (e.result ? ' ' + e.result : ''));
    }
    var text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function() {
      App.showToast('已复制 ' + lines.length + ' 条日志');
    }).catch(function() {
      App.showToast('复制失败，请重试');
    });
  },

  // ===== 时间线视图 (v1.0.94) =====
  timelineData: [],
  _timelineTimer: null,

  toggleTimeline() {
    var isOpen = document.body.classList.contains('timeline-open');
    if (!isOpen) {
      document.body.classList.add('timeline-open');
      this.refreshTimeline();
      // 每15秒自动刷新
      var self = this;
      this._timelineTimer = setInterval(function() { self.refreshTimeline(); }, 15000);
    } else {
      document.body.classList.remove('timeline-open');
      if (this._timelineTimer) { clearInterval(this._timelineTimer); this._timelineTimer = null; }
    }
  },

  async refreshTimeline() {
    try {
      console.log('[Timeline] ========== 开始刷新时间线 ==========');
      var limit = parseInt(document.getElementById('timelineLimit')?.value || '50', 10);
      console.log('[Timeline] 请求限制:', limit);

      var resp = await API.getTimeline(limit);
      console.log('[Timeline] API响应状态:', resp.success);
      console.log('[Timeline] API响应完整数据:', JSON.stringify(resp, null, 2));

      if (resp.success && Array.isArray(resp.data)) {
        console.log('[Timeline] 收到事件数量:', resp.data.length);
        console.log('[Timeline] 事件详情:');
        resp.data.forEach(function(item, idx) {
          console.log('  [' + idx + ']', {
            time: new Date(item.time).toLocaleString(),
            type: item.type,
            source: item.source,
            data: item.data
          });
        });

        this.timelineData = resp.data;
        this.renderTimeline();
      } else {
        console.warn('[Timeline] 响应格式错误或无数据:', resp);
      }
    } catch(e) {
      console.error('[Timeline] 刷新失败:', e);
      console.error('[Timeline] 错误堆栈:', e.stack);
    }
  },

  renderTimeline() {
    var body = document.getElementById('timelineBody');
    if (!body) return;

    var filter = document.getElementById('timelineFilter')?.value || 'all';
    var filtered = this.timelineData.filter(function(item) {
      if (filter === 'xiaoai') return item.source === 'xiaoai';
      if (filter === 'plugin') return item.source === 'plugin';
      return true;
    });

    if (filtered.length === 0) {
      body.innerHTML = '<div class="timeline-empty">暂无时间线记录</div>';
    } else {
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var item = filtered[i];
        var d = new Date(item.time);
        var timeStr = d.toLocaleString('zh-CN', {hour12: false});

        var typeClass = item.source === 'xiaoai' ? 'xiaoai' : 'plugin';
        var sourceLabel = item.source === 'xiaoai' ? '小爱' : '插件';

        var content = '';
        var meta = '';

        if (item.source === 'xiaoai' && item.data) {
          // 小爱对话 - 压缩格式：时间+来源合并，问答放一行
          var conv = item.data;
          var msg = conv.message;
          var question = '';
          var response = '';

          if (msg && msg.response && msg.response.answer && msg.response.answer[0]) {
            question = msg.response.answer[0].question || '';
            response = msg.response.answer[0].content || '';
          }

          // 第1行：用户提问 (去掉💬)
          content = (question || '(无内容)');
          // 第2行：设备 + 小爱回复（如果有回复内容）
          meta = '<div class="tl-meta">';
          if (conv.device_name) meta += '<span class="tl-meta-item">📱 ' + conv.device_name + '</span>';
          if (response) meta += '<span class="tl-meta-item">' + response + '</span>';
          meta += '</div>';

        } else if (item.source === 'plugin' && item.data) {
          // 插件事件
          var evt = item.data;
          content = evt.action + ': ' + (evt.detail || '');
          meta = '<div class="tl-meta">';
          if (evt.extra && evt.extra.platform) meta += '<span class="tl-meta-item">🎵 ' + evt.extra.platform + '</span>';
          if (evt.extra && evt.extra.keyword) meta += '<span class="tl-meta-item">🔍 "' + evt.extra.keyword + '"</span>';
          if (evt.result) {
            var resultIcon = evt.result === 'success' ? '✅' : (evt.result === 'fail' ? '❌' : '');
            meta += '<span class="tl-meta-item">' + resultIcon + ' ' + evt.result + '</span>';
          }
          meta += '</div>';
        }

        html += '<div class="timeline-item ' + typeClass + '">' +
          '<div class="tl-time">' +
            '<span class="tl-source ' + typeClass + '">' + sourceLabel + '</span> ' +
            timeStr +
          '</div>' +
          '<div class="tl-content">' + content + '</div>' +
          meta +
          '</div>';
      }
      body.innerHTML = html;
    }

    var count = document.getElementById('timelineCount');
    if (count) count.textContent = '共 ' + filtered.length + ' 条';
  },


  // ===== 移动端垂直音量条 (v1.3.3) =====
  toggleMobileVolume() {
    var pop = document.getElementById('mobileVolumePop');
    if (!pop) return;
    if (pop.style.display === 'flex') {
      pop.style.display = 'none';
    } else {
      pop.style.display = 'flex';
      this.updateMobileVolumeUI();
    }
  },
  adjustMobileVolume(e) {
    var slider = document.getElementById('volSliderV');
    if (!slider) return;
    var rect = slider.getBoundingClientRect();
    var clickY = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY);
    if (!clickY) return;
    var pct = Math.round((1 - (clickY - rect.top) / rect.height) * 100);
    pct = Math.max(0, Math.min(100, pct));
    this.setVolume(pct);
  },
  startMobileVolumeDrag(e) {
    e.preventDefault();
    var self = this;
    var slider = document.getElementById('volSliderV');
    if (!slider) return;
    self._mobileDrag = true;

    function onMove(ev) {
      if (!self._mobileDrag) return;
      var rect = slider.getBoundingClientRect();
      var clientY = ev.clientY || (ev.touches && ev.touches[0] && ev.touches[0].clientY);
      if (!clientY) return;
      var pct = Math.round((1 - (clientY - rect.top) / rect.height) * 100);
      pct = Math.max(0, Math.min(100, pct));
      self.setVolume(pct);
    }

    function onUp() {
      self._mobileDrag = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, {passive: false});
    document.addEventListener('touchend', onUp);
  },
  updateMobileVolumeUI() {
    var fillV = document.getElementById('volFillV');
    var labelV = document.getElementById('mobileVolumeLabel');
    var iconV = document.getElementById('mobileVolumeIcon');
    var iconBtn = document.getElementById('mobileVolumeBtn');
    if (fillV) fillV.style.height = this.currentVolume + '%';
    if (labelV) labelV.textContent = this.currentVolume + '%';
    if (iconV) iconV.textContent = this.isMuted ? '🔇' : (this.currentVolume > 50 ? '🔊' : (this.currentVolume > 0 ? '🔉' : '🔈'));
    if (iconBtn) iconBtn.textContent = this.isMuted ? '🔇' : (this.currentVolume > 50 ? '🔊' : (this.currentVolume > 0 ? '🔉' : '🔈'));
  },

  // ===== 移动端更多菜单 (v1.3.7) =====
  toggleMobileMore() {
    var dd = document.getElementById('mobileMoreDropdown');
    if (!dd) return;
    var isOpen = dd.classList.contains('open');
    if (isOpen) {
      dd.classList.remove('open');
    } else {
      dd.classList.add('open');
    }
  },

  // ===== 移动端汉堡菜单 (v1.3.0) =====
  toggleSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    var btn = document.getElementById('hamburgerBtn');
    var isOpen = sidebar.classList.contains('open');
    if (isOpen) {
      this.closeSidebar();
    } else {
      sidebar.classList.add('open');
      overlay.classList.add('active');
      btn.classList.add('open');
    }
  },
  closeSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    var btn = document.getElementById('hamburgerBtn');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    btn.classList.remove('open');
  },

  // ===== Toast =====
  showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._timeout);
    t._timeout = setTimeout(function() { t.style.display = 'none'; }, 3000);
  },

  // ===== 时间线拖动 =====
  initTimelineDrag() {
    var panel = document.getElementById('timelinePanel');
    var header = document.getElementById('timelineHeader');
    if (!panel || !header) return;

    var isDragging = false;
    var startX = 0, startY = 0;
    var initialX = 0, initialY = 0;

    header.style.cursor = 'move';

    function saveGeometry() {
      var geo = {
        left: panel.style.left,
        top: panel.style.top,
        width: panel.style.width,
        height: panel.style.height
      };
      localStorage.setItem('timeline-geometry', JSON.stringify(geo));
    }

    header.addEventListener('mousedown', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;

      var rect = panel.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!isDragging) return;

      var deltaX = e.clientX - startX;
      var deltaY = e.clientY - startY;

      panel.style.left = (initialX + deltaX) + 'px';
      panel.style.top = (initialY + deltaY) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', function() {
      if (isDragging) {
        saveGeometry();
      }
      isDragging = false;
    });
  },

  // ===== 时间线调整大小 =====
  initTimelineResize() {
    var panel = document.getElementById('timelinePanel');
    if (!panel) return;

    // 恢复保存的位置和大小
    var saved = localStorage.getItem('timeline-geometry');
    if (saved) {
      try {
        var geo = JSON.parse(saved);
        if (geo.left) panel.style.left = geo.left;
        if (geo.top) panel.style.top = geo.top;
        if (geo.width) panel.style.width = geo.width;
        if (geo.height) panel.style.height = geo.height;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      } catch (e) {}
    }

    var resizeRight = panel.querySelector('.timeline-resize-right');
    var resizeBottom = panel.querySelector('.timeline-resize-bottom');
    var resizeCorner = panel.querySelector('.timeline-resize-corner');

    var isResizing = false;
    var resizeMode = '';
    var startX = 0, startY = 0;
    var startWidth = 0, startHeight = 0;
    var startLeft = 0;

    function startResize(mode, e) {
      isResizing = true;
      resizeMode = mode;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = panel.offsetWidth;
      startHeight = panel.offsetHeight;

      var rect = panel.getBoundingClientRect();
      startLeft = rect.left;

      // 清除right/bottom，使用left/top定位
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = startLeft + 'px';

      e.preventDefault();
    }

    function saveGeometry() {
      var geo = {
        left: panel.style.left,
        top: panel.style.top,
        width: panel.style.width,
        height: panel.style.height
      };
      localStorage.setItem('timeline-geometry', JSON.stringify(geo));
    }

    if (resizeRight) {
      resizeRight.addEventListener('mousedown', function(e) {
        startResize('right', e);
      });
    }

    if (resizeBottom) {
      resizeBottom.addEventListener('mousedown', function(e) {
        startResize('bottom', e);
      });
    }

    if (resizeCorner) {
      resizeCorner.addEventListener('mousedown', function(e) {
        startResize('corner', e);
      });
    }

    document.addEventListener('mousemove', function(e) {
      if (!isResizing) return;

      var deltaX = e.clientX - startX;
      var deltaY = e.clientY - startY;

      if (resizeMode === 'right' || resizeMode === 'corner') {
        var newWidth = startWidth + deltaX;
        if (newWidth >= 400 && newWidth <= window.innerWidth - 40) {
          panel.style.width = newWidth + 'px';
        }
      }

      if (resizeMode === 'bottom' || resizeMode === 'corner') {
        var newHeight = startHeight + deltaY;
        if (newHeight >= 300 && newHeight <= window.innerHeight - 80) {
          panel.style.height = newHeight + 'px';
        }
      }
    });

    document.addEventListener('mouseup', function() {
      if (isResizing) {
        saveGeometry();
      }
      isResizing = false;
      resizeMode = '';
    });
  },

  // ===== 搜索历史管理 (v1.8.14) =====
  saveSearchHistory(keyword) {
    if (!keyword || keyword.length === 0) return;
    try {
      var history = JSON.parse(localStorage.getItem('lx-search-history') || '[]');
      // 去重：如果已存在，移到最前
      history = history.filter(function(k) { return k !== keyword; });
      history.unshift(keyword);
      // 最多保留20条
      if (history.length > 20) history = history.slice(0, 20);
      localStorage.setItem('lx-search-history', JSON.stringify(history));
      this.renderSearchHistory();
    } catch(e) {
      console.log('[LX] saveSearchHistory error:', e);
    }
  },

  getSearchHistory() {
    try {
      return JSON.parse(localStorage.getItem('lx-search-history') || '[]');
    } catch(e) {
      return [];
    }
  },

  renderSearchHistory() {
    var history = this.getSearchHistory();
    var container = document.getElementById('searchHistory');
    var list = document.getElementById('searchHistoryList');
    if (!container || !list) return;

    // v1.8.18: 仅在无搜索关键词时显示
    var kw = document.getElementById('searchInput');
    if (kw && kw.value.trim()) {
      container.style.display = 'none';
      return;
    }

    if (history.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    list.innerHTML = '';
    for (var i = 0; i < history.length; i++) {
      var keyword = history[i];
      var tag = document.createElement('div');
      tag.className = 'hot-tag';
      tag.innerHTML = keyword + '<span class="remove-btn" onclick="event.stopPropagation();App.removeSearchHistory(\'' + keyword.replace(/'/g, "\\'") + '\')">×</span>';
      tag.onclick = (function(kw) {
        return function() {
          document.getElementById('searchInput').value = kw;
          App.doSearch();
        };
      })(keyword);
      list.appendChild(tag);
    }
  },

  removeSearchHistory(keyword) {
    try {
      var history = this.getSearchHistory();
      history = history.filter(function(k) { return k !== keyword; });
      localStorage.setItem('lx-search-history', JSON.stringify(history));
      this.renderSearchHistory();
    } catch(e) {
      console.log('[LX] removeSearchHistory error:', e);
    }
  },

  clearSearchHistory() {
    if (!confirm('确定清空搜索历史？')) return;
    localStorage.removeItem('lx-search-history');
    this.renderSearchHistory();
    this.showToast('已清空搜索历史', false);
  },

  // ===== 音源优先级排序 (v1.8.22) =====
  renderSourcePriority() {
    var container = document.getElementById('sourcePriorityList');
    if (!container) return;
    var sources = this._sourcePriority || ['kg', 'tx', 'wy', 'mg', 'kw'];
    var labels = { kg: 'KG', tx: 'TX', wy: 'WY', mg: 'MG', kw: 'KW' };

    var html = '';
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      html += '<div class="sp-item" draggable="true" data-source="' + s + '" data-idx="' + i + '">';
      html += '<span class="sp-drag">⠿</span>';
      html += '<span class="sp-label">' + (labels[s] || s) + '</span>';
      html += '<span class="sp-arrows">';
      html += '<button class="sp-arrow" onclick="App.moveSourceUp(' + i + ')" ' + (i === 0 ? 'disabled' : '') + '>▲</button>';
      html += '<button class="sp-arrow" onclick="App.moveSourceDown(' + i + ')" ' + (i === sources.length - 1 ? 'disabled' : '') + '>▼</button>';
      html += '</span></div>';
    }
    container.innerHTML = html;

    // 拖拽排序
    var self = this;
    container.querySelectorAll('.sp-item[draggable]').forEach(function(item) {
      item.addEventListener('dragstart', function(e) {
        e.dataTransfer.setData('text/plain', this.getAttribute('data-idx'));
        this.classList.add('dragging');
      });
      item.addEventListener('dragend', function() { this.classList.remove('dragging'); });
      item.addEventListener('dragover', function(e) { e.preventDefault(); this.classList.add('drag-over'); });
      item.addEventListener('dragleave', function() { this.classList.remove('drag-over'); });
      item.addEventListener('drop', function(e) {
        e.preventDefault(); this.classList.remove('drag-over');
        var fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        var toIdx = parseInt(this.getAttribute('data-idx'), 10);
        self.reorderSource(fromIdx, toIdx);
      });
    });
  },

  moveSourceUp(idx) {
    if (idx <= 0) return;
    var arr = this._sourcePriority.slice();
    var tmp = arr[idx]; arr[idx] = arr[idx - 1]; arr[idx - 1] = tmp;
    this._sourcePriority = arr;
    this.renderSourcePriority();
    this.saveSourcePriority();
  },

  moveSourceDown(idx) {
    if (idx >= this._sourcePriority.length - 1) return;
    var arr = this._sourcePriority.slice();
    var tmp = arr[idx]; arr[idx + 1] = arr[idx]; arr[idx] = tmp;
    this._sourcePriority = arr;
    this.renderSourcePriority();
    this.saveSourcePriority();
  },

  reorderSource(fromIdx, toIdx) {
    var arr = this._sourcePriority.slice();
    var item = arr.splice(fromIdx, 1)[0];
    arr.splice(toIdx, 0, item);
    this._sourcePriority = arr;
    this.renderSourcePriority();
    this.saveSourcePriority();
  },

  async saveSourcePriority() {
    await API.saveConfig({ sourcePriority: this._sourcePriority });
    console.log('[LX] Source priority saved:', this._sourcePriority);
  },

  // ===== 播放队列面板 (v2.6.0) =====
  toggleQueuePanel() {
    if (document.body.classList.toggle('queue-open')) {
      this.renderPlayQueue();
    }
  },

  closeQueuePanel() {
    document.body.classList.remove('queue-open');
  },

  _queuePanelExists() {
    return !!document.getElementById('playQueuePanel');
  },

  _makeQueueState() {
    var items = Array.isArray(this.playQueue) ? this.playQueue : [];
    var index = typeof this.currentQueueIndex === 'number' && this.currentQueueIndex >= 0
      ? this.currentQueueIndex
      : -1;
    return PlayQueueState.create(items, index, this.currentQueueType || '');
  },

  _applyQueueState(next) {
    this.playQueue = next.items;
    this.currentQueueIndex = next.currentIndex;
    this.currentQueueType = next.type;
    this.renderPlayQueue();
  },

  _queueTypeLabel(type) {
    return {
      favorites: '收藏',
      artist: '歌手',
      search: '搜索结果',
      songlist: '歌单',
      leaderboard: '排行榜',
      history: '历史'
    }[type] || '播放列表';
  },

  renderPlayQueue() {
    if (!document.body || !document.body.classList.contains('queue-open')) return;
    if (!this._queuePanelExists()) return;
    var state = this._makeQueueState();
    var typeEl = document.getElementById('queueType');
    if (typeEl) typeEl.textContent = this._queueTypeLabel(state.type);
    this._renderQueueList(state);
    var countEl = document.getElementById('queueUpcomingCount');
    if (countEl) countEl.textContent = state.items.length + ' 首';
    var clearBtn = document.getElementById('queueClearBtn');
    if (clearBtn) clearBtn.disabled = state.currentIndex < 0 || state.currentIndex >= state.items.length - 1;
  },

  _renderQueueList(state) {
    var el = document.getElementById('playQueueList');
    if (!el) return;
    var items = state.items;
    var cur = state.currentIndex;
    var self = this;
    if (!items || items.length === 0) {
      el.innerHTML = '<div class="queue-empty">队列为空</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      html += this._queueRowHtml(items[i], i, i === cur);
    }
    el.innerHTML = html;
  },

  _queueRowHtml(item, index, isCurrent) {
    var title = this._escapeHtml(item.name || item.title || '未知歌曲');
    var artist = this._escapeHtml(item.singer || item.artist || '');
    var coverUrl = item.cover || item.img || '';
    var coverHtml = coverUrl
      ? '<img src="' + this._escapeHtml(coverUrl) + '" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">'
      : '🎵';
    var html = '<div class="queue-item' + (isCurrent ? ' current' : '') + '" data-index="' + index + '"';
    if (!isCurrent) html += ' onclick="App.playQueueItem(' + index + ')"';
    html += '>';
    html += '<div class="queue-item-cover">' + coverHtml + '</div>';
    html += '<div class="queue-item-info"><div class="queue-item-title" title="' + title + '">' + title + '</div>';
    if (artist) html += '<div class="queue-item-artist">' + artist + '</div>';
    html += '</div>';
    if (isCurrent) {
      html += '<span class="queue-playing-icon" title="正在播放">♪</span>';
    } else {
      html += '<div class="queue-item-actions">';
      html += '<button class="qia-btn qia-remove" data-tip="移除" onclick="event.stopPropagation();App.removeQueueItem(' + index + ')">✕</button>';
      html += '<button class="qia-btn qia-drag" data-tip="拖动排序" onpointerdown="App.startQueueDrag(event,' + index + ')" onclick="event.stopPropagation()">⠿</button>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  },

  playQueueItem(index) {
    if (!this.playQueue || index < 0 || index >= this.playQueue.length) return;
    this.currentQueueIndex = index;
    this.playSongFromQueue(index);
    this.renderPlayQueue();
  },

  removeQueueItem(index) {
    if (!this.playQueue || index < 0 || index >= this.playQueue.length || index === this.currentQueueIndex) return;
    var state = this._makeQueueState();
    var next = PlayQueueState.removeAny(state, index);
    if (next === state) return;
    this._applyQueueState(next);
  },

  moveQueueItem(index, direction) {
    if (!this.playQueue || index < 0 || index >= this.playQueue.length || index === this.currentQueueIndex) return;
    var state = this._makeQueueState();
    var next = PlayQueueState.moveAny(state, index, direction);
    if (next === state) return;
    this._applyQueueState(next);
  },

  clearUpcomingQueue() {
    var state = this._makeQueueState();
    var next = PlayQueueState.clearUpcoming(state);
    if (next.items.length === state.items.length) return;
    this._applyQueueState(next);
  },

  startQueueDrag(event, index) {
    var self = this;
    var row = event.currentTarget.closest('.queue-item');
    var list = document.getElementById('playQueueList');
    if (!row || !list) return;
    event.preventDefault();
    row.classList.add('dragging');
    var startY = event.clientY;
    var moved = false;
    var moveHandler = function(ev) {
      ev.preventDefault();
      if (!moved) {
        if (Math.abs(ev.clientY - startY) < 6) return;
        moved = true;
        row.classList.add('drag-active');
      }
      var cursorY = ev.clientY;
      var rows = Array.prototype.slice.call(list.children);
      // 找到指针当前所在的那一行（逐行交换），不含被拖行
      var target = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i] === row) continue;
        var r = rows[i].getBoundingClientRect();
        if (cursorY < r.top + r.height / 2) { target = rows[i]; break; }
      }
      if (target) {
        if (row.nextElementSibling !== target) list.insertBefore(row, target);
      } else if (row !== list.lastElementChild) {
        list.appendChild(row);
      }
    };
    var upHandler = function() {
      document.removeEventListener('pointermove', moveHandler);
      document.removeEventListener('pointerup', upHandler);
      row.classList.remove('dragging', 'drag-active');
      var orderedAbs = Array.prototype.slice.call(list.children).map(function(c) {
        return Number(c.dataset.index);
      });
      if (orderedAbs.length !== self.playQueue.length) {
        self.renderPlayQueue();
        return;
      }
      var newItems = orderedAbs.map(function(abs) { return self.playQueue[abs]; });
      var next = PlayQueueState.create(newItems, self.currentQueueIndex, self.currentQueueType);
      self._applyQueueState(next);
    };
    document.addEventListener('pointermove', moveHandler);
    document.addEventListener('pointerup', upHandler);
  },
};

// ===== 系统主题变化监听 =====
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
  if (!localStorage.getItem('lx-theme')) {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  }
});

// ===== 初始化时间线拖动 =====
document.addEventListener('DOMContentLoaded', function() {
  App.initTimelineDrag();
  App.initTimelineResize();
});

// ===== 启动 =====
document.addEventListener('DOMContentLoaded', function() { App.init(); });
