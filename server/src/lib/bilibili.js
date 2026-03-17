import crypto from "node:crypto";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
  49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55,
  40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52
];

const trackCache = new Map();
let cachedWbi = null;

function stripHtml(value = "") {
  return value.replace(/<[^>]+>/g, "").trim();
}

function parseDurationToSeconds(value = "") {
  const parts = value
    .split(":")
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));

  if (!parts.length) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return parts[0];
}

function formatSeconds(totalSeconds = 0) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }

  return [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function getMixinKey(orig) {
  return WBI_MIXIN_KEY_ENC_TAB.map((index) => orig[index]).join("").slice(0, 32);
}

function signWbi(params, imgKey, subKey) {
  const query = new URLSearchParams();
  const mixinKey = getMixinKey(imgKey + subKey);
  const safeParams = {
    ...params,
    wts: Math.round(Date.now() / 1000)
  };

  Object.keys(safeParams)
    .sort()
    .forEach((key) => {
      query.append(key, String(safeParams[key]).replace(/[!'()*]/g, ""));
    });

  const rawQuery = query.toString();
  const wRid = crypto.createHash("md5").update(rawQuery + mixinKey).digest("hex");
  query.append("w_rid", wRid);

  return query.toString();
}

async function biliFetch(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": USER_AGENT,
      Referer: REFERER,
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Bilibili request failed: ${response.status}`);
  }

  return response;
}

async function getWbiKeys() {
  if (cachedWbi && cachedWbi.expiresAt > Date.now()) {
    return cachedWbi;
  }

  const response = await biliFetch("https://api.bilibili.com/x/web-interface/nav");
  const payload = await response.json();

  if (!payload?.data?.wbi_img?.img_url || !payload?.data?.wbi_img?.sub_url) {
    throw new Error("Unable to fetch Bilibili WBI keys");
  }

  const imgKey = payload.data.wbi_img.img_url.split("/").pop().split(".")[0];
  const subKey = payload.data.wbi_img.sub_url.split("/").pop().split(".")[0];

  cachedWbi = {
    imgKey,
    subKey,
    expiresAt: Date.now() + 10 * 60 * 1000
  };

  return cachedWbi;
}

export async function searchVideos(query, page = 1) {
  const { imgKey, subKey } = await getWbiKeys();
  const signedQuery = signWbi(
    {
      search_type: "video",
      keyword: query,
      page
    },
    imgKey,
    subKey
  );
  const response = await biliFetch(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${signedQuery}`
  );
  const payload = await response.json();

  if (payload.code !== 0) {
    throw new Error(payload.message || "Bilibili search failed");
  }

  const items = (payload.data?.result || []).map((item) => {
    const durationSeconds = parseDurationToSeconds(item.duration);

    return {
      id: item.bvid,
      bvid: item.bvid,
      aid: item.aid,
      title: stripHtml(item.title),
      uploader: item.author,
      duration: formatSeconds(durationSeconds),
      durationSeconds,
      playCount: item.play || 0,
      description: stripHtml(item.description || "")
    };
  });

  return {
    query,
    page: payload.data?.page || page,
    pageSize: payload.data?.pagesize || items.length,
    total: payload.data?.numResults || items.length,
    items
  };
}

async function getViewInfo(bvid) {
  const response = await biliFetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
  );
  const payload = await response.json();

  if (payload.code !== 0 || !payload.data) {
    throw new Error(payload.message || "Failed to fetch video detail");
  }

  return payload.data;
}

async function getPlayUrl(bvid, cid) {
  const response = await biliFetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(
      bvid
    )}&cid=${cid}&fnval=16&qn=64&fourk=1`
  );
  const payload = await response.json();

  if (payload.code !== 0 || !payload.data) {
    throw new Error(payload.message || "Failed to fetch playable stream");
  }

  return payload.data;
}

export async function getTrack(bvid) {
  const cached = trackCache.get(bvid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const view = await getViewInfo(bvid);
  const cid = view.cid;
  const playurl = await getPlayUrl(bvid, cid);
  const audioCandidates = playurl?.dash?.audio || [];
  const selectedAudio = [...audioCandidates].sort(
    (left, right) => (right.bandwidth || 0) - (left.bandwidth || 0)
  )[0];

  if (!selectedAudio?.baseUrl && !selectedAudio?.base_url) {
    throw new Error("No audio stream found for this video");
  }

  const data = {
    bvid,
    cid,
    title: view.title,
    uploader: view.owner?.name || "未知 UP 主",
    durationSeconds: view.duration || 0,
    audioUrl: selectedAudio.baseUrl || selectedAudio.base_url,
    streamUrl: `/api/stream/${encodeURIComponent(bvid)}`
  };

  trackCache.set(bvid, {
    data,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  return data;
}

export function getBilibiliStreamHeaders(range) {
  return {
    ...(range ? { Range: range } : {})
  };
}
