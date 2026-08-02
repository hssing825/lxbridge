// Songloft-LX API — 完全对齐 songloft common.js 的认证方式
// 参考: /api/v1/jsplugin-assets/common.js (songloft 自动注入)
var ConfigSyncPolicy = {
  hasConnectionIdentity: function(config) {
    if (!config || typeof config !== 'object') return false;
    return typeof config.host === 'string' && config.host.trim().length > 0 &&
      typeof config.username === 'string' && config.username.trim().length > 0;
  },

  shouldRestore: function(backendResponse, localConfig) {
    if (!backendResponse || backendResponse.success !== true || !backendResponse.data) {
      return false;
    }
    return !this.hasConnectionIdentity(backendResponse.data) &&
      this.hasConnectionIdentity(localConfig);
  },

  resolveLocalPassword: function(previousConfig, nextIdentity, enteredPassword) {
    if (typeof enteredPassword === 'string' && enteredPassword.length > 0) {
      return enteredPassword;
    }
    if (!this.hasConnectionIdentity(previousConfig) || !this.hasConnectionIdentity(nextIdentity)) {
      return '';
    }
    var sameIdentity = previousConfig.host.trim() === nextIdentity.host.trim() &&
      previousConfig.username.trim() === nextIdentity.username.trim();
    return sameIdentity && typeof previousConfig.password === 'string'
      ? previousConfig.password
      : '';
  },
};

var API = {
  basePath: '.',
  token: '',

  init: function() {
    // 从 <base> 标签读取基础URL（songloft注入，带尾斜杠，fet fetch() 不用它但我们可以手动读）
    var baseEl = document.querySelector('base');
    if (baseEl && baseEl.href) {
      // baseEl.href 是绝对URL如 "http://your-songloft-host:58091/api/v1/jsplugin/lxbridge/"
      // 提取路径部分
      var a = document.createElement('a');
      a.href = baseEl.href;
      this.basePath = a.pathname; // "/api/v1/jsplugin/lxbridge/"
    }
    // 确保以 / 结尾
    if (this.basePath.charAt(this.basePath.length - 1) !== '/') {
      this.basePath += '/';
    }

    // 从 localStorage 读取 token（和 common.js 完全一致）
    try {
      var authData = localStorage.getItem('songloft-auth');
      if (authData) {
        var auth = JSON.parse(authData);
        this.token = auth.accessToken || '';
      }
    } catch(e) {}

    console.log('[LX] basePath:', this.basePath, 'token:', this.token ? '✓' : '✗');
  },

  buildHeaders: function() {
    var headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = 'Bearer ' + this.token;
    }
    return headers;
  },

  stringifyBodyForLog: function(body) {
    try {
      return JSON.stringify(body, function(key, value) {
        return /password|token|secret|authorization|credential/i.test(key) ? '***' : value;
      }).substring(0, 100);
    } catch (e) {
      return '[无法序列化请求体]';
    }
  },

  async request(method, path, body) {
    var cleanPath = path.startsWith('/') ? path.substring(1) : path;
    var url = this.basePath + cleanPath;
    // 仅记录非status轮询的请求，减少console噪音
    if (path.indexOf('/api/player/status') === -1) {
      console.log('[API]', method, path, body ? 'body=' + this.stringifyBodyForLog(body) : '');
    }

    var opts = { method: method, headers: this.buildHeaders(), credentials: 'include' };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    try {
      var resp = await fetch(url, opts);
      var respText = await resp.text();
      // 仅记录非status轮询的响应，减少console噪音
      if (path.indexOf('/api/player/status') === -1) {
        console.log('[API] response:', path, 'status=' + resp.status);
      }
      if (!resp.ok) {
        var msg = resp.statusText || ('HTTP ' + resp.status);
        try {
          var j = JSON.parse(respText);
          if (j && (j.message || j.error)) { msg = j.message || j.error; }
        } catch(e) {}
        return { success: false, error: msg, httpStatus: resp.status };
      }
      if (!respText) return { success: true, data: null };
      try { return JSON.parse(respText); }
      catch(e) { return { success: false, error: '响应解析失败: ' + respText.substring(0, 100) }; }
    } catch (e) {
      return { success: false, error: e.message || '网络错误' };
    }
  },

  getConfig:        function() { return this.request('GET', '/api/config'); },
  saveConfig:       function(c) { return this.request('POST', '/api/config', c); },
  testConnection:   function() { return this.request('POST', '/api/config/test'); },
  searchWeb:        function(k, s, limit) { return this.request('GET', '/api/search/web?keyword=' + encodeURIComponent(k) + (s ? '&sources=' + s.join(',') : '') + (limit ? '&limit=' + limit : '')); },
  searchEntities:   function(t, k, s, page, limit) { return this.request('GET', '/api/search/entities?type=' + encodeURIComponent(t) + '&keyword=' + encodeURIComponent(k) + (s && s.length ? '&sources=' + encodeURIComponent(s.join(',')) : '') + '&page=' + (page || 1) + '&limit=' + (limit || 20)); },
  getArtistDetail:  function(src, id, name, cover) { return this.request('GET', '/api/artist/detail?source=' + encodeURIComponent(src) + '&id=' + encodeURIComponent(id) + (name ? '&name=' + encodeURIComponent(name) : '') + (cover ? '&cover=' + encodeURIComponent(cover) : '')); },
  getArtistSongs:   function(src, id) { return this.request('GET', '/api/artist/songs?source=' + encodeURIComponent(src) + '&id=' + encodeURIComponent(id)); },
  getArtistAlbums:  function(src, id) { return this.request('GET', '/api/artist/albums?source=' + encodeURIComponent(src) + '&id=' + encodeURIComponent(id)); },
  getAlbumSongs:    function(src, id) { return this.request('GET', '/api/album/songs?source=' + encodeURIComponent(src) + '&id=' + encodeURIComponent(id)); },
  getLyric:         function(song) { return this.request('POST', '/api/song/lyric', { song: song || null }); },
  getSongUrl:       function(id, src, q, info) { return this.request('POST', '/api/song/url', { songId: id, source: src, quality: q, name: info?.name, singer: info?.singer, album: info?.album, duration: info?.duration, cover: info?.cover, _raw: info?._raw }); },
  getSongUrlWithFallback: function(name, singer, album, source, songId, preferredSource) { return this.request('POST', '/api/song/url-with-fallback', { name: name, singer: singer, album: album, source: source, songId: songId, preferredSource: preferredSource }); },
  getFavorites:     function() { return this.request('GET', '/api/favorites'); },
  getHistory:       function(limit) { return this.request('GET', '/api/history?limit=' + (limit || 500)); },
  addHistory:       function(item) { return this.request('POST', '/api/history/add', item); },
  clearHistory:     function() { return this.request('POST', '/api/history/clear'); },
  // MIoT 相关 — 直接调 MIoT HTTP API（用插件token认证）
  _miotRequest: function(method, path, body) {
    // MIoT 路由不带 /api 前缀（如 /config, /mina/devices）
    var url = '/api/v1/jsplugin/miot' + path;
    console.log('[LX] MIoT fetch:', url);
    var headers = this.buildHeaders();
    var opts = { method: method, headers: headers, credentials: 'include' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function(r) {
      console.log('[LX] MIoT response:', r.status, r.statusText);
      return r.text().then(function(t) {
        if (!r.ok) return { success: false, httpStatus: r.status, error: 'MIoT HTTP ' + r.status + ': ' + t.substring(0, 100) };
        if (!t) return { success: true, data: null };
        try { var j = JSON.parse(t); return j.success !== false ? j : { success: true, data: j }; }
        catch(e) { return { success: true, data: { raw: t } }; }
      });
    }).catch(function(e) {
      console.error('[LX] MIoT fetch error:', e.message);
      return { success: false, error: e.message };
    });
  },
  getMIoTStatus:    function() { return this._miotRequest('GET', '/config'); },
  getDevices:       function() { return this._miotRequest('GET', '/mina/devices'); },
  selectDevice:     function(aid, did) { return this.request('POST', '/api/device/select', { account_id: aid, device_id: did }); },
  controlPlayback:  function(action, params) {
    // 调用后端 API，由后端通过 PlayerController 控制设备
    return this.request('POST', '/api/player/control', Object.assign({ action: action }, params || {}));
  },
  getPlayerStatus:  function() { return this.request('GET', '/api/player/status'); },
  playSong:         function(url, title, artist, accountId, deviceId) {
    // 调用我们自己的后端 API，而不是直接调用 MIoT
    // 后端会通过 PlayerController → MIoTBridge 正确调用 MIoT
    return this.request('POST', '/api/player/play', {
      url: url,
      title: title,
      artist: artist,
      account_id: accountId,
      device_id: deviceId
    });
  },
  configureMIoT:    function() { return this.request('POST', '/api/miot/configure'); },
  getFallbackLogs:  function(limit) { return this.request('GET', '/api/fallback-logs?limit=' + (limit || 20)); },
  getWebPlayerUrl:  function() { return this.request('GET', '/api/webplayer-url'); },
  registerProxyUrl: function(originalUrl, song) { return this.request('POST', '/api/proxy/register', { url: originalUrl, song: song || {} }); },
  getTheme:         function() { return this.request('GET', '/api/theme'); },
  saveTheme:        function(t) { return this.request('POST', '/api/theme', { theme: t }); },
  // 智能缓存
  cacheDownload:    function(params) { return this.request('POST', '/api/cache/download', params); },
  // 缓存查询 (v1.8.22)
  cacheCheck:       function(name, singer) { return this.request('GET', '/api/cache/check?name=' + encodeURIComponent(name) + '&singer=' + encodeURIComponent(singer || '')); },
  // 音频URL验证测试 (v1.9.0-test)
  verifyAudio:      function(url, keyword, quality) { return this.request('GET', '/api/test/verify-audio' + (url ? '?url=' + encodeURIComponent(url) : '?keyword=' + encodeURIComponent(keyword || '周杰伦 晴天')) + '&quality=' + (quality || '320k')); },
  // 受控降级策略模拟（不访问 lxserver）
  simulateFallback: function(scenario) { return this.request('POST', '/api/test/fallback-simulation', { scenario: scenario }); },
  // 语音交互日志 (v1.0.86)
  getVoiceLogs:     function() { return this.request('GET', '/api/logs/voice'); },
  // 播放追踪日志 (v1.0.93)
  getPlaybackLogs:  function() { return this.request('GET', '/api/logs/playback'); },
  // 搜索联想+热搜 (v1.5.1)
  searchSuggest:    function(k) { return this.request('GET', '/api/search/suggest?keyword=' + encodeURIComponent(k)); },
  getHotSearch:     function(s) { return this.request('GET', '/api/search/hot' + (s ? '?source=' + s : '')); },
  // 歌单+榜单 (v1.6.0) - 需要source参数
  getSongListTags:  function(s) { return this.request('GET', '/api/songlist/tags?source=' + (s||'wy')); },
  getSongLists:     function(s,t,p,limit) { return this.request('GET', '/api/songlist/list?source=' + (s||'wy') + '&tagId=' + encodeURIComponent(t) + (p ? '&page=' + p : '') + (limit ? '&limit=' + limit : '')); },
  getSongListDetail:function(s,i) { return this.request('GET', '/api/songlist/detail?source=' + encodeURIComponent(s||'wy') + '&id=' + encodeURIComponent(i)); },
  getLeaderBoards:  function(s) { return this.request('GET', '/api/leaderboard/boards?source=' + (s||'kg')); },
  getLeaderList:    function(s,i) { return this.request('GET', '/api/leaderboard/list?source=' + (s||'kg') + '&bangid=' + i); },
  // 歌单 (v1.5.0)
  getPlaylists:     function() { return this.request('GET', '/api/playlists'); },
  // 小爱对话记录
  getConversations: function(limit) { return this.request('GET', '/api/conversations?limit=' + (limit || 50)); },
  // 时间线视图 (v1.0.94)
  getTimeline:      function(limit, startTime) {
    var url = '/api/timeline?limit=' + (limit || 50);
    if (startTime) url += '&startTime=' + startTime;
    return this.request('GET', url);
  },
  // 自定义源管理 (v2.1.0)
  getCustomSources:    function() { return this.request('GET', '/api/custom-sources'); },
  toggleCustomSource:  function(id, enabled) { return this.request('POST', '/api/custom-sources/toggle', { id: id, enabled: enabled }); },
  reorderCustomSources: function(ids) { return this.request('POST', '/api/custom-sources/reorder', { ids: ids }); },
  getCustomSourceStats: function() { return this.request('GET', '/api/custom-source-stats'); },
  resetCustomSourceStats: function() { return this.request('POST', '/api/custom-source-stats/reset'); },
  // 系统诊断中心 (v2.6.0)
  getDiagnosticsOverview: function() { return this.request('GET', '/api/diagnostics/overview'); },
  getDiagnosticsReport:  function() { return this.request('GET', '/api/diagnostics/report'); },
};
