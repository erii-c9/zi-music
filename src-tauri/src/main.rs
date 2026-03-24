#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::TryStreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

const APP_PORT: u16 = 3001;
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";
const WBI_MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
    19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51,
    30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Clone)]
struct AppState {
    client: Client,
    track_cache: Arc<RwLock<HashMap<String, CachedTrack>>>,
    wbi_cache: Arc<RwLock<Option<CachedWbi>>>,
    auth_session: Arc<RwLock<Option<AuthSession>>>,
    auth_file: Arc<PathBuf>,
}

#[derive(Clone)]
struct CachedTrack {
    expires_at: Instant,
    data: TrackDetail,
}

#[derive(Clone)]
struct CachedWbi {
    expires_at: Instant,
    img_key: String,
    sub_key: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct AuthSession {
    cookie: String,
    uname: String,
    #[serde(rename = "mid")]
    user_mid: u64,
    #[serde(rename = "avatar")]
    face: String,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    service: &'static str,
    time: String,
}

#[derive(Debug, Serialize, Clone)]
struct SearchResponse {
    query: String,
    page: u32,
    #[serde(rename = "pageSize")]
    page_size: usize,
    #[serde(rename = "pageCount")]
    page_count: u32,
    total: usize,
    items: Vec<SearchItem>,
}

#[derive(Debug, Serialize, Clone)]
struct SearchItem {
    id: String,
    bvid: String,
    aid: u64,
    mid: u64,
    title: String,
    uploader: String,
    duration: String,
    #[serde(rename = "durationSeconds")]
    duration_seconds: u64,
    #[serde(rename = "playCount")]
    play_count: u64,
    #[serde(rename = "publishDate")]
    publish_date: String,
    description: String,
}

#[derive(Debug, Serialize, Clone)]
struct TrackDetail {
    bvid: String,
    cid: u64,
    title: String,
    uploader: String,
    #[serde(rename = "durationSeconds")]
    duration_seconds: u64,
    #[serde(skip_serializing)]
    audio_url: String,
    #[serde(rename = "streamUrl")]
    stream_url: String,
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    error: &'a str,
    detail: String,
}

#[derive(Deserialize)]
struct SearchParams {
    q: Option<String>,
    page: Option<u32>,
}

#[derive(Deserialize)]
struct UpVideosParams {
    page: Option<u32>,
}

#[derive(Deserialize)]
struct QrPollParams {
    key: String,
}

#[derive(Serialize)]
struct AuthStatusResponse {
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    user: Option<AuthUser>,
}

#[derive(Serialize)]
struct AuthUser {
    uname: String,
    #[serde(rename = "mid")]
    user_mid: u64,
    avatar: String,
}

#[derive(Serialize)]
struct QrGenerateResponse {
    #[serde(rename = "qrUrl")]
    qr_url: String,
    #[serde(rename = "qrKey")]
    qr_key: String,
}

#[derive(Serialize)]
struct QrPollResponse {
    status: &'static str,
    message: String,
    #[serde(rename = "loggedIn")]
    logged_in: bool,
    user: Option<AuthUser>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    error: &'static str,
    detail: String,
}

impl ApiError {
    fn bad_request(error: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error,
            detail: detail.into(),
        }
    }

    fn bad_gateway(error: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            error,
            detail: detail.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorPayload {
                error: self.error,
                detail: self.detail,
            }),
        )
            .into_response()
    }
}

#[tokio::main]
async fn main() {
    let state = build_state();
    let server_state = state.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_api_server(server_state).await {
            eprintln!("failed to start local api server: {error}");
        }
    });

    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn build_state() -> AppState {
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .expect("failed to build reqwest client");
    let auth_file = Arc::new(
        std::env::current_dir()
            .unwrap_or_default()
            .join(".zi-music-auth.json"),
    );
    let auth_session = Arc::new(RwLock::new(load_auth_session(auth_file.as_ref())));

    AppState {
        client,
        track_cache: Arc::new(RwLock::new(HashMap::new())),
        wbi_cache: Arc::new(RwLock::new(None)),
        auth_session,
        auth_file,
    }
}

async fn run_api_server(state: AppState) -> Result<(), Box<dyn std::error::Error>> {
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/qr/generate", get(generate_login_qr))
        .route("/api/auth/qr/poll", get(poll_login_qr))
        .route("/api/auth/logout", get(logout))
        .route("/api/search", get(search))
        .route("/api/up/{mid}/videos", get(up_videos))
        .route("/api/tracks/{bvid}", get(track))
        .route("/api/stream/{bvid}", get(stream))
        .with_state(state)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], APP_PORT));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "zi-music-tauri",
        time: chrono::Utc::now().to_rfc3339(),
    })
}

async fn auth_status(State(state): State<AppState>) -> Json<AuthStatusResponse> {
    let session = state.auth_session.read().await.clone();
    Json(auth_status_from_session(session))
}

async fn generate_login_qr(State(state): State<AppState>) -> Result<Json<QrGenerateResponse>, ApiError> {
    let response = state
        .client
        .get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header&go_url=https://www.bilibili.com/")
        .header(header::REFERER, REFERER)
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway("Generate login qr failed", error.to_string()))?;

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| ApiError::bad_gateway("Generate login qr failed", error.to_string()))?;

    if payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Generate login qr failed",
            payload["message"].as_str().unwrap_or("Unknown error").to_string(),
        ));
    }

    Ok(Json(QrGenerateResponse {
        qr_url: payload["data"]["url"].as_str().unwrap_or_default().to_string(),
        qr_key: payload["data"]["qrcode_key"].as_str().unwrap_or_default().to_string(),
    }))
}

async fn poll_login_qr(
    State(state): State<AppState>,
    Query(params): Query<QrPollParams>,
) -> Result<Json<QrPollResponse>, ApiError> {
    let key = params.key.trim();
    if key.is_empty() {
        return Err(ApiError::bad_request("Missing qr key", "Please provide key"));
    }

    let response = state
        .client
        .get(format!(
            "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={}&source=main-fe-header",
            urlencoding::encode(key)
        ))
        .header(header::REFERER, REFERER)
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway("Poll login qr failed", error.to_string()))?;

    let headers = response.headers().clone();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| ApiError::bad_gateway("Poll login qr failed", error.to_string()))?;

    if payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Poll login qr failed",
            payload["message"].as_str().unwrap_or("Unknown error").to_string(),
        ));
    }

    let login_code = payload["data"]["code"].as_i64().unwrap_or_default();
    match login_code {
        86101 => Ok(Json(QrPollResponse {
            status: "waiting",
            message: "等待扫码".to_string(),
            logged_in: false,
            user: None,
        })),
        86090 => Ok(Json(QrPollResponse {
            status: "scanned",
            message: "已扫码，请在手机上确认登录".to_string(),
            logged_in: false,
            user: None,
        })),
        86038 => Ok(Json(QrPollResponse {
            status: "expired",
            message: "二维码已失效，请刷新重试".to_string(),
            logged_in: false,
            user: None,
        })),
        0 => {
            let cookie = extract_cookie_string(&headers, payload["data"]["url"].as_str());
            if cookie.is_empty() {
                return Err(ApiError::bad_gateway(
                    "Poll login qr failed",
                    "登录成功，但未能获取登录态",
                ));
            }

            let session = fetch_auth_session(&state, &cookie).await?;
            store_auth_session(&state, &session).await;

            Ok(Json(QrPollResponse {
                status: "success",
                message: "登录成功，已启用增强模式".to_string(),
                logged_in: true,
                user: Some(AuthUser {
                    uname: session.uname,
                    user_mid: session.user_mid,
                    avatar: session.face,
                }),
            }))
        }
        _ => Ok(Json(QrPollResponse {
            status: "waiting",
            message: payload["data"]["message"]
                .as_str()
                .unwrap_or("等待扫码")
                .to_string(),
            logged_in: false,
            user: None,
        })),
    }
}

async fn logout(State(state): State<AppState>) -> Json<AuthStatusResponse> {
    {
        let mut auth = state.auth_session.write().await;
        *auth = None;
    }
    let _ = fs::remove_file(state.auth_file.as_ref());

    Json(AuthStatusResponse {
        logged_in: false,
        user: None,
    })
}

async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<SearchResponse>, ApiError> {
    let query = params.q.unwrap_or_default().trim().to_string();
    let page = params.page.unwrap_or(1);

    if query.is_empty() {
        return Err(ApiError::bad_request(
            "Missing required query parameter q",
            "Please provide a search keyword",
        ));
    }

    let result = search_videos(&state, &query, page).await?;
    Ok(Json(result))
}

async fn track(
    State(state): State<AppState>,
    Path(bvid): Path<String>,
) -> Result<Json<TrackDetail>, ApiError> {
    let detail = get_track(&state, &bvid).await?;
    Ok(Json(detail))
}

async fn up_videos(
    State(state): State<AppState>,
    Path(mid): Path<u64>,
    Query(params): Query<UpVideosParams>,
) -> Result<Json<SearchResponse>, ApiError> {
    let page = params.page.unwrap_or(1);
    let result = fetch_up_videos(&state, mid, page).await?;
    Ok(Json(result))
}

async fn stream(
    State(state): State<AppState>,
    Path(bvid): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    match forward_audio_stream(&state, &bvid, &headers, false).await {
        Ok(response) => Ok(response),
        Err(_) => {
            {
                let mut cache = state.track_cache.write().await;
                cache.remove(&bvid);
            }
            forward_audio_stream(&state, &bvid, &headers, true).await
        }
    }
}

async fn search_videos(state: &AppState, query: &str, page: u32) -> Result<SearchResponse, ApiError> {
    let (img_key, sub_key) = get_wbi_keys(state).await?;
    let signed_query = sign_wbi(
        vec![
            ("keyword".to_string(), query.to_string()),
            ("page".to_string(), page.to_string()),
            ("search_type".to_string(), "video".to_string()),
        ],
        &img_key,
        &sub_key,
    );
    let url = format!("https://api.bilibili.com/x/web-interface/wbi/search/type?{signed_query}");
    let payload = fetch_json(state, &url).await?;

    if payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Search failed",
            payload["message"].as_str().unwrap_or("Unknown error").to_string(),
        ));
    }

    let data = &payload["data"];
    let items = data["result"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let raw_duration = item["duration"].as_str().unwrap_or_default();
            let duration_seconds = parse_duration_to_seconds(raw_duration);

            SearchItem {
                id: item["bvid"].as_str().unwrap_or_default().to_string(),
                bvid: item["bvid"].as_str().unwrap_or_default().to_string(),
                aid: item["aid"].as_u64().unwrap_or_default(),
                mid: item["mid"].as_u64().unwrap_or_default(),
                title: strip_html(item["title"].as_str().unwrap_or_default()),
                uploader: item["author"].as_str().unwrap_or("未知 UP 主").to_string(),
                duration: format_seconds(duration_seconds),
                duration_seconds,
                play_count: item["play"].as_u64().unwrap_or_default(),
                publish_date: format_publish_date(item["pubdate"].as_i64().unwrap_or_default()),
                description: strip_html(item["description"].as_str().unwrap_or_default()),
            }
        })
        .collect::<Vec<_>>();

    Ok(SearchResponse {
        query: query.to_string(),
        page: data["page"].as_u64().unwrap_or(page as u64) as u32,
        page_size: data["pagesize"].as_u64().unwrap_or(items.len() as u64) as usize,
        page_count: compute_page_count(
            data["numResults"].as_u64().unwrap_or(items.len() as u64) as usize,
            data["pagesize"].as_u64().unwrap_or(items.len() as u64) as usize,
        ),
        total: data["numResults"].as_u64().unwrap_or(items.len() as u64) as usize,
        items,
    })
}

async fn fetch_up_videos(state: &AppState, mid: u64, page: u32) -> Result<SearchResponse, ApiError> {
    let (img_key, sub_key) = get_wbi_keys(state).await?;
    let signed_query = sign_wbi(
        vec![
            ("mid".to_string(), mid.to_string()),
            ("pn".to_string(), page.to_string()),
            ("ps".to_string(), "20".to_string()),
            ("order".to_string(), "pubdate".to_string()),
        ],
        &img_key,
        &sub_key,
    );
    let url = format!("https://api.bilibili.com/x/space/wbi/arc/search?{signed_query}");
    let payload = fetch_json(state, &url).await?;

    if payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Up videos failed",
            payload["message"].as_str().unwrap_or("Unknown error").to_string(),
        ));
    }

    let data = &payload["data"];
    let list = &data["list"]["vlist"];
    let page_data = &data["page"];
    let items = list
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let duration_seconds = item["length"]
                .as_str()
                .map(parse_duration_to_seconds)
                .unwrap_or_default();

            SearchItem {
                id: item["bvid"].as_str().unwrap_or_default().to_string(),
                bvid: item["bvid"].as_str().unwrap_or_default().to_string(),
                aid: item["aid"]
                    .as_u64()
                    .or_else(|| item["aid"].as_str().and_then(|value| value.parse::<u64>().ok()))
                    .unwrap_or_default(),
                mid,
                title: strip_html(item["title"].as_str().unwrap_or_default()),
                uploader: item["author"]
                    .as_str()
                    .unwrap_or("未知 UP 主")
                    .to_string(),
                duration: format_seconds(duration_seconds),
                duration_seconds,
                play_count: item["play"]
                    .as_u64()
                    .or_else(|| item["play"].as_str().and_then(|value| value.parse::<u64>().ok()))
                    .unwrap_or_default(),
                publish_date: format_publish_date(item["created"].as_i64().unwrap_or_default()),
                description: strip_html(item["description"].as_str().unwrap_or_default()),
            }
        })
        .collect::<Vec<_>>();

    let page_size = page_data["ps"].as_u64().unwrap_or(20) as usize;
    let total = page_data["count"].as_u64().unwrap_or(items.len() as u64) as usize;

    Ok(SearchResponse {
        query: mid.to_string(),
        page: page_data["pn"].as_u64().unwrap_or(page as u64) as u32,
        page_size,
        page_count: compute_page_count(total, page_size),
        total,
        items,
    })
}

async fn get_track(state: &AppState, bvid: &str) -> Result<TrackDetail, ApiError> {
    get_track_inner(state, bvid, false).await
}

async fn get_track_inner(state: &AppState, bvid: &str, force_refresh: bool) -> Result<TrackDetail, ApiError> {
    if !force_refresh {
        let cache = state.track_cache.read().await;
        if let Some(cached) = cache.get(bvid) {
            if cached.expires_at > Instant::now() {
                return Ok(cached.data.clone());
            }
        }
    }

    let view_url = format!(
        "https://api.bilibili.com/x/web-interface/view?bvid={}",
        urlencoding::encode(bvid)
    );
    let view_payload = fetch_json(state, &view_url).await?;

    if view_payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Track lookup failed",
            view_payload["message"]
                .as_str()
                .unwrap_or("Failed to fetch video detail")
                .to_string(),
        ));
    }

    let data = &view_payload["data"];
    let cid = data["cid"].as_u64().unwrap_or_default();
    let play_url = format!(
        "https://api.bilibili.com/x/player/playurl?bvid={}&cid={cid}&fnval=16&qn=64&fourk=1",
        urlencoding::encode(bvid)
    );
    let play_payload = fetch_json(state, &play_url).await?;

    if play_payload["code"].as_i64().unwrap_or(-1) != 0 {
        return Err(ApiError::bad_gateway(
            "Track lookup failed",
            play_payload["message"]
                .as_str()
                .unwrap_or("Failed to fetch playable stream")
                .to_string(),
        ));
    }

    let audio_url = play_payload["data"]["dash"]["audio"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .max_by_key(|item| item["bandwidth"].as_u64().unwrap_or_default())
        .and_then(|item| {
            item["baseUrl"]
                .as_str()
                .or_else(|| item["base_url"].as_str())
                .map(|value| value.to_string())
        })
        .ok_or_else(|| ApiError::bad_gateway("Track lookup failed", "No audio stream found"))?;

    let detail = TrackDetail {
        bvid: bvid.to_string(),
        cid,
        title: data["title"].as_str().unwrap_or("未知标题").to_string(),
        uploader: data["owner"]["name"]
            .as_str()
            .unwrap_or("未知 UP 主")
            .to_string(),
        duration_seconds: data["duration"].as_u64().unwrap_or_default(),
        audio_url,
        stream_url: format!("/api/stream/{bvid}"),
    };

    let mut cache = state.track_cache.write().await;
    cache.insert(
        bvid.to_string(),
        CachedTrack {
            expires_at: Instant::now() + Duration::from_secs(300),
            data: detail.clone(),
        },
    );

    Ok(detail)
}

async fn forward_audio_stream(
    state: &AppState,
    bvid: &str,
    headers: &HeaderMap,
    force_refresh: bool,
) -> Result<Response, ApiError> {
    let detail = get_track_inner(state, bvid, force_refresh).await?;
    let mut request = attach_auth_headers(
        state,
        state
            .client
            .get(&detail.audio_url)
            .header(header::REFERER, REFERER)
            .header(header::USER_AGENT, USER_AGENT),
    )
    .await;

    if let Some(range) = headers.get(header::RANGE) {
        request = request.header(header::RANGE, range.clone());
    }

    let upstream = request
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway("Audio streaming failed", error.to_string()))?;

    let status = upstream.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return Err(ApiError::bad_gateway(
            "Audio stream request failed",
            format!("Upstream status {status}"),
        ));
    }

    let mut response_headers = HeaderMap::new();
    for header_name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.headers().get(&header_name) {
            response_headers.insert(header_name, value.clone());
        }
    }

    let content_type = response_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if !content_type.is_empty()
        && content_type != "application/octet-stream"
        && !content_type.starts_with("audio/")
        && !content_type.starts_with("video/")
    {
        return Err(ApiError::bad_gateway(
            "Audio stream request failed",
            format!("Unexpected content type: {content_type}"),
        ));
    }

    if content_type.is_empty() || content_type == "application/octet-stream" {
        response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/mp4"));
    }

    let body_stream = upstream.bytes_stream().map_err(std::io::Error::other);
    let body = Body::from_stream(body_stream);

    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;
    Ok(response)
}

async fn get_wbi_keys(state: &AppState) -> Result<(String, String), ApiError> {
    {
        let cache = state.wbi_cache.read().await;
        if let Some(cached) = cache.as_ref() {
            if cached.expires_at > Instant::now() {
                return Ok((cached.img_key.clone(), cached.sub_key.clone()));
            }
        }
    }

    let payload = fetch_json(state, "https://api.bilibili.com/x/web-interface/nav").await?;
    let img_url = payload["data"]["wbi_img"]["img_url"]
        .as_str()
        .ok_or_else(|| ApiError::bad_gateway("Search failed", "Unable to fetch WBI img url"))?;
    let sub_url = payload["data"]["wbi_img"]["sub_url"]
        .as_str()
        .ok_or_else(|| ApiError::bad_gateway("Search failed", "Unable to fetch WBI sub url"))?;
    let img_key = extract_wbi_key(img_url);
    let sub_key = extract_wbi_key(sub_url);

    let mut cache = state.wbi_cache.write().await;
    *cache = Some(CachedWbi {
        expires_at: Instant::now() + Duration::from_secs(600),
        img_key: img_key.clone(),
        sub_key: sub_key.clone(),
    });

    Ok((img_key, sub_key))
}

async fn fetch_json(state: &AppState, url: &str) -> Result<Value, ApiError> {
    let response = attach_auth_headers(
        state,
        state.client.get(url).header(header::REFERER, REFERER),
    )
        .await
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway("Upstream request failed", error.to_string()))?;

    response
        .json::<Value>()
        .await
        .map_err(|error| ApiError::bad_gateway("Upstream response parse failed", error.to_string()))
}

async fn attach_auth_headers(
    state: &AppState,
    request: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    let auth = state.auth_session.read().await;
    if let Some(session) = auth.as_ref() {
        request.header(header::COOKIE, session.cookie.clone())
    } else {
        request
    }
}

async fn fetch_auth_session(state: &AppState, cookie: &str) -> Result<AuthSession, ApiError> {
    let response = state
        .client
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header(header::REFERER, REFERER)
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::COOKIE, cookie)
        .send()
        .await
        .map_err(|error| ApiError::bad_gateway("Fetch auth session failed", error.to_string()))?;

    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| ApiError::bad_gateway("Fetch auth session failed", error.to_string()))?;

    if payload["code"].as_i64().unwrap_or(-1) != 0 || !payload["data"]["isLogin"].as_bool().unwrap_or(false) {
        return Err(ApiError::bad_gateway(
            "Fetch auth session failed",
            payload["message"]
                .as_str()
                .unwrap_or("Login validation failed")
                .to_string(),
        ));
    }

    Ok(AuthSession {
        cookie: cookie.to_string(),
        uname: payload["data"]["uname"]
            .as_str()
            .unwrap_or("Bilibili 用户")
            .to_string(),
        user_mid: payload["data"]["mid"].as_u64().unwrap_or_default(),
        face: payload["data"]["face"].as_str().unwrap_or_default().to_string(),
    })
}

async fn store_auth_session(state: &AppState, session: &AuthSession) {
    {
        let mut auth = state.auth_session.write().await;
        *auth = Some(session.clone());
    }

    if let Ok(text) = serde_json::to_string(session) {
        let _ = fs::write(state.auth_file.as_ref(), text);
    }
}

fn strip_html(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_tag = false;

    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }

    output.trim().to_string()
}

fn parse_duration_to_seconds(value: &str) -> u64 {
    let parts = value
        .split(':')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();

    match parts.as_slice() {
        [hours, minutes, seconds] => hours * 3600 + minutes * 60 + seconds,
        [minutes, seconds] => minutes * 60 + seconds,
        [seconds] => *seconds,
        _ => 0,
    }
}

fn format_seconds(total_seconds: u64) -> String {
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn format_publish_date(timestamp: i64) -> String {
    if timestamp <= 0 {
        return String::new();
    }

    chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
        .map(|value| value.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn compute_page_count(total: usize, page_size: usize) -> u32 {
    if total == 0 || page_size == 0 {
        return 1;
    }

    total.div_ceil(page_size) as u32
}

fn auth_status_from_session(session: Option<AuthSession>) -> AuthStatusResponse {
    AuthStatusResponse {
        logged_in: session.is_some(),
        user: session.map(|session| AuthUser {
            uname: session.uname,
            user_mid: session.user_mid,
            avatar: session.face,
        }),
    }
}

fn load_auth_session(path: &PathBuf) -> Option<AuthSession> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<AuthSession>(&content).ok())
}

fn extract_cookie_string(headers: &reqwest::header::HeaderMap, success_url: Option<&str>) -> String {
    let mut values = headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if let Some(url) = success_url {
        for key in ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"] {
            if let Some(value) = find_query_value(url, key) {
                values.push(format!("{key}={value}"));
            }
        }
    }

    values.sort();
    values.dedup();
    values.join("; ")
}

fn find_query_value(url: &str, key: &str) -> Option<String> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let current_key = parts.next()?;
        let current_value = parts.next().unwrap_or_default();
        if current_key == key {
            return Some(current_value.to_string());
        }
    }
    None
}

fn extract_wbi_key(url: &str) -> String {
    url.split('/')
        .last()
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn sign_wbi(params: Vec<(String, String)>, img_key: &str, sub_key: &str) -> String {
    let mixin_source = format!("{img_key}{sub_key}");
    let mixin_key = WBI_MIXIN_KEY_ENC_TAB
        .iter()
        .filter_map(|index| mixin_source.chars().nth(*index))
        .take(32)
        .collect::<String>();

    let mut query_items = params;
    query_items.push((
        "wts".to_string(),
        chrono::Utc::now().timestamp().to_string(),
    ));
    query_items.sort_by(|left, right| left.0.cmp(&right.0));

    let query = query_items
        .iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                urlencoding::encode(key),
                urlencoding::encode(&value.replace(['!', '\'', '(', ')', '*'], ""))
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    let digest = format!("{:x}", md5::compute(format!("{query}{mixin_key}")));
    format!("{query}&w_rid={digest}")
}
