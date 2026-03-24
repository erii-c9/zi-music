import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  addRecentPlayItem,
  addSearchHistoryItem,
  clearSearchHistory,
  getFavoriteGroups,
  getRecentPlays,
  getSearchHistory,
  getStoredBackgroundImage,
  getStoredFontSize,
  getStoredPlaybackMode,
  getStoredPlaybackRate,
  getStoredTheme,
  getStoredVolume,
  removeSearchHistoryItem,
  setFavoriteGroups,
  setStoredBackgroundImage,
  setStoredFontSize,
  setStoredPlaybackMode,
  setStoredPlaybackRate,
  setStoredTheme,
  setStoredVolume
} from "./storage";

function resolveApiBase() {
  const { hostname, port, protocol } = window.location;
  if ((hostname === "127.0.0.1" || hostname === "localhost") && port === "5173" && (protocol === "http:" || protocol === "https:")) {
    return "";
  }
  return "http://127.0.0.1:3001";
}

const API_BASE = resolveApiBase();
const DEFAULT_SEARCH = "周杰伦 稻香";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatTime(totalSeconds = 0) {
  const safe = Number.isFinite(totalSeconds) ? totalSeconds : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function createGroup(name) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, tracks: [], createdAt: now, updatedAt: now };
}

function createStoredTrack(item) {
  return {
    bvid: item.bvid,
    mid: item.mid || 0,
    title: item.title,
    uploader: item.uploader,
    duration: item.duration,
    durationSeconds: item.durationSeconds,
    playCount: item.playCount,
    publishDate: item.publishDate || "",
    savedAt: new Date().toISOString()
  };
}

function createRecentPlay(item) {
  return {
    bvid: item.bvid,
    mid: item.mid || 0,
    title: item.title,
    uploader: item.uploader,
    duration: item.duration,
    durationSeconds: item.durationSeconds,
    playCount: item.playCount,
    publishDate: item.publishDate || "",
    playedAt: new Date().toISOString()
  };
}

function insertQueueNext(items, item, currentIndex) {
  const base = items.filter((entry) => entry.bvid !== item.bvid);
  const insertAt = currentIndex >= 0 ? currentIndex + 1 : base.length;
  base.splice(insertAt, 0, item);
  return base;
}

function reorderItems(items, fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function ResultCard({ item, onPlay, onQueueNext, onFavorite, onOpenUploader }) {
  return (
    <article className="result-card">
      <button type="button" className="card-play-zone" onClick={onPlay}>
        <div className="card-topline">
          <span className="card-duration">{item.duration}</span>
          {item.publishDate ? <span className="card-pubdate">{item.publishDate}</span> : null}
          <span className="card-playcount">播放 {formatNumber(item.playCount)}</span>
        </div>
        <h3>{item.title}</h3>
        <p>
          <button
            type="button"
            className="uploader-link"
            onClick={(event) => {
              event.stopPropagation();
              onOpenUploader();
            }}
          >
            {item.uploader}
          </button>
        </p>
      </button>
      <div className="card-actions multi">
        <button type="button" className="ghost-button" onClick={onQueueNext}>
          下一个播放
        </button>
        <button type="button" className="ghost-button" onClick={onFavorite}>
          收藏
        </button>
      </div>
    </article>
  );
}

function PlayerIcon({ children, className = "" }) {
  return (
    <svg className={`player-icon ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function PreviousIcon() {
  return (
    <PlayerIcon>
      <path d="M6.5 5v14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M17.5 6.5 10 12l7.5 5.5V6.5Z" fill="currentColor" />
    </PlayerIcon>
  );
}

function NextIcon() {
  return (
    <PlayerIcon>
      <path d="M17.5 5v14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.5 6.5 14 12l-7.5 5.5V6.5Z" fill="currentColor" />
    </PlayerIcon>
  );
}

function PlayIcon() {
  return (
    <PlayerIcon>
      <path d="M8.5 6.8v10.4c0 .7.8 1.1 1.4.7l8.1-5.2a.8.8 0 0 0 0-1.4L9.9 6.1c-.6-.4-1.4 0-1.4.7Z" fill="currentColor" />
    </PlayerIcon>
  );
}

function PauseIcon() {
  return (
    <PlayerIcon>
      <rect x="7" y="6.5" width="3.2" height="11" rx="1.2" fill="currentColor" />
      <rect x="13.8" y="6.5" width="3.2" height="11" rx="1.2" fill="currentColor" />
    </PlayerIcon>
  );
}

function QueueIcon() {
  return (
    <PlayerIcon>
      <path d="M6 8h12M6 12h12M6 16h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </PlayerIcon>
  );
}

function StopAfterIcon() {
  return (
    <PlayerIcon>
      <rect x="7.2" y="7.2" width="9.6" height="9.6" rx="1.8" fill="currentColor" />
    </PlayerIcon>
  );
}

function SequenceIcon() {
  return (
    <PlayerIcon>
      <path d="M6 8h9m0 0-2.2-2.2M15 8l-2.2 2.2M6 16h9m0 0-2.2-2.2M15 16l-2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </PlayerIcon>
  );
}

function RepeatOneIcon() {
  return (
    <PlayerIcon>
      <path d="M7.2 8.2V6.8H17m0 0-1.8-1.8M17 6.8 15.2 8.6M16.8 15.8v1.4H7m0 0 1.8 1.8M7 17.2l1.8-1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.8 9.8h1v4.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12.3" cy="9.3" r=".9" fill="currentColor" />
    </PlayerIcon>
  );
}

function SpeedIcon() {
  return (
    <PlayerIcon>
      <path d="M6.5 16.5 17.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="8.2" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="15.8" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </PlayerIcon>
  );
}

function VolumeIcon() {
  return (
    <PlayerIcon>
      <path d="M6.5 10.2h2.8l3.6-3v9.6l-3.6-3H6.5Z" fill="currentColor" />
      <path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.4 7.2a6.7 6.7 0 0 1 0 9.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </PlayerIcon>
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function VerticalSlider({ min, max, step, value, onChange, ariaLabel }) {
  const trackRef = useRef(null);

  function updateValue(clientY) {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = clamp((rect.bottom - clientY) / rect.height, 0, 1);
    const raw = min + ratio * (max - min);
    const stepped = Math.round(raw / step) * step;
    const next = clamp(Number(stepped.toFixed(4)), min, max);
    onChange(next);
  }

  function handlePointerDown(event) {
    event.preventDefault();
    updateValue(event.clientY);

    function handlePointerMove(moveEvent) {
      updateValue(moveEvent.clientY);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  const percent = ((value - min) / (max - min)) * 100;

  return (
    <div
      ref={trackRef}
      className="vertical-slider-custom"
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const delta = event.key === "ArrowUp" || event.key === "ArrowRight" ? step : -step;
        onChange(clamp(Number((value + delta).toFixed(4)), min, max));
      }}
    >
      <div className="vertical-slider-rail" />
      <div className="vertical-slider-fill" style={{ height: `${percent}%` }} />
      <div className="vertical-slider-thumb" style={{ bottom: `calc(${percent}% - 11px)` }} />
    </div>
  );
}

export default function App() {
  const audioRef = useRef(null);
  const historyRef = useRef(null);
  const playerToolsRef = useRef(null);
  const playRequestRef = useRef(0);
  const dragIndexRef = useRef(-1);

  const [activeTab, setActiveTab] = useState("search");
  const [keyword, setKeyword] = useState(DEFAULT_SEARCH);
  const [results, setResults] = useState([]);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [historyVisible, setHistoryVisible] = useState(false);
  const [searchHistory, setSearchHistory] = useState(getSearchHistory);
  const [upView, setUpView] = useState({ mid: null, uploader: "", items: [], page: 1, hasMore: false, loading: false, error: "" });
  const [favoriteGroups, setFavoriteGroupsState] = useState(getFavoriteGroups);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [favoriteMessage, setFavoriteMessage] = useState("");
  const [favoritePicker, setFavoritePicker] = useState(null);
  const [recentPlays, setRecentPlays] = useState(getRecentPlays);
  const [recentQuery, setRecentQuery] = useState("");
  const [authState, setAuthState] = useState({
    loading: true,
    loggedIn: false,
    user: null,
    qrUrl: "",
    qrKey: "",
    qrImage: "",
    status: "",
    busy: false,
    error: ""
  });
  const [queueItems, setQueueItems] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueVisible, setQueueVisible] = useState(false);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(getStoredVolume);
  const [playbackMode, setPlaybackMode] = useState(getStoredPlaybackMode);
  const [playbackRate, setPlaybackRate] = useState(getStoredPlaybackRate);
  const [theme, setTheme] = useState(getStoredTheme);
  const [fontSize, setFontSize] = useState(getStoredFontSize);
  const [backgroundImage, setBackgroundImage] = useState(getStoredBackgroundImage);
  const [playerError, setPlayerError] = useState("");
  const [activePlayerTool, setActivePlayerTool] = useState("");

  const selectedGroup = favoriteGroups.find((group) => group.id === selectedGroupId) || favoriteGroups[0] || null;
  const recentFiltered = useMemo(() => {
    const query = recentQuery.trim().toLowerCase();
    if (!query) return recentPlays;
    return recentPlays.filter((item) => `${item.title} ${item.uploader}`.toLowerCase().includes(query));
  }, [recentPlays, recentQuery]);
  const timelineMax = duration || currentTrack?.durationSeconds || 0;
  const timelineValue = Math.min(currentTime, timelineMax);
  const timelineProgress = timelineMax > 0 ? `${(timelineValue / timelineMax) * 100}%` : "0%";

  useEffect(() => {
    if (!selectedGroupId && favoriteGroups[0]) setSelectedGroupId(favoriteGroups[0].id);
  }, [favoriteGroups, selectedGroupId]);
  useEffect(() => setStoredVolume(volume), [volume]);
  useEffect(() => setStoredPlaybackMode(playbackMode), [playbackMode]);
  useEffect(() => setStoredPlaybackRate(playbackRate), [playbackRate]);
  useEffect(() => setStoredTheme(theme), [theme]);
  useEffect(() => setStoredFontSize(fontSize), [fontSize]);
  useEffect(() => setStoredBackgroundImage(backgroundImage), [backgroundImage]);
  useEffect(() => setFavoriteGroups(favoriteGroups), [favoriteGroups]);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font-size", `${fontSize}px`);
  }, [fontSize]);
  useEffect(() => {
    function handleClickOutside(event) {
      if (historyRef.current && !historyRef.current.contains(event.target)) setHistoryVisible(false);
      if (playerToolsRef.current && !playerToolsRef.current.contains(event.target)) setActivePlayerTool("");
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  useEffect(() => {
    void refreshAuthStatus();
  }, []);
  useEffect(() => {
    if (!authState.qrKey || authState.loggedIn) return undefined;
    const timer = window.setInterval(() => {
      void pollQrStatus(authState.qrKey);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [authState.qrKey, authState.loggedIn]);

  function resetPlaybackPosition() {
    setCurrentTime(0);
    setDuration(0);
  }

  async function refreshAuthStatus() {
    try {
      const response = await fetch(apiUrl("/api/auth/status"));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "读取登录状态失败");
      setAuthState((current) => ({
        ...current,
        loading: false,
        loggedIn: Boolean(payload?.loggedIn),
        user: payload?.user || null,
        error: ""
      }));
    } catch (error) {
      setAuthState((current) => ({ ...current, loading: false, error: error.message || "读取登录状态失败" }));
    }
  }

  async function beginAuthFlow() {
    setAuthState((current) => ({ ...current, busy: true, error: "", status: "正在生成二维码..." }));
    try {
      const response = await fetch(apiUrl("/api/auth/qr/generate"));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "生成二维码失败");
      const qrImage = await QRCode.toDataURL(payload.qrUrl, { width: 240, margin: 1 });
      setAuthState((current) => ({
        ...current,
        busy: false,
        qrUrl: payload.qrUrl,
        qrKey: payload.qrKey,
        qrImage,
        status: "请用哔哩哔哩 App 扫码，并在手机上确认登录",
        error: ""
      }));
    } catch (error) {
      setAuthState((current) => ({ ...current, busy: false, error: error.message || "生成二维码失败" }));
    }
  }

  async function pollQrStatus(qrKey) {
    try {
      const response = await fetch(apiUrl(`/api/auth/qr/poll?key=${encodeURIComponent(qrKey)}`));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "登录状态同步失败");
      setAuthState((current) => ({ ...current, status: payload?.message || current.status }));
      if (payload?.loggedIn) {
        setAuthState((current) => ({
          ...current,
          loggedIn: true,
          user: payload.user || null,
          qrKey: "",
          qrUrl: "",
          qrImage: "",
          status: "已启用账号增强模式",
          error: ""
        }));
      }
    } catch (error) {
      setAuthState((current) => ({ ...current, error: error.message || "登录状态同步失败" }));
    }
  }

  async function logoutAuth() {
    try {
      const response = await fetch(apiUrl("/api/auth/logout"));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "退出登录失败");
      setAuthState({
        loading: false,
        loggedIn: false,
        user: null,
        qrUrl: "",
        qrKey: "",
        qrImage: "",
        status: "已退出账号增强模式",
        busy: false,
        error: ""
      });
    } catch (error) {
      setAuthState((current) => ({ ...current, error: error.message || "退出登录失败" }));
    }
  }

  function updatePlaybackRate(nextValue) {
    const safe = Math.min(3, Math.max(0.5, Math.round(Number(nextValue) * 10) / 10));
    setPlaybackRate(safe);
    if (audioRef.current) {
      audioRef.current.playbackRate = safe;
    }
  }

  function updateFontSize(nextValue) {
    setFontSize(Math.min(18, Math.max(12, Math.round(Number(nextValue)))));
  }

  function handleBackgroundUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      setBackgroundImage(result);
    };
    reader.readAsDataURL(file);
  }

  async function searchMusic(event, forcedQuery, nextPage = 1, append = false) {
    event?.preventDefault();
    const query = (forcedQuery ?? keyword).trim();
    if (!query) return;
    setKeyword(query);
    setSearchLoading(true);
    setSearchError("");
    setFavoriteMessage("");
    try {
      const response = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(query)}&page=${encodeURIComponent(nextPage)}`));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "搜索失败");
      if (!payload || !Array.isArray(payload.items)) throw new Error("搜索接口返回了非预期数据，请检查 /api/search 是否正常");
      setResults((current) => (append ? [...current, ...payload.items] : payload.items));
      setSearchPage(nextPage);
      setHasMoreSearch(payload.items.length > 0 && nextPage < (payload.pageCount || Number.MAX_SAFE_INTEGER));
      setSearchHistory(addSearchHistoryItem(query));
      if (!append) setActiveTab("search");
    } catch (error) {
      setSearchError(error.message || "搜索失败");
    } finally {
      setSearchLoading(false);
      setHistoryVisible(false);
    }
  }

  async function loadMoreSearch() {
    if (!searchLoading && hasMoreSearch) await searchMusic(undefined, keyword, searchPage + 1, true);
  }

  async function openUploader(mid, uploader, page = 1, append = false) {
    if (!mid) return;
    setUpView((current) => ({ ...current, mid, uploader, loading: true, error: "" }));
    try {
      const response = await fetch(apiUrl(`/api/up/${mid}/videos?page=${page}`));
      const payload = await readJsonSafely(response);
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "加载 UP 投稿失败");
      if (!payload || !Array.isArray(payload.items)) throw new Error("UP 投稿接口返回了非预期数据");
      setUpView((current) => ({
        ...current,
        mid,
        uploader: payload.uploader || uploader,
        items: append ? [...current.items, ...payload.items] : payload.items,
        page,
        hasMore: payload.items.length > 0 && page < (payload.pageCount || Number.MAX_SAFE_INTEGER),
        loading: false,
        error: ""
      }));
      setActiveTab("up");
    } catch (error) {
      setUpView((current) => ({ ...current, loading: false, error: error.message || "加载 UP 投稿失败" }));
    }
  }

  async function loadMoreUpVideos() {
    if (upView.mid && !upView.loading && upView.hasMore) await openUploader(upView.mid, upView.uploader, upView.page + 1, true);
  }

  async function playQueueIndex(index, nextQueue = queueItems) {
    const item = nextQueue[index];
    const audio = audioRef.current;
    if (!item || !audio) return;
    const requestId = playRequestRef.current + 1;
    playRequestRef.current = requestId;
    setPlayerError("");
    setFavoriteMessage("");
    setCurrentTrack(item);
    setQueueItems(nextQueue);
    setQueueIndex(index);
    resetPlaybackPosition();
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.src = apiUrl(`/api/stream/${encodeURIComponent(item.bvid)}?ts=${Date.now()}`);
    try {
      await audio.play();
      setIsPlaying(true);
      setRecentPlays(addRecentPlayItem(createRecentPlay(item)));
    } catch (error) {
      if (playRequestRef.current === requestId) {
        setIsPlaying(false);
        setPlayerError(error.message || "播放失败");
      }
    }
  }

  async function playCard(item) {
    const existingIndex = queueItems.findIndex((entry) => entry.bvid === item.bvid);
    if (existingIndex >= 0) {
      await playQueueIndex(existingIndex);
      return;
    }
    const nextQueue = [...queueItems, item];
    await playQueueIndex(nextQueue.length - 1, nextQueue);
  }

  function queueNext(item) {
    const nextQueue = insertQueueNext(queueItems, item, queueIndex);
    setQueueItems(nextQueue);
    if (currentTrack) {
      setQueueIndex(nextQueue.findIndex((entry) => entry.bvid === currentTrack.bvid));
    }
    setFavoriteMessage(`已加入播放列表：${item.title}`);
  }

  function playPrevious() {
    if (queueIndex > 0) void playQueueIndex(queueIndex - 1);
  }

  function playNext(manual = true) {
    if (queueIndex >= 0 && queueIndex < queueItems.length - 1) {
      void playQueueIndex(queueIndex + 1);
      return;
    }
    if (manual && queueItems.length && queueIndex === -1) {
      void playQueueIndex(0);
    }
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!currentTrack && queueItems.length) {
      void playQueueIndex(Math.max(queueIndex, 0));
      return;
    }
    if (!currentTrack) return;
    if (audio.paused) {
      audio.play().then(() => setIsPlaying(true)).catch((error) => setPlayerError(error.message || "播放失败"));
      return;
    }
    audio.pause();
    setIsPlaying(false);
  }

  function createFavoriteGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    const nextGroup = createGroup(name);
    setFavoriteGroupsState((current) => [nextGroup, ...current]);
    setSelectedGroupId(nextGroup.id);
    setNewGroupName("");
    setFavoriteMessage(`已创建收藏夹：${name}`);
  }

  function openFavoritePicker(item) {
    setFavoritePicker({ item, groupId: selectedGroupId || favoriteGroups[0]?.id || "", name: "" });
  }

  function closeFavoritePicker() {
    setFavoritePicker(null);
  }

  function addToFavorites(item, groupId = selectedGroupId) {
    const target = favoriteGroups.find((group) => group.id === groupId) || favoriteGroups[0];
    if (!target) {
      setFavoriteMessage("请先创建一个收藏夹");
      return false;
    }
    let added = false;
    setFavoriteGroupsState((current) =>
      current.map((group) => {
        if (group.id !== target.id) return group;
        if (group.tracks.some((track) => track.bvid === item.bvid)) return group;
        added = true;
        return { ...group, tracks: [createStoredTrack(item), ...group.tracks], updatedAt: new Date().toISOString() };
      })
    );
    setFavoriteMessage(added ? `已加入 ${target.name}` : `${target.name} 里已经有这首歌`);
    return added;
  }

  function createAndFavorite() {
    const name = favoritePicker?.name?.trim();
    if (!name || !favoritePicker?.item) return;
    const nextGroup = createGroup(name);
    setFavoriteGroupsState((current) => [{ ...nextGroup, tracks: [createStoredTrack(favoritePicker.item)] }, ...current]);
    setSelectedGroupId(nextGroup.id);
    setFavoriteMessage(`已加入新收藏夹：${name}`);
    closeFavoritePicker();
  }

  function confirmFavorite() {
    if (favoritePicker?.item && addToFavorites(favoritePicker.item, favoritePicker.groupId)) closeFavoritePicker();
  }

  function removeFavoriteTrack(groupId, bvid) {
    setFavoriteGroupsState((current) =>
      current.map((group) =>
        group.id === groupId
          ? { ...group, tracks: group.tracks.filter((track) => track.bvid !== bvid), updatedAt: new Date().toISOString() }
          : group
      )
    );
  }

  function moveQueueItem(fromIndex, toIndex) {
    const nextQueue = reorderItems(queueItems, fromIndex, toIndex);
    setQueueItems(nextQueue);
    if (currentTrack) setQueueIndex(nextQueue.findIndex((item) => item.bvid === currentTrack.bvid));
  }

  function removeQueueItem(index) {
    const target = queueItems[index];
    const nextQueue = queueItems.filter((_, itemIndex) => itemIndex !== index);
    setQueueItems(nextQueue);
    if (!currentTrack || target?.bvid !== currentTrack.bvid) {
      if (index < queueIndex) setQueueIndex((current) => Math.max(current - 1, -1));
      return;
    }
    if (nextQueue[index]) {
      void playQueueIndex(index, nextQueue);
      return;
    }
    if (nextQueue[index - 1]) {
      void playQueueIndex(index - 1, nextQueue);
      return;
    }
    const audio = audioRef.current;
    audio?.pause();
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
    }
    setCurrentTrack(null);
    setQueueIndex(-1);
    setIsPlaying(false);
    resetPlaybackPosition();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.volume = volume;
    audio.playbackRate = playbackRate;
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const handleLoadedMetadata = () => {
      setDuration(audio.duration || currentTrack?.durationSeconds || 0);
      setPlayerError("");
    };
    const handlePause = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handleEnded = () => {
      setIsPlaying(false);
      if (playbackMode === "repeat-one" && currentTrack) {
        audio.currentTime = 0;
        void audio.play().catch((error) => setPlayerError(error.message || "单曲循环失败"));
        return;
      }
      if (playbackMode === "sequence" && queueIndex >= 0 && queueIndex < queueItems.length - 1) {
        void playQueueIndex(queueIndex + 1);
      }
    };
    const handleError = () => {
      if (!audio.currentSrc) return;
      setIsPlaying(false);
      setPlayerError("当前音频无法播放，可能已失效、受限，或该资源暂不支持播放");
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [currentTrack, playbackMode, playbackRate, queueIndex, queueItems, volume]);

  function renderCards(items, favoriteGroupId) {
    return (
      <div className="card-grid">
        {items.map((item, index) =>
          favoriteGroupId ? (
            <article key={`${item.bvid}-${index}`} className="result-card">
              <button type="button" className="card-play-zone" onClick={() => void playCard(item)}>
                <div className="card-topline">
                  <span className="card-duration">{item.duration}</span>
                  {item.publishDate ? <span className="card-pubdate">{item.publishDate}</span> : null}
                  <span className="card-playcount">播放 {formatNumber(item.playCount)}</span>
                </div>
                <h3>{item.title}</h3>
                <p>
                  <button
                    type="button"
                    className="uploader-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      void openUploader(item.mid, item.uploader);
                    }}
                  >
                    {item.uploader}
                  </button>
                </p>
              </button>
              <div className="card-actions multi">
                <button type="button" className="ghost-button" onClick={() => queueNext(item)}>
                  下一个播放
                </button>
                <button type="button" className="ghost-button" onClick={() => removeFavoriteTrack(favoriteGroupId, item.bvid)}>
                  移除
                </button>
              </div>
            </article>
          ) : (
            <ResultCard
              key={`${item.bvid}-${index}`}
              item={item}
              onPlay={() => void playCard(item)}
              onQueueNext={() => queueNext(item)}
              onFavorite={() => openFavoritePicker(item)}
              onOpenUploader={() => void openUploader(item.mid, item.uploader)}
            />
          )
        )}
      </div>
    );
  }

  return (
    <div
      className={`app-shell theme-${theme}${backgroundImage ? " has-custom-bg" : ""}`}
      style={backgroundImage ? { "--app-background-image": `url(${backgroundImage})` } : undefined}
    >
      <main className="layout">
        <header className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Zi Music</p>
            <h1>把 Bilibili 里的歌，变成一个更像播放器的桌面应用。</h1>
            <p className="subtext">搜索、收藏、最近播放、账号增强和一个真正可排序的播放列表，都在这里。</p>
          </div>
        </header>

        <nav className="top-tabs">
          <button type="button" className={activeTab === "search" ? "active" : ""} onClick={() => setActiveTab("search")}>搜索</button>
          <button type="button" className={activeTab === "favorites" ? "active" : ""} onClick={() => setActiveTab("favorites")}>收藏夹</button>
          <button type="button" className={activeTab === "recent" ? "active" : ""} onClick={() => setActiveTab("recent")}>最近播放</button>
          <button type="button" className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>设置</button>
          <button type="button" className={activeTab === "auth" ? "active" : ""} onClick={() => setActiveTab("auth")}>账号增强</button>
          {activeTab === "up" ? <button type="button" className="active">{upView.uploader || "UP 投稿"}</button> : null}
        </nav>

        {activeTab === "search" ? (
          <section className="panel page-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Search</p>
                <h2>搜索</h2>
              </div>
            </div>
            <div className="search-shell" ref={historyRef}>
              <form className="search-bar" onSubmit={searchMusic}>
                <input type="text" value={keyword} placeholder="输入歌曲名、歌手名、专辑名" onFocus={() => setHistoryVisible(true)} onChange={(event) => setKeyword(event.target.value)} />
                <button type="submit" disabled={searchLoading}>{searchLoading ? "搜索中..." : "搜索"}</button>
              </form>
              {historyVisible ? (
                <div className="history-popover compact">
                  <div className="history-header">
                    <span>历史搜索</span>
                    <button type="button" onClick={() => setHistoryVisible(false)}>收起</button>
                  </div>
                  <div className="history-chips">
                    {searchHistory.length ? (
                      searchHistory.map((item) => (
                        <div key={item} className="history-chip-card">
                          <button type="button" className="history-link" onClick={() => void searchMusic(undefined, item)}>{item}</button>
                          <button type="button" className="history-remove" onClick={() => setSearchHistory(removeSearchHistoryItem(item))}>×</button>
                        </div>
                      ))
                    ) : (
                      <span className="history-empty">还没有搜索记录</span>
                    )}
                  </div>
                  {searchHistory.length ? (
                    <div className="history-footer">
                      <button type="button" className="ghost-button small" onClick={() => setSearchHistory(clearSearchHistory())}>清空全部</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {searchError ? <div className="message error">{searchError}</div> : null}
            {favoriteMessage ? <div className="message success">{favoriteMessage}</div> : null}
            {renderCards(results)}
            {hasMoreSearch ? (
              <div className="load-more-row">
                <button type="button" className="load-more-button" onClick={loadMoreSearch} disabled={searchLoading}>{searchLoading ? "加载中..." : "加载更多"}</button>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "favorites" ? (
          <section className="panel page-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Favorites</p>
                <h2>收藏夹</h2>
              </div>
            </div>
            <div className="favorite-group-creator wide">
              <input type="text" value={newGroupName} placeholder="新建收藏夹" onChange={(event) => setNewGroupName(event.target.value)} />
              <button type="button" onClick={createFavoriteGroup}>新建</button>
            </div>
            <div className="favorite-group-tabs">
              {favoriteGroups.length ? (
                favoriteGroups.map((group) => (
                  <button key={group.id} type="button" className={`favorite-group-tab${group.id === selectedGroupId ? " active" : ""}`} onClick={() => setSelectedGroupId(group.id)}>
                    {group.name} ({group.tracks.length})
                  </button>
                ))
              ) : (
                <span className="history-empty">还没有收藏夹</span>
              )}
            </div>
            {renderCards(selectedGroup?.tracks || [], selectedGroup?.id)}
          </section>
        ) : null}

        {activeTab === "recent" ? (
          <section className="panel page-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Recent Plays</p>
                <h2>最近播放</h2>
              </div>
            </div>
            <div className="search-bar slim">
              <input type="text" value={recentQuery} placeholder="搜索最近播放" onChange={(event) => setRecentQuery(event.target.value)} />
            </div>
            {renderCards(recentFiltered)}
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className="panel page-panel settings-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Settings</p>
                <h2>设置</h2>
              </div>
            </div>
            <div className="settings-grid">
              <div className="settings-card">
                <span className="label">主题</span>
                <div className="theme-switcher">
                  {[
                    ["frost", "霜白"],
                    ["graphite", "石墨"],
                    ["sunset", "暮色"]
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`theme-option${theme === value ? " active" : ""}`}
                      onClick={() => setTheme(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="settings-inline">
                  <label className="upload-field">
                    <span>上传背景图</span>
                    <input type="file" accept="image/*" onChange={handleBackgroundUpload} />
                  </label>
                  <button type="button" className="ghost-button" onClick={() => setBackgroundImage("")}>
                    清除背景
                  </button>
                </div>
              </div>

              <div className="settings-card">
                <span className="label">字体大小</span>
                <div className="settings-slider">
                  <input type="range" min="12" max="18" step="1" value={fontSize} onChange={(event) => updateFontSize(event.target.value)} />
                  <strong>{fontSize}px</strong>
                </div>
                <span className="label">播放速度</span>
                <div className="settings-slider">
                  <input
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={playbackRate}
                    onChange={(event) => updatePlaybackRate(event.target.value)}
                  />
                  <strong>{playbackRate.toFixed(1)}x</strong>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "up" ? (
          <section className="panel page-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Uploader Videos</p>
                <h2>{upView.uploader || "UP 投稿"}</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => setActiveTab("search")}>返回搜索</button>
            </div>
            {upView.error ? <div className="message error">{upView.error}</div> : null}
            {renderCards(upView.items)}
            {upView.hasMore ? (
              <div className="load-more-row">
                <button type="button" className="load-more-button" onClick={loadMoreUpVideos} disabled={upView.loading}>{upView.loading ? "加载中..." : "加载更多"}</button>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "auth" ? (
          <section className="panel page-panel auth-panel">
            <div className="page-head">
              <div>
                <p className="section-kicker">Account Boost</p>
                <h2>账号增强</h2>
              </div>
            </div>
            <div className="auth-grid">
              <div className="auth-card">
                <span className="label">当前状态</span>
                <strong>{authState.loggedIn ? "已登录" : authState.loading ? "读取中" : "未登录"}</strong>
                <p>
                  {authState.loggedIn
                    ? `当前使用 ${authState.user?.uname || "Bilibili 用户"} 的应用内登录态，请求会优先带上这份 Cookie。`
                    : "用于提升 UP 投稿页和部分受风控接口的成功率，不会读取系统浏览器已有登录信息。"}
                </p>
                {authState.user ? (
                  <div className="auth-user">
                    {authState.user.avatar ? <img src={authState.user.avatar} alt={authState.user.uname} /> : null}
                    <div>
                      <strong>{authState.user.uname}</strong>
                      <span>UID {authState.user.mid}</span>
                    </div>
                  </div>
                ) : null}
                <div className="auth-actions">
                  <button type="button" className="ghost-button" onClick={beginAuthFlow} disabled={authState.busy}>
                    {authState.busy ? "生成中..." : authState.loggedIn ? "重新登录" : "开始扫码登录"}
                  </button>
                  {authState.loggedIn ? <button type="button" className="ghost-button" onClick={logoutAuth}>退出增强模式</button> : null}
                </div>
                {authState.status ? <div className="message success compact">{authState.status}</div> : null}
                {authState.error ? <div className="message error compact">{authState.error}</div> : null}
              </div>
              <div className="auth-card qr-card">
                <span className="label">应用内扫码登录</span>
                {authState.qrImage ? (
                  <>
                    <img className="qr-image" src={authState.qrImage} alt="Bilibili 登录二维码" />
                    <p>用哔哩哔哩 App 扫码并确认后，软件会自动同步登录态。</p>
                  </>
                ) : (
                  <div className="auth-placeholder">
                    <strong>还没有二维码</strong>
                    <p>点击左侧“开始扫码登录”即可生成。</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

      </main>

      {favoritePicker ? (
        <div className="modal-backdrop" onClick={closeFavoritePicker}>
          <div className="favorite-modal" onClick={(event) => event.stopPropagation()}>
            <div className="page-head compact">
              <div>
                <p className="section-kicker">Favorite</p>
                <h2>选择收藏夹</h2>
              </div>
              <button type="button" className="ghost-button small" onClick={closeFavoritePicker}>关闭</button>
            </div>
            <div className="favorite-picker-list">
              {favoriteGroups.length ? (
                favoriteGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`favorite-picker-option${favoritePicker.groupId === group.id ? " active" : ""}`}
                    onClick={() => setFavoritePicker((current) => ({ ...current, groupId: group.id }))}
                  >
                    {group.name}
                    <span>{group.tracks.length} 首</span>
                  </button>
                ))
              ) : (
                <span className="history-empty">还没有收藏夹，请先创建一个新的。</span>
              )}
            </div>
            <div className="favorite-group-creator">
              <input
                type="text"
                value={favoritePicker.name}
                placeholder="或新建一个收藏夹"
                onChange={(event) => setFavoritePicker((current) => ({ ...current, name: event.target.value }))}
              />
              <button type="button" onClick={createAndFavorite}>新建并收藏</button>
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={confirmFavorite} disabled={!favoritePicker.groupId}>
                收藏到所选收藏夹
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {queueVisible ? (
        <div className="queue-drawer">
          <div className="queue-drawer-head">
            <div>
              <p className="section-kicker">Play Queue</p>
              <h2>播放列表</h2>
            </div>
            <div className="queue-drawer-actions">
              <span className="queue-count">{queueItems.length} 首</span>
              <button type="button" className="ghost-button small" onClick={() => setQueueVisible(false)}>
                收起
              </button>
            </div>
          </div>
          <div className="queue-list">
            {queueItems.length ? (
              queueItems.map((item, index) => (
                <div
                  key={`${item.bvid}-${index}`}
                  className={`queue-item${index === queueIndex ? " active" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    dragIndexRef.current = index;
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(index));
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    moveQueueItem(dragIndexRef.current, index);
                    dragIndexRef.current = -1;
                  }}
                >
                  <span className="queue-handle" title="拖拽排序">
                    ⋮⋮
                  </span>
                  <button type="button" className="queue-main" onClick={() => void playQueueIndex(index)}>
                    <strong>{item.title}</strong>
                    <span>
                      {item.uploader} / {item.duration}
                    </span>
                  </button>
                  <button type="button" className="queue-remove" onClick={() => removeQueueItem(index)}>
                    移除
                  </button>
                </div>
              ))
            ) : (
              <div className="queue-empty">
                <strong>播放列表还是空的</strong>
                <p>在卡片上点“下一个播放”，就能把歌曲加入队列并按顺序播放。</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <footer className="player-bar responsive">
        <audio ref={audioRef} preload="none" />
        <div className="timeline stretch player-timeline">
          <div className="time-row">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration || currentTrack?.durationSeconds || 0)}</span>
          </div>
          <input
            className="timeline-slider"
            type="range"
            min="0"
            max={timelineMax}
            step="1"
            value={timelineValue}
            style={{ "--timeline-progress": timelineProgress }}
            onChange={(event) => {
              const audio = audioRef.current;
              const nextTime = Number(event.target.value);
              setCurrentTime(nextTime);
              if (audio) audio.currentTime = nextTime;
            }}
            disabled={!currentTrack}
          />
        </div>
        <div className="now-playing compact player-track">
          <span className="label">正在播放</span>
          <strong>{currentTrack?.title || "未选择歌曲"}</strong>
          <em>{currentTrack?.uploader || "点击卡片开始播放"}</em>
          {playerError ? <span className="player-error">{playerError}</span> : null}
        </div>
        <div className="player-controls icon-only player-actions">
          <button type="button" aria-label="上一首" data-tooltip="上一首" onClick={playPrevious} disabled={queueIndex <= 0}>
            <PreviousIcon />
          </button>
          <button
            type="button"
            aria-label="播放或暂停"
            data-tooltip={isPlaying ? "暂停" : "播放"}
            className="player-transport-primary"
            onClick={togglePlay}
            disabled={!currentTrack && !queueItems.length}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button type="button" aria-label="下一首" data-tooltip="下一首" onClick={() => playNext(true)} disabled={!queueItems.length || queueIndex >= queueItems.length - 1}>
            <NextIcon />
          </button>
          <button
            type="button"
            aria-label="显示播放列表"
            data-tooltip={queueVisible ? "隐藏播放列表" : "显示播放列表"}
            className={queueVisible ? "active-toggle" : ""}
            onClick={() => setQueueVisible((current) => !current)}
          >
            <QueueIcon />
          </button>
        </div>
        <div className="playback-mode player-mode">
          <span className="label player-mode-label">播放模式</span>
          <div className="mode-switch icon-mode-switch">
            <button
              type="button"
              data-tooltip="播完暂停"
              aria-label="播完暂停"
              className={playbackMode === "pause" ? "active" : ""}
              onClick={() => setPlaybackMode("pause")}
            >
              <StopAfterIcon />
            </button>
            <button
              type="button"
              data-tooltip="顺序播放"
              aria-label="顺序播放"
              className={playbackMode === "sequence" ? "active" : ""}
              onClick={() => setPlaybackMode("sequence")}
            >
              <SequenceIcon />
            </button>
            <button
              type="button"
              data-tooltip="单曲循环"
              aria-label="单曲循环"
              className={playbackMode === "repeat-one" ? "active" : ""}
              onClick={() => setPlaybackMode("repeat-one")}
            >
              <RepeatOneIcon />
            </button>
          </div>
        </div>
        <div className="player-side-stack">
          <div className="player-tools" ref={playerToolsRef}>
            <div className={`player-tool${activePlayerTool === "speed" ? " active" : ""}`}>
              <button
                type="button"
                className="player-tool-trigger"
                aria-label="倍速"
                data-tooltip="倍速"
                onClick={() => setActivePlayerTool((current) => (current === "speed" ? "" : "speed"))}
              >
                <SpeedIcon />
              </button>
              <div className={`player-tool-popover${activePlayerTool === "speed" ? " visible" : ""}`}>
                <span className="label">倍速</span>
                <div className="vertical-track-wrap">
                  <VerticalSlider min={0.5} max={3} step={0.1} value={playbackRate} onChange={updatePlaybackRate} ariaLabel="倍速调节" />
                </div>
                <strong>{playbackRate.toFixed(1)}x</strong>
              </div>
            </div>
            <div className={`player-tool${activePlayerTool === "volume" ? " active" : ""}`}>
              <button
                type="button"
                className="player-tool-trigger"
                aria-label="音量"
                data-tooltip="音量"
                onClick={() => setActivePlayerTool((current) => (current === "volume" ? "" : "volume"))}
              >
                <VolumeIcon />
              </button>
              <div className={`player-tool-popover${activePlayerTool === "volume" ? " visible" : ""}`}>
                <span className="label">音量</span>
                <div className="vertical-track-wrap">
                  <VerticalSlider min={0} max={1} step={0.01} value={volume} onChange={setVolume} ariaLabel="音量调节" />
                </div>
                <strong>{Math.round(volume * 100)}%</strong>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
