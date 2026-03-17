# Zi Music

一个基于 Bilibili 歌曲视频资源的极简听歌应用 MVP，现已切换为 `Tauri + React` 桌面方案。

## 1. 产品功能拆解

### 核心功能

- 关键词搜索：支持歌曲名、歌手名、专辑名、风格词。
- 搜索结果列表：只展示标题、UP 主、时长、播放量、BV 号。
- 纯音频播放：点击后进入播放，不展示视频画面。
- 基础播放器：播放/暂停、进度条、音量、上一首/下一首。

### 非目标

- 不做登录注册。
- 不做评论、弹幕、社交。
- 不做封面墙、推荐流、复杂歌单。
- 不做下载。
- 不做歌词。

## 2. 页面结构设计

### 页面 1：主页面

- 顶部：应用名、简短说明。
- 搜索区：输入框、搜索按钮。
- 结果区：纯文本列表。
- 底部：固定播放器。

### 页面交互

- 输入关键词后点击搜索。
- 列表项点击后立即开始播放。
- 当前播放项高亮。
- 上一首/下一首在当前搜索结果集内切换。

## 3. 技术架构图（文字）

- 前端：React + Vite
  - 负责搜索输入、结果列表、播放器 UI。
  - 在浏览器模式下通过 Vite 代理访问 `/api/*`。
  - 在桌面模式下直接访问本地 `http://127.0.0.1:3001/api/*`。
- 桌面端：Tauri
  - 负责窗口管理、资源打包、生成 Windows 安装包。
- 本地后端：Rust + Axum
  - 负责调用 Bilibili Web 接口。
  - 负责 WBI 签名。
  - 负责拿到视频 cid 和 playurl。
  - 负责把音频流代理成本地 `/api/stream/:bvid`。
- Bilibili：
  - 搜索接口返回视频结果。
  - view 接口返回分 P/cid 信息。
  - playurl 接口返回 DASH 音频流地址。

请求链路：

1. 前端调用 `/api/search?q=关键词`
2. 后端请求 Bilibili 搜索接口并清洗数据
3. 用户点击结果，前端设置音频源为 `/api/stream/:bvid`
4. 后端请求 Bilibili playurl，选出音频流 URL
5. 后端代理音频字节流给浏览器播放

## 4. 前后端技术栈建议

### 前端

- React
- Vite
- 原生 CSS
- HTMLAudioElement

原因：启动快、依赖少、做 MVP 成本最低。

### 桌面端 / 本地后端

- Tauri
- Rust
- Axum
- Reqwest

原因：相对 Electron 更轻，生成的 Windows 安装包体积更小，更适合“小而美的软件”目标。

## 5. 如何搜索 Bilibili 视频

MVP 方案使用 Bilibili Web 搜索接口：

- 先请求 `https://api.bilibili.com/x/web-interface/nav`
- 从返回值中取 `wbi_img.img_url` 和 `sub_url`
- 根据 WBI 规则生成签名
- 再调用 `x/web-interface/wbi/search/type`

搜索参数核心字段：

- `keyword`
- `search_type=video`
- `page`

## 6. 如何获取可播放的音频流

MVP 链路：

1. 调 `x/web-interface/view?bvid=xxx` 获取 `cid`
2. 调 `x/player/playurl?bvid=xxx&cid=xxx&fnval=16&qn=64`
3. 从 `dash.audio` 中取第一条或最高带宽音频流
4. 后端代理这个音频 URL 给前端

## 7. 如何只播放音频不显示视频

- 前端只创建 `<audio>` 元素，不渲染 `<video>`。
- 后端返回的是音频流代理地址，不给前端视频地址。
- 播放器 UI 只保留音乐控制条。

## 8. 跨域、接口限制、签名与解析问题

### 跨域

- 浏览器不直接请求 Bilibili API。
- 全部走本站后端 `/api/*`，规避前端跨域。

### 接口限制

- 搜索接口需要 WBI 签名。
- 音频地址会过期，所以不能长期缓存为静态 URL。

### 解析问题

- Bilibili 返回的标题可能带 HTML 高亮标签，后端已清洗。
- 音频流一般是 DASH `audio/mp4`，浏览器可直接播放。

### Referer / Header

- 代理流时后端补上常见浏览器 `User-Agent` 与 `Referer`。

## 9. 核心接口设计

### `GET /api/health`

返回服务健康状态。

### `GET /api/search?q=xxx&page=1`

返回：

```json
{
  "query": "周杰伦 稻香",
  "page": 1,
  "pageSize": 20,
  "total": 1000,
  "items": [
    {
      "id": "BV11k4y1G7WH",
      "bvid": "BV11k4y1G7WH",
      "aid": 743821456,
      "title": "大爱这首卡点神曲《Teeth》！",
      "uploader": "云端音乐铺",
      "duration": "03:25",
      "durationSeconds": 205,
      "playCount": 5296251,
      "description": "侵删~"
    }
  ]
}
```

### `GET /api/tracks/:bvid`

返回单条可播放信息：

```json
{
  "bvid": "BV11k4y1G7WH",
  "cid": 1209336843,
  "title": "大爱这首卡点神曲《Teeth》！",
  "uploader": "云端音乐铺",
  "durationSeconds": 205,
  "streamUrl": "/api/stream/BV11k4y1G7WH"
}
```

### `GET /api/stream/:bvid`

- 支持 `Range` 请求
- 返回 `audio/mp4`
- 用于 `<audio>` 播放

## 10. 数据结构设计

### SearchItem

```ts
type SearchItem = {
  id: string;
  bvid: string;
  aid: number;
  title: string;
  uploader: string;
  duration: string;
  durationSeconds: number;
  playCount: number;
  description: string;
};
```

### Track

```ts
type Track = {
  bvid: string;
  cid: number;
  title: string;
  uploader: string;
  durationSeconds: number;
  audioUrl?: string;
  streamUrl: string;
};
```

## 11. 开发步骤拆解

1. 初始化前后端脚手架。
2. 打通 Bilibili 搜索接口。
3. 打通 view + playurl 获取音频信息。
4. 实现音频代理流。
5. 完成极简搜索页和播放器。
6. 补基础错误处理与空状态。
7. 做本地联调与构建验证。

## 12. MVP 优先级

### P0

- 搜索
- 列表展示
- 点击播放
- 播放/暂停
- 进度条
- 音量

### P1

- 上一首/下一首
- 当前播放高亮
- 简单的播放状态提示

### P2

- 历史记录
- 收藏
- 简单歌词
- 更智能的排序策略

## 13. 风险点与规避建议

### 平台规则 / 合规风险

- 该产品依赖 Bilibili 非官方公开 Web 接口，接口规则可能变化。
- 歌曲内容可能涉及版权，做“聚合播放”存在版权与平台条款风险。
- 若公开商用，风险显著高于个人学习或内部原型验证。

建议：

- 明确仅作学习 / 内部原型验证。
- 不做下载、不做缓存分发、不做批量镜像。
- 增加“内容来源于 Bilibili，仅作索引与播放代理”的声明。
- 上线前补法务与平台条款评估。

### 技术风险

- WBI 算法和接口字段可能调整。
- 某些视频可能无音频流、需登录、需会员或被风控。
- 音频直链有时效，必须动态获取。

建议：

- 后端集中封装 BilibiliProvider，便于统一维护。
- 对错误结果做降级提示。
- 保持代理层无状态，方便后续替换数据源。

## 14. 可扩展架构建议

后续把当前后端抽象成 Provider 模式：

- `providers/bilibili.js`
- `providers/youtube.js`
- `providers/local.js`

统一接口：

- `search(query, page)`
- `getTrack(bvid)`
- `getAudioStream(bvid, range)`

这样未来即使 Bilibili 接口变化，也只改 Provider 层。

## 15. 运行方式

```bash
npm install
npm run install:all
```

开发环境：

- 浏览器模式：`npm run dev:web`
- 桌面模式：`npm run dev:app`

桌面安装包构建：

```bash
npm run build:app
```

Windows 安装包输出：

- `src-tauri/target/release/bundle/nsis/Zi Music_0.1.0_x64-setup.exe`

当前构建结果参考：

- Tauri 主程序 `zi-music.exe` 约 `12 MB`
- Windows 安装包约 `3 MB`
