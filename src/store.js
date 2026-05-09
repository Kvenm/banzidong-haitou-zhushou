import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const dataDir = path.join(rootDir, 'data')
const dbPath = path.join(dataDir, 'db.json')

const defaultConfig = {
  keywords: ['前端', 'Vue', 'React'],
  cities: ['北京', '上海', '深圳', '杭州'],
  salaryMin: 15,
  salaryMax: 35,
  experience: '3-5年',
  excludeKeywords: ['外包', '驻场', '销售'],
  blacklistCompanies: [],
  greetingTemplates: [
    '您好，我对贵司的{职位名称}很感兴趣，我有相关经验，希望可以进一步沟通。',
    '您好，看到贵司{公司名称}正在招聘{职位名称}，岗位方向和我的经历比较匹配，方便进一步了解吗？'
  ],
  dailyApplyLimit: 30
}

const defaultDb = {
  config: defaultConfig,
  auth: {
    bossCookieJson: '',
    bossLocalStorageJson: '',
    savedAt: null,
    lastCheckAt: null,
    lastCheckResult: null
  },
  candidates: [],
  logs: [],
  meta: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** 已投递 / 已回复 / 已拒绝 的 BOSS 职位 sourceId，持久化便于日后删行后仍不重复采集 */
    excludedSourceIds: []
  }
}

async function ensureDb() {
  await fs.mkdir(dataDir, { recursive: true })
  try {
    await fs.access(dbPath)
  } catch {
    await fs.writeFile(dbPath, JSON.stringify(defaultDb, null, 2))
  }
}

export async function readDb() {
  await ensureDb()
  const raw = await fs.readFile(dbPath, 'utf8')
  return JSON.parse(raw)
}

/**
 * 解析本批要投递的「已确认」候选：优先使用前端候选确认页传来的 id 顺序，与界面一致。
 * @param {object} db - readDb() 的结果
 * @param {string[]|null|undefined} candidateIds - 界面当前快照中的已确认 id；为空则使用库内全部 confirmed（按 candidates 数组顺序）
 * @param {number} limit - 本批最多条数
 */
export function pickConfirmedCandidatesForApply(db, candidateIds, limit) {
  const cap = Math.max(0, Number(limit) || 30)
  const list = db.candidates ?? []
  const byId = new Map(list.map((c) => [c.id, c]))

  if (candidateIds?.length) {
    const out = []
    for (const id of candidateIds) {
      const c = byId.get(id)
      if (c?.status === 'confirmed') out.push(c)
    }
    return out.slice(0, cap)
  }

  return list.filter((item) => item.status === 'confirmed').slice(0, cap)
}

/**
 * 采集时跳过的 BOSS/mock 职位 id：历史排除表 + 当前库内已终态职位
 * @param {object} db
 * @returns {Set<string>}
 */
export function getBlockedSourceIdsForCollect(db) {
  const blocked = new Set()
  for (const id of db.meta?.excludedSourceIds ?? []) {
    if (id) blocked.add(String(id))
  }
  for (const c of db.candidates ?? []) {
    if (['applied', 'replied', 'rejected'].includes(c.status) && c.sourceId) {
      blocked.add(String(c.sourceId))
    }
  }
  return blocked
}

function registerExcludedSourceId(db, sourceId) {
  if (!sourceId) return
  db.meta = { ...(db.meta ?? {}), excludedSourceIds: [...(db.meta?.excludedSourceIds ?? [])] }
  const sid = String(sourceId)
  if (!db.meta.excludedSourceIds.includes(sid)) {
    db.meta.excludedSourceIds.push(sid)
    const cap = 8000
    if (db.meta.excludedSourceIds.length > cap) {
      db.meta.excludedSourceIds = db.meta.excludedSourceIds.slice(-cap)
    }
  }
}

export async function writeDb(db) {
  db.meta = {
    ...(db.meta ?? {}),
    updatedAt: new Date().toISOString()
  }
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2))
  return db
}

export async function updateDb(mutator) {
  const db = await readDb()
  const result = await mutator(db)
  await writeDb(db)
  return result ?? db
}

export async function getConfig() {
  const db = await readDb()
  return db.config ?? defaultConfig
}

export async function saveConfig(config) {
  return updateDb((db) => {
    db.config = {
      ...defaultConfig,
      ...config,
      keywords: normalizeList(config.keywords),
      cities: normalizeList(config.cities),
      excludeKeywords: normalizeList(config.excludeKeywords),
      blacklistCompanies: normalizeList(config.blacklistCompanies),
      greetingTemplates: normalizeList(config.greetingTemplates)
    }
    addLog(db, 'success', '配置已保存')
    return db.config
  })
}

export async function getAuth() {
  const db = await readDb()
  return db.auth ?? defaultDb.auth
}

export async function saveAuth(auth) {
  return updateDb((db) => {
    const cookieJson = String(auth.bossCookieJson ?? '').trim()
    const localStorageJson = String(auth.bossLocalStorageJson ?? '').trim()
    const cookieCheck = validateJsonArray(cookieJson)
    const localStorageCheck = localStorageJson ? validateJsonObjectOrArray(localStorageJson) : { ok: true }

    db.auth = {
      bossCookieJson: cookieJson,
      bossLocalStorageJson: localStorageJson,
      savedAt: new Date().toISOString(),
      lastCheckAt: new Date().toISOString(),
      lastCheckResult:
        cookieCheck.ok && localStorageCheck.ok
          ? '登录凭据格式正常，等待真实浏览器自动化校验'
          : cookieCheck.error || localStorageCheck.error
    }

    addLog(
      db,
      cookieCheck.ok && localStorageCheck.ok ? 'success' : 'error',
      db.auth.lastCheckResult
    )
    return sanitizeAuth(db.auth)
  })
}

export async function clearAuth() {
  return updateDb((db) => {
    db.auth = { ...defaultDb.auth }
    addLog(db, 'info', '已清空 BOSS 登录凭据')
    return sanitizeAuth(db.auth)
  })
}

export async function addCandidates(items) {
  return updateDb((db) => {
    const blocked = getBlockedSourceIdsForCollect(db)
    const existingIds = new Set(db.candidates.map((item) => item.sourceId))
    for (const c of db.candidates) {
      c.isNew = false
    }

    const inserted = []
    let skippedBlocked = 0
    let skippedDup = 0
    for (const item of items) {
      if (!item?.sourceId) continue
      if (blocked.has(item.sourceId)) {
        skippedBlocked += 1
        continue
      }
      if (existingIds.has(item.sourceId)) {
        skippedDup += 1
        continue
      }
      const candidate = {
        id: crypto.randomUUID(),
        sourceId: item.sourceId,
        title: item.title,
        company: item.company,
        companyScale: item.companyScale ?? '',
        city: item.city,
        salary: item.salary,
        experience: item.experience,
        jobRequirement: item.jobRequirement ?? '',
        tags: item.tags ?? [],
        reason: item.reason ?? '',
        greeting: item.greeting ?? '',
        status: 'pending',
        isNew: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        appliedAt: null,
        repliedAt: null,
        notes: ''
      }
      if (item.raw) {
        candidate.raw = item.raw
      }
      db.candidates.unshift(candidate)
      inserted.push(candidate)
      existingIds.add(item.sourceId)
    }
    if (skippedBlocked) {
      addLog(db, 'info', `采集筛选：跳过已投递/已回复/已拒绝（或已排除）的职位 ${skippedBlocked} 条`)
    }
    if (skippedDup) {
      addLog(db, 'info', `采集去重：库内已有相同职位 ${skippedDup} 条，未重复添加`)
    }
    addLog(db, 'success', `采集完成，新增 ${inserted.length} 个候选职位`)
    return inserted
  })
}

export async function clearAllCandidateNewFlags() {
  return updateDb((db) => {
    let n = 0
    for (const c of db.candidates) {
      if (c.isNew) n += 1
      c.isNew = false
    }
    if (n) addLog(db, 'info', `已清除 ${n} 条「新岗位」角标`)
    return { cleared: n }
  })
}

export async function updateCandidateStatus(id, status) {
  return updateDb((db) => {
    const item = db.candidates.find((candidate) => candidate.id === id)
    if (!item) return null
    item.status = status
    item.updatedAt = new Date().toISOString()
    if (status === 'applied') item.appliedAt = new Date().toISOString()
    if (['applied', 'replied', 'rejected'].includes(status)) {
      registerExcludedSourceId(db, item.sourceId)
    }
    addLog(db, 'info', `${item.company} - ${item.title} 状态更新为 ${status}`)
    return item
  })
}

export async function batchUpdateStatus(ids, status) {
  return updateDb((db) => {
    let count = 0
    for (const item of db.candidates) {
      if (!ids.includes(item.id)) continue
      item.status = status
      item.updatedAt = new Date().toISOString()
      if (status === 'applied') item.appliedAt = new Date().toISOString()
      if (['applied', 'replied', 'rejected'].includes(status)) {
        registerExcludedSourceId(db, item.sourceId)
      }
      count += 1
    }
    addLog(db, 'info', `批量更新 ${count} 个职位为 ${status}`)
    return { count }
  })
}

export async function markConfirmedAsApplying(limit = 30) {
  return updateDb((db) => {
    const confirmed = db.candidates
      .filter((item) => item.status === 'confirmed')
      .slice(0, Number(limit) || 30)

    for (const item of confirmed) {
      item.status = 'applying'
      item.updatedAt = new Date().toISOString()
    }
    addLog(db, 'info', `已创建投递队列：${confirmed.length} 个职位待打开沟通`)
    return confirmed
  })
}

export async function addLogEntry(level, message, data = null) {
  return updateDb((db) => addLog(db, level, message, data))
}

export function addLog(db, level, message, data = null) {
  const entry = {
    id: crypto.randomUUID(),
    level,
    message,
    data,
    createdAt: new Date().toISOString()
  }
  db.logs.unshift(entry)
  db.logs = db.logs.slice(0, 300)
  return entry
}

export async function getSnapshot() {
  const db = await readDb()
  return {
    config: db.config,
    auth: sanitizeAuth(db.auth ?? defaultDb.auth),
    candidates: db.candidates,
    logs: db.logs,
    stats: buildStats(db.candidates)
  }
}

export async function replaceDb(nextDb) {
  const merged = {
    ...defaultDb,
    ...nextDb,
    config: {
      ...defaultConfig,
      ...(nextDb.config ?? {})
    },
    auth: {
      ...defaultDb.auth,
      ...(nextDb.auth ?? {})
    },
    meta: {
      ...defaultDb.meta,
      ...(nextDb.meta ?? {}),
      excludedSourceIds: Array.isArray(nextDb.meta?.excludedSourceIds)
        ? nextDb.meta.excludedSourceIds
        : defaultDb.meta.excludedSourceIds
    },
    candidates: Array.isArray(nextDb.candidates) ? nextDb.candidates : [],
    logs: Array.isArray(nextDb.logs) ? nextDb.logs : []
  }
  await writeDb(merged)
  return merged
}

function buildStats(candidates) {
  const total = candidates.length
  const byStatus = candidates.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1
    return acc
  }, {})
  const replied = byStatus.replied ?? 0
  const applied = (byStatus.applied ?? 0) + replied
  return {
    total,
    pending: byStatus.pending ?? 0,
    confirmed: byStatus.confirmed ?? 0,
    applying: byStatus.applying ?? 0,
    applied,
    rejected: byStatus.rejected ?? 0,
    replied,
    replyRate: applied > 0 ? Math.round((replied / applied) * 1000) / 10 : 0
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean)
  }
  return String(value ?? '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function sanitizeAuth(auth) {
  const cookieText = auth?.bossCookieJson ?? ''
  const localStorageText = auth?.bossLocalStorageJson ?? ''
  return {
    hasBossCookie: Boolean(cookieText.trim()),
    hasBossLocalStorage: Boolean(localStorageText.trim()),
    cookieLength: cookieText.length,
    localStorageLength: localStorageText.length,
    savedAt: auth?.savedAt ?? null,
    lastCheckAt: auth?.lastCheckAt ?? null,
    lastCheckResult: auth?.lastCheckResult ?? null
  }
}

function validateJsonArray(value) {
  if (!value) return { ok: false, error: 'Cookie JSON 不能为空' }
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'Cookie JSON 必须是数组格式' }
    }
    const invalid = parsed.find((item) => !item?.name || !item?.value)
    if (invalid) {
      return { ok: false, error: 'Cookie 数组中每一项至少需要 name 和 value 字段' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Cookie JSON 解析失败，请检查是否为合法 JSON' }
  }
}

function validateJsonObjectOrArray(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return { ok: true }
    return { ok: false, error: 'LocalStorage JSON 必须是对象或数组' }
  } catch {
    return { ok: false, error: 'LocalStorage JSON 解析失败，请检查是否为合法 JSON' }
  }
}
