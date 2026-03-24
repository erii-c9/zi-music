const KEYS = {
  playerVolume: "player.volume",
  playbackMode: "player.playbackMode",
  playbackRate: "player.playbackRate",
  searchHistory: "search.history",
  favoriteGroups: "favorites.groups",
  recentPlays: "recent.plays",
  theme: "ui.theme",
  fontSize: "ui.fontSize",
  backgroundImage: "ui.backgroundImage"
};

const DEFAULTS = {
  playerVolume: 0.8,
  playbackMode: "pause",
  playbackRate: 1,
  searchHistory: [],
  favoriteGroups: [],
  recentPlays: [],
  theme: "frost",
  fontSize: 14,
  backgroundImage: ""
};

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function getStoredVolume() {
  const value = Number(readJson(KEYS.playerVolume, DEFAULTS.playerVolume));
  if (!Number.isFinite(value)) return DEFAULTS.playerVolume;
  return Math.min(1, Math.max(0, value));
}

export function setStoredVolume(value) {
  writeJson(KEYS.playerVolume, Math.min(1, Math.max(0, value)));
}

export function getStoredPlaybackMode() {
  const value = readJson(KEYS.playbackMode, DEFAULTS.playbackMode);
  return ["pause", "repeat-one", "sequence"].includes(value) ? value : "pause";
}

export function setStoredPlaybackMode(value) {
  writeJson(KEYS.playbackMode, ["pause", "repeat-one", "sequence"].includes(value) ? value : "pause");
}

export function getStoredPlaybackRate() {
  const value = Number(readJson(KEYS.playbackRate, DEFAULTS.playbackRate));
  if (!Number.isFinite(value)) return DEFAULTS.playbackRate;
  return Math.min(3, Math.max(0.5, Math.round(value * 10) / 10));
}

export function setStoredPlaybackRate(value) {
  const safe = Math.min(3, Math.max(0.5, Math.round(Number(value) * 10) / 10));
  writeJson(KEYS.playbackRate, safe);
}

export function getSearchHistory() {
  const value = readJson(KEYS.searchHistory, DEFAULTS.searchHistory);
  return Array.isArray(value) ? value.filter(Boolean).slice(0, 10) : [];
}

export function addSearchHistoryItem(query) {
  const trimmed = query.trim();
  if (!trimmed) return getSearchHistory();

  const next = [trimmed, ...getSearchHistory().filter((item) => item !== trimmed)].slice(0, 10);
  writeJson(KEYS.searchHistory, next);
  return next;
}

export function clearSearchHistory() {
  writeJson(KEYS.searchHistory, []);
  return [];
}

export function removeSearchHistoryItem(query) {
  const next = getSearchHistory().filter((item) => item !== query);
  writeJson(KEYS.searchHistory, next);
  return next;
}

export function getFavoriteGroups() {
  const value = readJson(KEYS.favoriteGroups, DEFAULTS.favoriteGroups);
  return Array.isArray(value) ? value : [];
}

export function setFavoriteGroups(groups) {
  writeJson(KEYS.favoriteGroups, Array.isArray(groups) ? groups : []);
}

export function getRecentPlays() {
  const value = readJson(KEYS.recentPlays, DEFAULTS.recentPlays);
  return Array.isArray(value) ? value.slice(0, 50) : [];
}

export function addRecentPlayItem(item) {
  const current = getRecentPlays().filter((entry) => entry.bvid !== item.bvid);
  const next = [item, ...current].slice(0, 50);
  writeJson(KEYS.recentPlays, next);
  return next;
}

export function getStoredTheme() {
  const value = readJson(KEYS.theme, DEFAULTS.theme);
  return ["frost", "graphite", "sunset"].includes(value) ? value : DEFAULTS.theme;
}

export function setStoredTheme(value) {
  writeJson(KEYS.theme, ["frost", "graphite", "sunset"].includes(value) ? value : DEFAULTS.theme);
}

export function getStoredFontSize() {
  const value = Number(readJson(KEYS.fontSize, DEFAULTS.fontSize));
  if (!Number.isFinite(value)) return DEFAULTS.fontSize;
  return Math.min(18, Math.max(12, Math.round(value)));
}

export function setStoredFontSize(value) {
  writeJson(KEYS.fontSize, Math.min(18, Math.max(12, Math.round(Number(value)))));
}

export function getStoredBackgroundImage() {
  const value = readJson(KEYS.backgroundImage, DEFAULTS.backgroundImage);
  return typeof value === "string" ? value : DEFAULTS.backgroundImage;
}

export function setStoredBackgroundImage(value) {
  writeJson(KEYS.backgroundImage, typeof value === "string" ? value : DEFAULTS.backgroundImage);
}
