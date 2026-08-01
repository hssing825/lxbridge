(function (root) {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function copyItems(items) {
    return Array.isArray(items) ? items.slice() : [];
  }

  function isUpcomingIndex(state, index) {
    return index > state.currentIndex && index < state.items.length;
  }

  function isRemovable(state, index) {
    return index >= 0 && index < state.items.length && index !== state.currentIndex;
  }

  function isMovable(state, index) {
    if (index < 0 || index >= state.items.length || index === state.currentIndex) return false;
    return true;
  }

  function makeChange(state, items, explicitCurrentIndex) {
    var cur = explicitCurrentIndex !== undefined ? explicitCurrentIndex : state.currentIndex;
    if (items.length === 0) cur = -1;
    else if (cur < 0) cur = 0;
    else if (cur >= items.length) cur = items.length - 1;
    return {
      items: items,
      currentIndex: cur,
      type: state.type,
    };
  }

  const PlayQueueState = {
    create(items, currentIndex, type) {
      const list = copyItems(items);
      const normalized = list.length > 0 ? clamp(currentIndex, 0, list.length - 1) : -1;
      return { items: list, currentIndex: normalized, type: type || '' };
    },

    getView(state) {
      if (!state || state.currentIndex < 0 || state.currentIndex >= state.items.length) {
        return { current: null, upcoming: [] };
      }
      return {
        current: state.items[state.currentIndex],
        upcoming: state.items.slice(state.currentIndex + 1),
      };
    },

    activate(state, index) {
      if (index < 0 || index >= state.items.length || index <= state.currentIndex) {
        return state;
      }
      return { items: state.items, currentIndex: index, type: state.type };
    },

    removeAny(state, index) {
      if (!isRemovable(state, index)) {
        return state;
      }
      const items = state.items.slice();
      items.splice(index, 1);
      let cur = state.currentIndex;
      if (index < state.currentIndex) cur -= 1;
      const change = makeChange(state, items, cur);
      return change;
    },

    removeUpcoming(state, index) {
      if (!isUpcomingIndex(state, index)) {
        return state;
      }
      return PlayQueueState.removeAny(state, index);
    },

    moveAny(state, index, direction) {
      if (!isMovable(state, index) || (direction !== 1 && direction !== -1)) {
        return state;
      }
      const to = index + direction;
      if (to < 0 || to >= state.items.length) {
        return state;
      }
      const items = state.items.slice();
      const item = items.splice(index, 1)[0];
      items.splice(to, 0, item);
      // 当前歌曲索引跟随移动
      let cur = state.currentIndex;
      if (index === cur - direction) {
        // 被移歌曲紧邻当前歌曲时，当前索引随之偏移
        cur += direction;
      } else if (direction > 0 && index < state.currentIndex && to >= state.currentIndex) {
        // 向下跨越当前歌曲
        cur -= 1;
      } else if (direction < 0 && index > state.currentIndex && to <= state.currentIndex) {
        // 向上跨越当前歌曲
        cur += 1;
      }
      return makeChange(state, items, cur);
    },

    moveUpcoming(state, index, direction) {
      if (!isUpcomingIndex(state, index) || (direction !== 1 && direction !== -1)) {
        return state;
      }
      if (!isUpcomingIndex(state, index + direction)) {
        return state;
      }
      return PlayQueueState.moveAny(state, index, direction);
    },

    reorderUpcoming(state, from, to) {
      if (!isUpcomingIndex(state, from) || !isUpcomingIndex(state, to) || from === to) {
        return state;
      }
      const items = state.items.slice();
      const item = items.splice(from, 1)[0];
      items.splice(to, 0, item);
      return makeChange(state, items);
    },

    clearUpcoming(state) {
      if (state.currentIndex < 0) {
        return { items: [], currentIndex: -1, type: state.type };
      }
      return {
        items: state.items.slice(0, state.currentIndex + 1),
        currentIndex: state.currentIndex,
        type: state.type,
      };
    },
  };

  root.PlayQueueState = PlayQueueState;
})(typeof globalThis !== 'undefined' ? globalThis : this);
