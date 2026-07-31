(function(root) {
  var ALL_SOURCES = ['kg', 'kw', 'tx', 'wy', 'mg'];
  var SINGER_SOURCES = ['tx', 'wy'];

  function normalizeType(type) {
    return type === 'singer' || type === 'playlist' ? type : 'song';
  }

  function sourcesForType(type) {
    return normalizeType(type) === 'singer' ? SINGER_SOURCES.slice() : ALL_SOURCES.slice();
  }

  function normalizeSource(type, source) {
    var value = String(source || '').trim();
    return value && sourcesForType(type).indexOf(value) !== -1 ? value : '';
  }

  function createState(type, keyword, source) {
    var normalizedType = normalizeType(type);
    var normalizedKeyword = String(keyword || '').trim();
    var normalizedSource = normalizeSource(normalizedType, source);
    return {
      type: normalizedType,
      keyword: normalizedKeyword,
      source: normalizedSource,
      conditionId: normalizedType + '|' + normalizedKeyword + '|' + normalizedSource,
      items: [],
      sourceTotals: {},
      sourceHasMore: {},
      sourcePages: {},
      failedSources: [],
      upstreamPage: 0,
    };
  }

  function resetState(_state, type, keyword, source) {
    return createState(type, keyword, source);
  }

  function mergeBatch(state, batch) {
    if (!state || !batch) return state;
    var seen = {};
    for (var i = 0; i < state.items.length; i++) {
      seen[state.items[i].source + ':' + state.items[i].id] = true;
    }
    var incoming = Array.isArray(batch.items) ? batch.items : [];
    for (var j = 0; j < incoming.length; j++) {
      var item = incoming[j];
      var key = item.source + ':' + item.id;
      if (!seen[key]) {
        seen[key] = true;
        state.items.push(item);
      }
    }

    var totals = batch.sourceTotals || {};
    Object.keys(totals).forEach(function(source) {
      state.sourceTotals[source] = Number(totals[source]) || 0;
    });
    var hasMore = batch.sourceHasMore || {};
    Object.keys(hasMore).forEach(function(source) {
      state.sourceHasMore[source] = !!hasMore[source];
      state.sourcePages[source] = Math.max(
        state.sourcePages[source] || 0,
        Number(batch.upstreamPage) || 0
      );
    });
    state.failedSources = Array.isArray(batch.failedSources) ? batch.failedSources.slice() : [];
    state.upstreamPage = Math.max(state.upstreamPage || 0, Number(batch.upstreamPage) || 0);
    return state;
  }

  function paginationTotal(state) {
    if (!state) return 0;
    var total = 0;
    Object.keys(state.sourceTotals || {}).forEach(function(source) {
      total += Number(state.sourceTotals[source]) || 0;
    });
    return Math.max(total, Array.isArray(state.items) ? state.items.length : 0);
  }

  function resolveSongCover(song) {
    var roots = [song, song && song.meta, song && song._raw];
    var fields = ['cover', 'img', 'picUrl'];
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      var rootValue = roots[rootIndex];
      if (!rootValue || typeof rootValue !== 'object') continue;
      for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
        var value = rootValue[fields[fieldIndex]];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
      }
    }
    return '';
  }

  root.EntitySearchModel = {
    normalizeType: normalizeType,
    sourcesForType: sourcesForType,
    createState: createState,
    resetState: resetState,
    mergeBatch: mergeBatch,
    paginationTotal: paginationTotal,
    resolveSongCover: resolveSongCover,
  };
})(typeof window !== 'undefined' ? window : globalThis);
