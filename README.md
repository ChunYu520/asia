# B站视频直链解析 Worker

Cloudflare Worker 版 B 站视频解析服务，利用 CF IP 绕过服务器风控，直接返回视频直链（302 跳转）。

---

## 快速部署（网页版，最简单）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 左侧菜单 → **Workers & Pages** → **Create Application**
3. 选择 **Create Worker**，名字随意（如 `bilibili-proxy`），点 **Deploy**
4. 部署成功后点 **Edit Code**
5. 把 `bilibili-proxy.js` 的内容**全部粘贴**覆盖默认代码
6. 点 **Save and Deploy**

部署完成后会得到一个地址：`https://bilibili-proxy.<你的子域名>.workers.dev`

---

## 接口说明

部署后的基地址：`https://你的worker名称.你的账号.workers.dev`

### `GET /bili?id=xxx` — 主接口，302 跳转到视频直链

| 参数 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | BV 号 / B 站完整链接 / b23.tv 短链 |
| `p` | ❌ | 分 P 编号，默认 1 |
| `provider` | ❌ | 强制指定解析源：`official` / `injahow`，不填则自动轮换 |

示例：
```
# BV 号
https://xxx.workers.dev/bili?id=BV1X163BQEo8

# 带分P
https://xxx.workers.dev/bili?id=BV1X163BQEo8&p=2

# b23.tv 短链（Worker 会自动跟随重定向提取 BV 号）
https://xxx.workers.dev/bili?id=https://b23.tv/xxxxx

# 强制用官方源
https://xxx.workers.dev/bili?id=BV1X163BQEo8&provider=official
```

### `GET /resolve?id=xxx` — 只解析 BV 号，不跳转

返回 JSON：`{ "bv": "BV1X163BQEo8", "part": 1 }`

### `GET /health` — 健康检查

### `GET /stats` — 统计信息

---

## 自定义域名（可选）

如果想用 `bili.yuki-can.asia` 这样的地址：

1. Cloudflare Dashboard → Workers & Pages → 你的 Worker
2. **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**
3. 填入你想绑定的域名（需解析在 Cloudflare）
4. 等 DNS 生效即可

---

## 环境变量（可选，提高画质）

在 Worker Settings → Variables → Environment Variables 里添加：

| 变量名 | 说明 |
|--------|------|
| `BILI_SESSDATA` | B 站登录 Cookie 里的 SESSDATA（提高可用画质上限） |
| `BILI_BILI_JCT` | B 站登录 Cookie 里的 bili_jct（配合 SESSDATA 使用） |

如何获取：登录 bilibili.com → F12 → Application → Cookies → 复制对应值

---

## 与原 Flask 服务的关系

部署 Worker 后，可以：

1. **完全替代**：让 `vrc.yuki-can.top/api/bili` 的 nginx 反代指向 Worker 地址
2. **并存**：前端生成短链时直接用 Worker 地址，不经过 Flask

推荐方案 2，最简单——更新 `vrc.yuki-can.top` 前端的"提取"逻辑，
把生成的 URL 从 `https://vrc.yuki-can.top/api/bili?id=xxx`
改成 `https://你的worker.workers.dev/bili?id=xxx`

---

## 故障排查

| 现象 | 原因 | 解法 |
|------|------|------|
| 返回 503，所有源失败 | injahow 受限 + 官方 API 也失败 | 配置 BILI_SESSDATA 环境变量 |
| b23.tv 短链解析失败 | Worker fetch 被重定向拦 | 检查短链是否有效，或手动填 BV 号 |
| 画质很低（480p） | 未登录，官方 API 只返回低画质 | 配置 BILI_SESSDATA |
