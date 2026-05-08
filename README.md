# Haitou Assistant Next

[中文项目说明 / 使用指南入口 → README-CN.md](README-CN.md)

A local web dashboard for BOSS Zhipin job search: collect (or seed) candidates, confirm manually, then run browser automation for chat/apply flows. Credentials and data stay under **`data/`** on your machine—do not commit `db.json` to a public repo.

## Quick start

- **Node.js ≥ 20**
- From the repo root:

```bash
npm install
npm start
```

Open **http://127.0.0.1:4173** in your browser (change port with `PORT`). The server binds to **127.0.0.1** by default (local only).

## How to use the frontend

- The UI is **static files** in **`public/`** (`index.html`, `app.js`, `styles.css`). There is **no** separate frontend build (`npm run build`); **`npm start`** runs `src/server.js`, which serves `public/` and **`/api/*`** on the same origin so the page can call the API.
- **Steps:** (1) Run `npm start` (2) Open the printed URL in Chrome / Edge / Firefox / Safari (3) Use the left sidebar: Dashboard, BOSS auth, Config, Candidates, Logs; use the bottom buttons for **Collect**, **Apply confirmed**, **Geek-style apply**.
- Full Chinese walkthrough: **[docs/使用指南.md](docs/使用指南.md)** (section **2.1** for frontend details).

## Docs

- **[docs/使用指南.md](docs/使用指南.md)** — full usage (workflow, config, env vars, FAQ).

## Repository notes

- **laodeng** anti-detect plugin is vendored under **`vendor/laodeng`** (upstream: [GeekGeekRun](https://github.com/geekgeekrun)). `npm install` is enough after clone.
- See **`.gitignore`** for local-only paths (e.g. `data/db.json`).

## Push to GitHub

1. Create a **new empty** repository on GitHub (omit auto-generated README if you already have one locally).
2. In the project root:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Use your real URL; use `master` instead of `main` if that is your default branch. For SSH: `git@github.com:<you>/<repo>.git`.

Later updates: `git add . && git commit -m "..." && git push`.

**Before pushing:** confirm no secrets (cookies, tokens) are tracked—`data/db.json` should remain ignored.
