# 半自动海投助手（海投助手 Next）

本地运行的 **BOSS 直聘** 求职工作台：采集（或模拟）候选 → 人工确认 → 浏览器自动化协助开聊/投递。**数据与 Cookie 仅存本机 `data/`**，请勿将 `db.json` 推送到公开仓库。

**完整使用手册：** [docs/使用指南.md](docs/使用指南.md)

---

## 快速开始

- 环境：**Node.js ≥ 20**

```bash
npm install
npm start
```

浏览器打开 **http://127.0.0.1:4173**（端口可用环境变量 `PORT` 修改）。

---

## 前端如何使用

1. **先启后端（含静态前端）**  
   在仓库根目录执行 `npm install`、`npm start`。前端没有单独的打包命令，由 `src/server.js` 托管 `public/` 并提供 API。

2. **用浏览器打开**  
   默认地址：**http://127.0.0.1:4173**（仅本机；端口可用环境变量 `PORT` 修改）。

3. **界面布局**  
   - **左侧**：五个视图——数据看板、BOSS 登录态、投递配置、候选确认、运行日志。  
   - **左下角**：主操作——**开始采集**、**投递已确认**、**原始风格**（Geek 反检测策略投递）。  
   - **右侧**：当前视图内容；顶栏可导出/导入整库 JSON。

4. **典型顺序**  
   投递配置保存 → BOSS 登录态保存 Cookie（可选 LocalStorage）→ 开始采集 → 候选确认里「确认」职位 → 点「投递已确认」或「原始风格」→ 在「运行日志」看进度；列表状态会自动从「已确认」变为「已投递」。

更细的字段说明、环境变量与排错见 **[docs/使用指南.md](docs/使用指南.md)**（其中 **§2.1** 为前端使用详解）。

---

## 上传到 GitHub

### 1. 在 GitHub 上新建仓库

1. 登录 GitHub → **Repositories** → **New**。  
2. 填写仓库名，选 Public / Private。  
3. **不要**勾选「Add a README」等自动生成文件（若你本地已有完整项目，避免首次推送冲突）。  
4. 创建后记下远端地址，例如：  
   `https://github.com/<你的用户名>/<仓库名>.git`

### 2. 本地推送（首次）

在**项目根目录**执行：

```bash
git init
git add .
git commit -m "Initial commit: 海投助手 Next"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

若远程默认分支是 `master`，把上面 `main` 改成 `master`，或与 GitHub 仓库设置保持一致。

使用 SSH：

```bash
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

### 3. 后续更新

```bash
git add .
git commit -m "描述本次修改"
git push
```

### 4. 提交前请注意

- `.gitignore` 已忽略 `node_modules/`、`data/db.json`、`data/captures/` 等，**不要将真实 Cookie 与隐私数据提交上去**。  
- 若误提交过敏感文件，需从 Git 历史中清除（可用 `git filter-repo` 等工具），并轮换 Cookie。

---

## 仓库说明

- 反检测插件 **laodeng** 位于 **`vendor/laodeng`**（来源于 [GeekGeekRun](https://github.com/geekgeekrun) 同名包），克隆后执行 `npm install` 即可。  
- 个人数据路径见 `.gitignore`（如 `data/db.json`）。

---

## 当前能力概览

| 能力 | 说明 |
|------|------|
| 职位采集 | 依赖配置与当前实现的 BOSS 接口/逻辑 |
| 筛选 | 关键词、城市、薪资、排除词、公司黑名单等 |
| 候选管理 | 确认 / 拒绝 / 状态筛选 / 打开职位链接 |
| 自动化投递 | 「投递已确认」与「原始风格」两套策略；后者更接近 GeekGeekRun 反检测栈 |
| 数据看板与日志 | 本地统计与最近日志 |

BOSS 侧有风控与频率限制，请合理使用；详见 [docs/使用指南.md](docs/使用指南.md) 合规提示。

---

## 技术栈（实际实现）

| 项目 | 说明 |
|------|------|
| 运行时 | Node.js **≥ 20** |
| 后端 | 内置 `http` 模块，`src/server.js` |
| 前端 | `public/` 静态资源，**原生 JavaScript**（`app.js` 为 ES Module） |
| 数据 | `data/db.json`（首次运行自动创建） |
| 自动化 | Puppeteer、`puppeteer-extra`（stealth、laodeng、anonymize-ua 等） |

---

## 注意事项

1. 控制投递频率，避免短时间大量请求触发风控。  
2. Cookie 会过期，失效后需重新导出并在「BOSS 登录态」保存。  
3. 遇安全验证通常需在真实浏览器或自动化窗口内人工完成后再继续。
