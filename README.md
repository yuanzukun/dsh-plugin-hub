# DSH 插件目录（dsh-plugin-hub）

把 GitHub + npm 上的 DeepSeek Harness（dsh）插件抓取下来，做成**可搜索、有中文介绍、一键复制安装命令**的静态站点。每日自动更新。

- 数据源：GitHub `topic:dsh-plugin` + npm `keywords:dsh-plugin`（npm 为主力，量大）
- 自动抓取数据 与 人工策展（`data/overrides.json`）严格分离：重跑抓取永远冲不掉你的分类/中文
- 中文简介：有 Agnes Key 时自动翻译，否则回退到你写的策展

## 本地开发

```bash
node fetch.mjs              # 重新抓取并生成 public/plugins.json
npm run serve              # 本地预览 http://localhost:4173
```

> 前端用 `fetch()` 加载 `plugins.json`，必须经 http 打开（`npm run serve`），直接双击 `index.html` 会被浏览器 CORS 拦住。

## 每日自动更新（Gitee Pages + Gitee Go）

整条链路无人值守：Gitee Go 定时跑 `fetch.mjs` → 提交新 `plugins.json` → Gitee Pages 自动重建。

### 1. 建仓库并推送

```bash
git init
git add .
git commit -m "init dsh-plugin-hub"
git remote add origin https://gitee.com/<命名空间>/<仓库名>.git
git push -u origin master
```

### 2. 开启 Gitee Pages

仓库 → **服务 → Gitee Pages** → 部署分支 `master`，部署目录 `public` → **启动**。
（若页面没随推送刷新，在 Pages 设置里开启「自动部署」，或每次手动点「更新」。）

站点地址：`https://<命名空间>.gitee.io/<仓库名>`

### 3. 开启 Gitee Go 定时流水线

仓库 → **服务 → Gitee Go** → 新建流水线，选择仓库里的 `.gitee/workflows/dsh-hub.yml` → 保存并启用「定时触发」。
流水线每天**北京时间 09:00** 执行。

### 4. 配置 3 个密钥（仓库 → 流水线 → 变量/密钥）

| 变量名 | 说明 | 示例 |
|---|---|---|
| `AGNES_KEY` | Agnes AI 密钥（用于自动翻译新插件中文） | `sk-xxxx` |
| `GITHUB_TOKEN` | GitHub token，提高 API 限额（可选，匿名也能跑） | `ghp_xxxx` |
| `PUSH_URL` | 带令牌的推送地址，流水线用它提交 | `https://<令牌>@gitee.com/<命名空间>/<仓库名>.git` |

> 没有 Agnes Key 也能跑：只是新插件没有自动中文，已有的中文来自 `data/overrides.json` 策展。

## 文件结构

```
fetch.mjs                  抓取 + 过滤 + 翻译 + 合并脚本（零依赖，Node 20+）
data/overrides.json        人工策展区：分类/中文名/安装命令修正（重跑不丢）
data/seed.json             离线兜底种子（实时抓取失败时回退）
public/index.html          前端（搜索/分类/排序/复制安装命令，分页 60/页）
public/app.js
public/style.css
public/plugins.json        生成的数据（被 Gitee Pages 托管）
.gitee/workflows/dsh-hub.yml   Gitee Go 每日定时流水线
```

## 加新插件 / 改分类

- 自动：npm/GitHub 上带 `dsh-plugin` 标签的包会被自动抓到。
- 手动策展：编辑 `data/overrides.json`，键为 `owner/repo`（GitHub）或 npm 包名（npm 独立插件）：

```json
"liustack/modlens": {
  "category": "工具与能力",
  "zh": "DSH 首个视觉插件……"
}
```
