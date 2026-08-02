// LRC parsing and timeline lookup are isolated so playback UI stays deterministic.
var LyricsModel = {
  parse: function(lrcText) {
    if (typeof lrcText !== 'string' || !lrcText.trim()) return [];
    var lines = [];
    var seen = {};
    lrcText.replace(/\r/g, '').split('\n').forEach(function(rawLine) {
      var tags = rawLine.match(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g) || [];
      if (!tags.length) return;
      var text = rawLine.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g, '').trim();
      if (!text) return;
      tags.forEach(function(tag) {
        var match = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(tag);
        if (!match) return;
        var minute = Number(match[1]);
        var second = Number(match[2]);
        var fraction = match[3] ? Number(match[3]) / Math.pow(10, match[3].length) : 0;
        var time = minute * 60 + second + fraction;
        if (!isFinite(time) || second >= 60) return;
        var key = String(time);
        if (seen[key]) return;
        seen[key] = true;
        lines.push({ time: time, text: text });
      });
    });
    lines.sort(function(a, b) { return a.time - b.time; });
    return lines;
  },
  activeIndex: function(lines, currentSeconds) {
    if (!Array.isArray(lines) || !lines.length || !isFinite(currentSeconds)) return -1;
    var low = 0;
    var high = lines.length - 1;
    var active = -1;
    while (low <= high) {
      var middle = Math.floor((low + high) / 2);
      if (lines[middle].time <= currentSeconds) {
        active = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return active;
  },
  formatTime: function(seconds) {
    var safe = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
  },
  requestForSong: function(song, playbackSource, fallbackSong) {
    var selected = song;
    if (selected && selected.source === 'cache' && fallbackSong && fallbackSong.id) selected = fallbackSong;
    if (!selected || !selected.id) return { id: '', source: '' };
    var request = {
      id: String(selected.id),
      source: String(selected.source || playbackSource || ''),
    };
    var lyricId = String(selected.lyricId || selected.lrc || '');
    if (lyricId) request.lyricId = lyricId;
    var name = String(selected.name || selected.title || '');
    var singer = String(selected.singer || selected.artist || '');
    var interval = selected.interval || selected.duration || '';
    var albumId = String(selected.albumId || '');
    if (name) request.name = name;
    if (singer) request.singer = singer;
    if (interval) request.interval = String(interval);
    if (albumId) request.albumId = albumId;
    if (selected._raw && typeof selected._raw === 'object') request.raw = selected._raw;
    return request;
  },
};
