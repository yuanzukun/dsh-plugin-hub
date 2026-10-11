# DSH 插件目录（dsh-plugin-hub）

把 GitHub + npm 上的 DeepSeek Harness（dsh）插件抓取下来，做成**可搜索、有中文介绍、一键复制安装命令**的静态站点。每日自动更新。

- **单一数据源**（2026-10-11 统一管线）：`cards-snapshot.json`（市场口径：官方 `topic:dsh-plugin` + `dsh.bundle` 硬门禁 + 一仓一卡）是唯一抓取产物；hub 网页的 `plugins.json` 由它富化生成（分类 + 中文 + 策展），不再自建抓取管线
- 自动抓取数据 与 人工策展（`data/overrides.json`）严格分离：重跑抓取永远冲不掉你的分类/中文
- 中文简介：优先继承快照的 `description_zh`（CI 集中翻译，零成本）→ `tx-cache.json` 命中 → Agnes 兜底翻译（限量且回写缓存）

## 本地开发

```bash
node scripts/fetch-cards-snapshot.mjs   # 全量/增量构建市场快照（约 12 分钟起；有缓存则分钟级）
node fetch.mjs                          # 消费快照生成 public/plugins.json（分类+中文+策展）
npm run serve                           # 本地预览 http://localhost:4173
```

> 前端用 `fetch()` 加载 `plugins.json`，必须经 http 打开（`npm run serve`），直接双击 `index.html` 会被浏览器 CORS 拦住。

## 每日自动更新（GitHub Actions 生产 + Gitee Pages 部署）

数据生产已**收口到 GitHub Actions 一条流水线**（每日北京时间 02:30 / 14:30）：
快照构建 → 描述集中翻译 → hub 目录生成 → 提交回 master → 清除 jsDelivr CDN 缓存。
Gitee 侧每日 09:30 的流水线只做 **GitHub → Gitee 镜像同步**（不再自行构建，消除双 CI 对 plugins.json 的互相覆盖），Gitee Pages 随之重建。

### 1. 建仓库并推送

```bash
git init
git add .
git commit -m "init dsh-plugin-hub"
git remote add origin git@github.com:yuanzukun/dsh-plugin-hub.git
git push -u origin master
```

### 2. Gitee Pages（部署侧）

Gitee 仓库 → **服务 → Gitee Pages** → 部署分支 `master`，部署目录 `public` → 启动（建议开启自动部署）。
站点地址：`https://<命名空间>.gitee.io/<仓库名>`

### 3. GitHub Actions（生产侧）

仓库 → **Settings → Secrets → Actions**，配置：

| 变量名 | 说明 | 示例 |
|---|---|---|
| `AGNES_API_KEY` | Agnes AI 密钥（快照描述集中翻译 + hub 兜底翻译；不配则只输出英文） | `sk-xxxx` |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（翻译通道首选，优先于 Agnes；可选） | `sk-xxxx` |

> `GITHUB_TOKEN` 由 Actions 自动提供，无需配置。

### 4. Gitee Go（镜像侧）

Gitee 仓库 → **服务 → Gitee Go** → 启用 `.gitee/workflows/dsh-hub.yml`（每日 09:30 把 GitHub master 同步过来），并在流水线变量里配置 `PUSH_URL`（带令牌的 Gitee 推送地址）。

## 市场快照（cards-snapshot.json，供 dsh-plugin-cards 内置市场消费）

由 GitHub Actions `daily-snapshot.yml` 每日两次（北京时间 02:30 / 14:30，GitHub 常延迟数小时）自动构建并提交回 master，jsDelivr（@master）自动生效（分支缓存约 12h）：

- 口径：`topic:dsh-plugin`（★ 不限 + 近 12 个月 + 含 dsh，完整覆盖官方 topic 页）+ npm `keywords:dsh-plugin` 双源归并
- **一仓一卡去重（1.4.2）**：仓库有 npm 包卡时不再输出 gh 裸卡（此前 16422 条中 2709 仓重复，dsh-market 一仓 4 卡占据 Top10 四席）；monorepo 多包仍各占一卡（每包=独立可装单元）
- **增量构建（1.4.0）**：默认自动模式 —— 周日(UTC)/状态缺失/状态>6 天跑全量，其余每日只收割 `pushed:>=上次构建−12h` 的增量（基线=上次快照，缓存回种免冷探），CI 从 12~180 分钟降到分钟级；收割为 0 时中止不发布。显式指定用 `--full` / `--incremental`
- **npm 深分页修复（1.4.1）**：npmjs search 的 `from+size` 上限 ≈5250，超过回绕开头（尾段包静默丢失）——连续 2 页无新包即转 npmmirror 深分页补尾（镜像仅支持纯文本，客户端按 `keywords=dsh-plugin` 过滤，npm 源 5250→6924 条）；search 429 不再切镜像（镜像不解析 `keywords:` 限定符会静默归零）；探测 git 通道 3 次 + 指数退避
- 分层合规快筛（schema v3）：`dsh.bundle` 硬门禁（installable）→ `dsh.engine` 与桌面端 0.2.0-rc.2 semver 兼容判定（engineCompat，非法 range 一律不判不兼容）→ 展示三件套 metaScore（仅排序）
- 借星防护：npm 条目仅当 repository 指向 topic 收割到的仓库才合并富化；宿主本体仓（deepseek-ai/deepseek-harness）不借星
- 手动重建：`node scripts/fetch-cards-snapshot.mjs`（全量，约 12 分钟起）或 `--skip-probe` 快速刷新；`workflow_dispatch` 可在 GitHub Actions 页手动触发云端构建

## 文件结构

```
fetch.mjs                  hub 目录生成（消费 cards-snapshot.json：分类 + 中文继承 + 策展合并，零依赖，Node 20+）
scripts/fetch-cards-snapshot.mjs   市场快照构建（双源发现 + 分层合规快筛 + 一仓一卡去重，schema v3）
scripts/translate-snapshot.mjs     快照描述集中翻译（description_zh，tx-cache 持久化）
data/overrides.json        人工策展区：分类/中文名/安装命令修正（重跑不丢）
data/tx-cache.json         翻译持久缓存（sha1(描述) → 中文，fetch.mjs 与 translate-snapshot 共享）
data/seed.json             离线兜底种子
data/probe-cache.json      快筛断点缓存（schema v2，7 天有效，随 master 提交）
public/index.html          前端（搜索/分类/排序/复制安装命令，分页 60/页）
public/app.js
public/style.css
public/plugins.json        hub 目录数据（由快照富化生成，被 Gitee Pages 托管）
public/cards-snapshot.json 市场快照（dsh-plugin-cards 客户端 SNAPSHOT_URLS 主源）
.github/workflows/daily-snapshot.yml   GitHub Actions 每日两次（北京 02:30/14:30）：快照 → 翻译 → hub 目录 → 提交 → CDN purge
.gitee/workflows/dsh-hub.yml           Gitee Go 每日 09:30：GitHub → Gitee 镜像同步（供 Pages 部署，不构建）
```

## 加新插件 / 改分类

- 自动：npm/GitHub 上带 `dsh-plugin` 标签的包会被快照管线自动抓到（market 口径要求声明 `dsh.bundle`）。
- 手动策展：编辑 `data/overrides.json`，键为 `owner/repo`（GitHub）或 npm 包名：

```json
"liustack/modlens": {
  "category": "工具与能力",
  "zh": "DSH 首个视觉插件……"
}
```
