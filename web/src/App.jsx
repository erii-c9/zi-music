import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  addRecentPlayItem,
  addSearchHistoryItem,
  clearSearchHistory,
  getFavoriteGroups,
  getRecentPlays,
  getSearchHistory,
  getStoredPlaybackMode,
  getStoredVolume,
  removeSearchHistoryItem,
  setFavoriteGroups,
  setStoredPlaybackMode,
  setStoredVolume
} from "./storage";

function resolveApiBase() {
  const { hostname, port, protocol } = window.location;

  if (
    (hostname === "127.0.0.1" || hostname === "localhost") &&
    port === "5173" &&
    (protocol === "http:" || protocol === "https:")
  ) {
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
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function readJsonSafely(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function createGroup(name) {
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    name,
    tracks: [],
    createdAt: now,
    updatedAt: now
  };
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
    playedAt: new Date().toISOString()
  };
}

function ResultCard({ item, onPlay, onFavorite, onOpenUploader }) {
  return (
    <article className="result-card">
      <button type="button" className="card-play-zone" onClick={onPlay}>
        <div className="card-topline">
          <span className="card-duration">{item.duration}</span>
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

      <div className="card-actions">
        <button type="button" className="ghost-button" onClick={onFavorite}>
          收藏
        </button>
      </div>
    </article>
  );
}

export default function App() {
  const audioRef = useRef(null);
  const historyRef = useRef(null);
  const playRequestRef = useRef(0);

  const [activeTab, setActiveTab] = useState("search");
  const [keyword, setKeyword] = useState(DEFAULT_SEARCH);
  const [results, setResults] = useState([]);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [historyVisible, setHistoryVisible] = useState(false);
  const [searchHistory, setSearchHistory] = useState(getSearchHistory);

  const [upView, setUpView] = useState({
    mid: null,
    uploader: "",
    items: [],
    page: 1,
    hasMore: false,
    loading: false,
    error: ""
  });

  const [favoriteGroups, setFavoriteGroupsState] = useState(getFavoriteGroups);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [favoriteMessage, setFavoriteMessage] = useState("");

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
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(getStoredVolume);
  const [playbackMode, setPlaybackMode] = useState(getStoredPlaybackMode);
  const [playerError, setPlayerError] = useState("");

  const selectedGroup =
    favoriteGroups.find((group) => group.id === selectedGroupId) || favoriteGroups[0] || null;

  const recentFiltered = useMemo(() => {
    const query = recentQuery.trim().toLowerCase();
    if (!query) return recentPlays;

    return recentPlays.filter((item) => {
      const source = `${item.title} ${item.uploader}`.toLowerCase();
      return source.includes(query);
    });
  }, [recentPlays, recentQuery]);

  useEffect(() => {
    if (!selectedGroupId && favoriteGroups[0]) {
      setSelectedGroupId(favoriteGroups[0].id);
    }
  }, [favoriteGroups, selectedGroupId]);

  useEffect(() => {
    setStoredVolume(volume);
  }, [volume]);

  useEffect(() => {
    setStoredPlaybackMode(playbackMode);
  }, [playbackMode]);

  useEffect(() => {
    setFavoriteGroups(favoriteGroups);
  }, [favoriteGroups]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (historyRef.current && !historyRef.current.contains(event.target)) {
        setHistoryVisible(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    if (!authState.qrKey || authState.loggedIn) return undefined;

    const timer = window.setInterval(() => {
      void pollQrStatus(authState.qrKey);
    }, 2500);

    return () => {
      window.clearInterval(timer);
    };
  }, [authState.qrKey, authState.loggedIn]);

  function resetPlaybackPosition() {
    setCurrentTime(0);
    setDuration(0);
  }

  async function refreshAuthStatus() {
    try {
      const response = await fetch(apiUrl("/api/auth/status"));
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "读取登录状态失败");
      }

      setAuthState((current) => ({
        ...current,
        loading: false,
        loggedIn: Boolean(payload?.loggedIn),
        user: payload?.user || null,
        error: ""
      }));
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        loading: false,
        error: error.message || "读取登录状态失败"
      }));
    }
  }

  async function beginAuthFlow() {
    setAuthState((current) => ({
      ...current,
      busy: true,
      error: "",
      status: "正在生成二维码..."
    }));

    try {
      const response = await fetch(apiUrl("/api/auth/qr/generate"));
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "生成二维码失败");
      }

      const qrImage = await QRCode.toDataURL(payload.qrUrl, {
        width: 240,
        margin: 1
      });

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
      setAuthState((current) => ({
        ...current,
        busy: false,
        error: error.message || "生成二维码失败"
      }));
    }
  }

  async function pollQrStatus(qrKey) {
    try {
      const response = await fetch(apiUrl(`/api/auth/qr/poll?key=${encodeURIComponent(qrKey)}`));
      const payload = await readJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "登录状态同步失败");
      }

      setAuthState((current) => ({
        ...current,
        status: payload?.message || current.status
      }));

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
      setAuthState((current) => ({
        ...current,
        error: error.message || "登录状态同步失败"
      }));
    }
  }

  async function logoutAuth() {
    try {
      const response = await fetch(apiUrl("/api/auth/logout"));
      const payload = await readJsonSafely(response);
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "退出登录失败");
      }

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
      setAuthState((current) => ({
        ...current,
        error: error.message || "退出登录失败"
      }));
    }
  }

  function updateQueue(items, index) {
    setQueueItems(items);
    setQueueIndex(index);
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
      const response = await fetch(
        apiUrl(`/api/search?q=${encodeURIComponent(query)}&page=${encodeURIComponent(nextPage)}`)
      );
      const payload = await readJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "搜索失败");
      }

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error("搜索接口返回了非预期数据，请检查 /api/search 是否正常");
      }

      setResults((current) => (append ? [...current, ...payload.items] : payload.items));
      setSearchPage(nextPage);
      setHasMoreSearch(payload.items.length > 0 && nextPage < (payload.pageCount || Number.MAX_SAFE_INTEGER));
      setSearchHistory(addSearchHistoryItem(query));
      if (!append) {
        setActiveTab("search");
      }
    } catch (error) {
      setSearchError(error.message || "搜索失败");
    } finally {
      setSearchLoading(false);
      setHistoryVisible(false);
    }
  }

  async function loadMoreSearch() {
    if (searchLoading || !hasMoreSearch) return;
    await searchMusic(undefined, keyword, searchPage + 1, true);
  }

  async function openUploader(mid, uploader, page = 1, append = false) {
    if (!mid) return;

    setUpView((current) => ({
      ...current,
      mid,
      uploader,
      loading: true,
      error: ""
    }));

    try {
      const response = await fetch(apiUrl(`/api/up/${mid}/videos?page=${page}`));
      const payload = await readJsonSafely(response);

      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "加载 UP 投稿失败");
      }

      if (!payload || !Array.isArray(payload.items)) {
        throw new Error("UP 投稿接口返回了非预期数据");
      }

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
      setUpView((current) => ({
        ...current,
        loading: false,
        error: error.message || "加载 UP 投稿失败"
      }));
    }
  }

  async function loadMoreUpVideos() {
    if (!upView.mid || upView.loading || !upView.hasMore) return;
    await openUploader(upView.mid, upView.uploader, upView.page + 1, true);
  }

  async function playFromList(list, index) {
    const item = list[index];
    if (!item) return;

    const audio = audioRef.current;
    if (!audio) return;

    const requestId = playRequestRef.current + 1;
    playRequestRef.current = requestId;

    setPlayerError("");
    setFavoriteMessage("");
    setCurrentTrack(item);
    updateQueue(list, index);
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

  function playPrevious() {
    if (queueIndex > 0) {
      void playFromList(queueItems, queueIndex - 1);
    }
  }

  function playNext() {
    if (queueIndex >= 0 && queueIndex < queueItems.length - 1) {
      void playFromList(queueItems, queueIndex + 1);
    }
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    if (audio.paused) {
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch((error) => setPlayerError(error.message || "播放失败"));
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

  function addToFavorites(item, groupId = selectedGroupId) {
    const target = favoriteGroups.find((group) => group.id === groupId) || favoriteGroups[0];
    if (!target) {
      setFavoriteMessage("请先创建一个收藏夹");
      return;
    }

    setFavoriteGroupsState((current) =>
      current.map((group) => {
        if (group.id !== target.id) return group;
        if (group.tracks.some((track) => track.bvid === item.bvid)) return group;

        return {
          ...group,
          tracks: [createStoredTrack(item), ...group.tracks],
          updatedAt: new Date().toISOString()
        };
      })
    );
    setFavoriteMessage(`已加入 ${target.name}`);
  }

  function removeFavoriteTrack(groupId, bvid) {
    setFavoriteGroupsState((current) =>
      current.map((group) =>
        group.id === groupId
          ? {
              ...group,
              tracks: group.tracks.filter((track) => track.bvid !== bvid),
              updatedAt: new Date().toISOString()
            }
          : group
      )
    );
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    audio.volume = volume;

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
        void audio.play().catch((error) => {
          setPlayerError(error.message || "单曲循环失败");
        });
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
  }, [currentTrack, playbackMode, volume]);

  const activeCards =
    activeTab === "favorites"
      ? selectedGroup?.tracks || []
      : activeTab === "recent"
        ? recentFiltered
        : activeTab === "up"
          ? upView.items
          : results;

  return (
    <div className="app-shell">
      <main className="layout">
        <header className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Zi Music</p>
            <h1>把 Bilibili 里的歌，变成一个更像播放器的桌面应用。</h1>
            <p className="subtext">搜索、收藏、最近播放和 UP 投稿，都能在一个更紧凑的界面里完成。</p>
          </div>
        </header>

        <nav className="top-tabs">
          <button
            type="button"
            className={activeTab === "search" ? "active" : ""}
            onClick={() => setActiveTab("search")}
          >
            搜索
          </button>
          <button
            type="button"
            className={activeTab === "favorites" ? "active" : ""}
            onClick={() => setActiveTab("favorites")}
          >
            收藏夹
          </button>
          <button
            type="button"
            className={activeTab === "recent" ? "active" : ""}
            onClick={() => setActiveTab("recent")}
          >
            最近播放
          </button>
          <button
            type="button"
            className={activeTab === "auth" ? "active" : ""}
            onClick={() => setActiveTab("auth")}
          >
            账号增强
          </button>
          {activeTab === "up" ? (
            <button type="button" className="active">
              {upView.uploader || "UP 投稿"}
            </button>
          ) : null}
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
                <input
                  type="text"
                  value={keyword}
                  placeholder="输入歌曲名、歌手名、专辑名"
                  onFocus={() => setHistoryVisible(true)}
                  onChange={(event) => setKeyword(event.target.value)}
                />
                <button type="submit" disabled={searchLoading}>
                  {searchLoading ? "搜索中..." : "搜索"}
                </button>
              </form>

              {historyVisible ? (
                <div className="history-popover">
                  <div className="history-header">
                    <span>历史搜索</span>
                    <button type="button" onClick={() => setHistoryVisible(false)}>
                      收起
                    </button>
                  </div>
                  <div className="history-items">
                    {searchHistory.length ? (
                      searchHistory.map((item) => (
                        <div key={item} className="history-row">
                          <button type="button" className="history-link" onClick={() => void searchMusic(undefined, item)}>
                            {item}
                          </button>
                          <button
                            type="button"
                            className="history-remove"
                            onClick={() => setSearchHistory(removeSearchHistoryItem(item))}
                          >
                            删除
                          </button>
                        </div>
                      ))
                    ) : (
                      <span className="history-empty">还没有搜索记录</span>
                    )}
                  </div>
                  {searchHistory.length ? (
                    <div className="history-footer">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => setSearchHistory(clearSearchHistory())}
                      >
                        清空全部
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            {searchError ? <div className="message error">{searchError}</div> : null}
            {favoriteMessage ? <div className="message success">{favoriteMessage}</div> : null}

            <div className="card-grid">
              {results.map((item, index) => (
                <ResultCard
                  key={`${item.bvid}-${index}`}
                  item={item}
                  onPlay={() => void playFromList(results, index)}
                  onFavorite={() => addToFavorites(item)}
                  onOpenUploader={() => void openUploader(item.mid, item.uploader)}
                />
              ))}
            </div>

            {hasMoreSearch ? (
              <div className="load-more-row">
                <button type="button" className="load-more-button" onClick={loadMoreSearch} disabled={searchLoading}>
                  {searchLoading ? "加载中..." : "加载更多"}
                </button>
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
              <input
                type="text"
                value={newGroupName}
                placeholder="新建收藏夹"
                onChange={(event) => setNewGroupName(event.target.value)}
              />
              <button type="button" onClick={createFavoriteGroup}>
                新建
              </button>
            </div>

            <div className="favorite-group-tabs">
              {favoriteGroups.length ? (
                favoriteGroups.map((group) => (
                  <button
                    key={group.id}
                    type="button"
                    className={`favorite-group-tab${group.id === selectedGroupId ? " active" : ""}`}
                    onClick={() => setSelectedGroupId(group.id)}
                  >
                    {group.name} ({group.tracks.length})
                  </button>
                ))
              ) : (
                <span className="history-empty">还没有收藏夹</span>
              )}
            </div>

            <div className="card-grid">
              {(selectedGroup?.tracks || []).map((item, index) => (
                <div key={`${selectedGroup.id}-${item.bvid}`} className="result-card">
                  <button type="button" className="card-play-zone" onClick={() => void playFromList(selectedGroup.tracks, index)}>
                    <div className="card-topline">
                      <span className="card-duration">{item.duration}</span>
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
                  <div className="card-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => removeFavoriteTrack(selectedGroup.id, item.bvid)}
                    >
                      移除
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
              <input
                type="text"
                value={recentQuery}
                placeholder="搜索最近播放"
                onChange={(event) => setRecentQuery(event.target.value)}
              />
            </div>

            <div className="card-grid">
              {recentFiltered.map((item, index) => (
                <ResultCard
                  key={`${item.bvid}-${item.playedAt}`}
                  item={item}
                  onPlay={() => void playFromList(recentFiltered, index)}
                  onFavorite={() => addToFavorites(item)}
                  onOpenUploader={() => void openUploader(item.mid, item.uploader)}
                />
              ))}
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
              <button type="button" className="ghost-button" onClick={() => setActiveTab("search")}>
                返回搜索
              </button>
            </div>

            {upView.error ? <div className="message error">{upView.error}</div> : null}

            <div className="card-grid">
              {upView.items.map((item, index) => (
                <ResultCard
                  key={`${item.bvid}-${index}`}
                  item={item}
                  onPlay={() => void playFromList(upView.items, index)}
                  onFavorite={() => addToFavorites(item)}
                  onOpenUploader={() => void openUploader(item.mid, item.uploader)}
                />
              ))}
            </div>

            {upView.hasMore ? (
              <div className="load-more-row">
                <button type="button" className="load-more-button" onClick={loadMoreUpVideos} disabled={upView.loading}>
                  {upView.loading ? "加载中..." : "加载更多"}
                </button>
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
                  {authState.loggedIn ? (
                    <button type="button" className="ghost-button" onClick={logoutAuth}>
                      退出增强模式
                    </button>
                  ) : null}
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

      <footer className="player-bar responsive">
        <audio ref={audioRef} preload="none" />

        <div className="now-playing compact">
          <span className="label">正在播放</span>
          <strong>{currentTrack?.title || "未选择歌曲"}</strong>
          <em>{currentTrack?.uploader || "点击卡片开始播放"}</em>
          {playerError ? <span className="player-error">{playerError}</span> : null}
        </div>

        <div className="player-controls icon-only">
          <button type="button" aria-label="上一首" onClick={playPrevious} disabled={queueIndex <= 0}>
            ⏮
          </button>
          <button type="button" aria-label="播放或暂停" onClick={togglePlay} disabled={!currentTrack}>
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            aria-label="下一首"
            onClick={playNext}
            disabled={queueIndex < 0 || queueIndex >= queueItems.length - 1}
          >
            ⏭
          </button>
        </div>

        <div className="playback-mode">
          <span className="label">播放模式</span>
          <div className="mode-switch">
            <button
              type="button"
              className={playbackMode === "pause" ? "active" : ""}
              onClick={() => setPlaybackMode("pause")}
            >
              播完暂停
            </button>
            <button
              type="button"
              className={playbackMode === "repeat-one" ? "active" : ""}
              onClick={() => setPlaybackMode("repeat-one")}
            >
              单曲循环
            </button>
          </div>
        </div>

        <div className="timeline stretch">
          <div className="time-row">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration || currentTrack?.durationSeconds || 0)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={duration || currentTrack?.durationSeconds || 0}
            step="1"
            value={Math.min(currentTime, duration || currentTrack?.durationSeconds || 0)}
            onChange={(event) => {
              const audio = audioRef.current;
              const nextTime = Number(event.target.value);
              setCurrentTime(nextTime);
              if (audio) {
                audio.currentTime = nextTime;
              }
            }}
            disabled={!currentTrack}
          />
        </div>

        <div className="volume compact">
          <span>音量</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </div>
      </footer>
    </div>
  );
}
