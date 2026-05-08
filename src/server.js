import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  batchUpdateStatus,
  clearAuth,
  getSnapshot,
  pickConfirmedCandidatesForApply,
  readDb,
  replaceDb,
  saveAuth,
  saveConfig,
  updateCandidateStatus
} from './store.js'
import { applyConfirmedCandidates, collectCandidates } from './automation/adapter.js'
import { applyConfirmedCandidatesGeekStyle } from './automation/adapterGeek.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const publicDir = path.join(rootDir, 'public')
const port = Number(process.env.PORT || 4173)

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    await serveStatic(url.pathname, res)
  } catch (error) {
    sendJson(res, 500, { error: error.message })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`海投助手 Next 已启动: http://127.0.0.1:${port}`)
})

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    sendJson(res, 200, await getSnapshot())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const body = await readBody(req)
    sendJson(res, 200, { config: await saveConfig(body) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/auth') {
    const body = await readBody(req)
    sendJson(res, 200, { auth: await saveAuth(body) })
    return
  }

  if (req.method === 'DELETE' && url.pathname === '/api/auth') {
    sendJson(res, 200, { auth: await clearAuth() })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/collect') {
    const db = await readDb()
    sendJson(res, 200, { candidates: await collectCandidates(db.config) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const body = await readBody(req)
    const db = await readDb()
    const limit = db.config.dailyApplyLimit || 30
    const candidateIds = normalizeCandidateIds(body?.candidateIds)
    const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)
    if (!confirmed.length) {
      sendJson(res, 400, {
        error: candidateIds?.length
          ? '所选候选中没有仍处于「已确认」状态的职位，请刷新页面后重试'
          : '没有已确认的职位可以投递'
      })
      return
    }

    applyConfirmedCandidates(limit, candidateIds).catch((error) => {
      console.error('投递任务失败:', error)
    })

    sendJson(res, 200, {
      mode: 'semi-auto',
      message: `投递任务已启动，将按候选确认顺序处理 ${confirmed.length} 个职位（本轮上限 ${limit}）`,
      count: confirmed.length
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/apply-original') {
    const body = await readBody(req)
    const db = await readDb()
    const limit = db.config.dailyApplyLimit || 30
    const candidateIds = normalizeCandidateIds(body?.candidateIds)
    const confirmed = pickConfirmedCandidatesForApply(db, candidateIds, limit)
    if (!confirmed.length) {
      sendJson(res, 400, {
        error: candidateIds?.length
          ? '所选候选中没有仍处于「已确认」状态的职位，请刷新页面后重试'
          : '没有已确认的职位可以投递'
      })
      return
    }

    applyConfirmedCandidatesGeekStyle(limit, candidateIds).catch((error) => {
      console.error('Geek风格投递任务失败:', error)
    })

    sendJson(res, 200, {
      mode: 'geek-style',
      message: `Geek 反检测策略投递已启动，将按候选确认顺序处理 ${confirmed.length} 个职位（本轮上限 ${limit}）`,
      count: confirmed.length
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/capture') {
    // 异步执行 Cookie 捕获
    const { captureCookies } = await import('./automation/captureCookies.js')
    captureCookies().catch((error) => {
      console.error('Cookie 捕获失败:', error)
    })
    sendJson(res, 200, { message: '浏览器已打开，请在浏览器中登录 BOSS 直聘，登录成功后 Cookie 会自动保存' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/candidate/open-url') {
    const id = url.searchParams.get('id')
    const db = await readDb()
    const candidate = db.candidates.find((item) => item.id === id)
    if (!candidate) {
      sendJson(res, 404, { error: '候选职位不存在' })
      return
    }
    const encryptJobId = candidate.raw?.encryptJobId ?? candidate.sourceId?.replace(/^boss-/, '')
    sendJson(res, 200, {
      url: encryptJobId ? `https://www.zhipin.com/job_detail/${encryptJobId}.html` : null
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/candidate/status') {
    const body = await readBody(req)
    sendJson(res, 200, { candidate: await updateCandidateStatus(body.id, body.status) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/candidates/status') {
    const body = await readBody(req)
    sendJson(res, 200, await batchUpdateStatus(body.ids ?? [], body.status))
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/export') {
    sendJson(res, 200, await readDb())
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readBody(req)
    sendJson(res, 200, await replaceDb(body))
    return
  }

  sendJson(res, 404, { error: 'API not found' })
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(publicDir, safePath))
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return
  }
  try {
    const content = await fs.readFile(filePath)
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] ?? 'application/octet-stream' })
    res.end(content)
  } catch {
    const content = await fs.readFile(path.join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': mime['.html'] })
    res.end(content)
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** @param {unknown} raw */
function normalizeCandidateIds(raw) {
  if (!Array.isArray(raw)) return null
  const ids = raw.map((id) => String(id).trim()).filter(Boolean)
  return ids.length ? ids : null
}
