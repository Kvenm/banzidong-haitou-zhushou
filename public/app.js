const state = {
  snapshot: null,
  view: 'dashboard',
  statusFilter: 'all'
}

let reqTipHideTimer = null

function ensureGlobalReqTooltip() {
  let el = document.getElementById('globalReqTooltip')
  if (!el) {
    el = document.createElement('div')
    el.id = 'globalReqTooltip'
    el.className = 'global-req-tooltip'
    el.setAttribute('role', 'tooltip')
    el.addEventListener('mouseenter', () => clearTimeout(reqTipHideTimer))
    el.addEventListener('mouseleave', () => el.classList.remove('visible'))
    document.body.appendChild(el)
  }
  return el
}

function bindCompanyReqTooltips(tbody) {
  const tip = ensureGlobalReqTooltip()
  tbody.querySelectorAll('.company-tip-trigger').forEach((trigger) => {
    const id = trigger.dataset.candidateId
    const show = () => {
      clearTimeout(reqTipHideTimer)
      const c = state.snapshot.candidates.find((x) => x.id === id)
      const txt = String(c?.jobRequirement ?? '').trim()
      if (!txt) return
      tip.textContent = txt
      tip.classList.add('visible')
      const r = trigger.getBoundingClientRect()
      const pad = 8
      let left = r.left
      let top = r.bottom + pad
      tip.style.left = `${left}px`
      tip.style.top = `${top}px`
      requestAnimationFrame(() => {
        const tr = tip.getBoundingClientRect()
        if (tr.right > window.innerWidth - 8) {
          left = Math.max(8, window.innerWidth - tr.width - 8)
          tip.style.left = `${left}px`
        }
        if (tr.bottom > window.innerHeight - 8) {
          top = Math.max(8, r.top - tr.height - pad)
          tip.style.top = `${top}px`
        }
      })
    }
    const hide = () => {
      reqTipHideTimer = setTimeout(() => tip.classList.remove('visible'), 120)
    }
    trigger.addEventListener('mouseenter', show)
    trigger.addEventListener('mouseleave', hide)
    trigger.addEventListener('focus', show)
    trigger.addEventListener('blur', hide)
  })
}

/** 投递在服务端异步执行，单次 refresh 往往早于 DB 更新；按本批 id 轮询快照直至不再「已确认」或超时 */
let applySnapshotPollGen = 0
let applySnapshotPollTimer = null

function stopApplySnapshotPolling() {
  if (applySnapshotPollTimer != null) {
    clearTimeout(applySnapshotPollTimer)
    applySnapshotPollTimer = null
  }
}

/**
 * @param {string[]} candidateIds - 本轮启动投递时的已确认候选 id
 * @param {{ intervalMs?: number, maxAttempts?: number }} [options]
 */
function scheduleApplySnapshotPolling(candidateIds, options = {}) {
  const intervalMs = options.intervalMs ?? 2500
  const maxAttempts = options.maxAttempts ?? 120
  if (!candidateIds?.length) return

  stopApplySnapshotPolling()
  const myGen = ++applySnapshotPollGen
  const target = new Set(candidateIds)
  let attempts = 0

  const tick = async () => {
    if (myGen !== applySnapshotPollGen) return
    if (++attempts > maxAttempts) {
      applySnapshotPollTimer = null
      return
    }
    try {
      state.snapshot = await api('/api/snapshot')
      renderAll()
      const anyStillConfirmed = [...target].some((id) => {
        const c = state.snapshot.candidates.find((x) => x.id === id)
        return c?.status === 'confirmed'
      })
      if (!anyStillConfirmed) {
        applySnapshotPollTimer = null
        return
      }
    } catch {
      //
    }
    applySnapshotPollTimer = setTimeout(tick, intervalMs)
  }
  applySnapshotPollTimer = setTimeout(tick, intervalMs)
}

const API_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:4173' : ''

const titles = {
  dashboard: ['数据看板', '查看候选池、确认进度和投递状态'],
  auth: ['BOSS 登录态', '保存本地 Cookie，为后续真实自动化做准备'],
  config: ['投递配置', '管理职位搜索条件、招呼语和投递节奏'],
  candidates: ['候选确认', '先确认再投递，避免盲目海投'],
  logs: ['运行日志', '查看采集、确认和投递过程']
}

const statusText = {
  pending: '待确认',
  confirmed: '已确认',
  applying: '待沟通',
  applied: '已投递',
  replied: '已回复',
  rejected: '已拒绝'
}

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view))
})

document.querySelectorAll('[data-view-jump]').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.viewJump))
})

document.getElementById('configForm').addEventListener('submit', saveConfig)
document.getElementById('authForm').addEventListener('submit', saveAuth)
document.getElementById('clearAuthBtn').addEventListener('click', clearAuth)
document.getElementById('captureCookieBtn').addEventListener('click', captureCookie)
document.getElementById('collectBtn').addEventListener('click', collectJobs)
document.getElementById('applyBtn').addEventListener('click', () => applyJobs().catch((e) => toast(String(e.message || e))))
document
  .getElementById('applyOriginalBtn')
  .addEventListener('click', () => applyJobsOriginal().catch((e) => toast(String(e.message || e))))
document.getElementById('statusFilter').addEventListener('change', (event) => {
  state.statusFilter = event.target.value
  renderCandidates()
})
document.getElementById('batchConfirmBtn').addEventListener('click', batchConfirm)
document.getElementById('clearNewBadgeBtn').addEventListener('click', () =>
  clearNewBadges().catch((e) => toast(String(e.message || e)))
)
document.getElementById('exportBtn').addEventListener('click', exportData)
document.getElementById('importInput').addEventListener('change', importData)

await refresh()

async function refresh() {
  state.snapshot = await api('/api/snapshot')
  renderAll()
}

function renderAll() {
  renderStats()
  renderAuth()
  renderConfig()
  renderCandidates()
  renderRecent()
  renderLogs()
}

function renderAuth() {
  const auth = state.snapshot.auth
  const badge = document.getElementById('authBadge')
  badge.textContent = auth.hasBossCookie ? '已保存 Cookie' : '未保存'
  badge.className = `status ${auth.hasBossCookie ? 'applied' : 'rejected'}`
  const form = document.getElementById('authForm')
  form.bossCookieJson.value = ''
  form.bossLocalStorageJson.value = ''
  form.bossCookieJson.placeholder = auth.hasBossCookie
    ? `已保存 Cookie，长度 ${auth.cookieLength}。重新粘贴可覆盖。`
    : '粘贴 Cookie 数组，例如 [{"name":"...","value":"...","domain":".zhipin.com"}]'
  form.bossLocalStorageJson.placeholder = auth.hasBossLocalStorage
    ? `已保存 LocalStorage，长度 ${auth.localStorageLength}。重新粘贴可覆盖。`
    : '如暂时没有可以留空，后续真实浏览器适配时再使用'
  if (auth.lastCheckResult) {
    document.querySelector('.auth-help strong').textContent = auth.lastCheckResult
  }
}

function switchView(view) {
  state.view = view
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === view))
  document.querySelectorAll('.nav').forEach((item) => item.classList.toggle('active', item.dataset.view === view))
  document.getElementById('viewTitle').textContent = titles[view][0]
  document.getElementById('viewSubTitle').textContent = titles[view][1]
}

function renderStats() {
  const stats = state.snapshot.stats
  setText('statTotal', stats.total)
  setText('statPending', stats.pending)
  setText('statConfirmed', stats.confirmed)
  setText('statApplying', stats.applying)
  setText('statApplied', stats.applied)
  setText('statRejected', stats.rejected)
  setText('statReplyRate', `${stats.replyRate}%`)
}

function renderConfig() {
  const form = document.getElementById('configForm')
  const config = state.snapshot.config
  form.keywords.value = toText(config.keywords)
  form.cities.value = toText(config.cities)
  form.salaryMin.value = config.salaryMin ?? ''
  form.salaryMax.value = config.salaryMax ?? ''
  form.experience.value = config.experience ?? ''
  form.dailyApplyLimit.value = config.dailyApplyLimit ?? 30
  form.excludeKeywords.value = toText(config.excludeKeywords)
  form.blacklistCompanies.value = toText(config.blacklistCompanies)
  form.greetingTemplates.value = toText(config.greetingTemplates, '\n')
}

function renderCandidates() {
  const tbody = document.getElementById('candidateRows')
  const candidates = state.snapshot.candidates.filter((item) => {
    return state.statusFilter === 'all' || item.status === state.statusFilter
  })
  tbody.innerHTML = candidates
    .map(
      (item) => `
        <tr>
          <td>
            <div class="title-cell">
              ${item.isNew ? '<span class="badge-new" title="本轮采集新增">NEW</span>' : ''}
              <strong>${escapeHtml(item.title)}</strong>
              <div class="muted">${escapeHtml(item.experience || '')}</div>
            </div>
          </td>
          ${renderCompanyCell(item)}
          <td class="th-scale">${escapeHtml(item.companyScale || '—')}</td>
          <td>${escapeHtml(item.city)}</td>
          <td>${escapeHtml(item.salary)}</td>
          <td><span class="status ${item.status}">${statusText[item.status] ?? item.status}</span></td>
          <td>${escapeHtml(item.reason || '')}</td>
          <td>
            <div class="row-actions">
              ${actionButton(item, 'confirmed', '确认')}
              ${actionButton(item, 'rejected', '拒绝')}
              ${actionButton(item, 'pending', '恢复')}
              ${actionButton(item, 'applied', '标记投递')}
              ${actionButton(item, 'replied', '标记回复')}
              ${item.sourceId?.startsWith('boss-') ? `<button data-open="${item.id}">打开职位</button>` : ''}
            </div>
          </td>
        </tr>
      `
    )
    .join('')

  tbody.querySelectorAll('[data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('/api/candidate/status', {
        method: 'POST',
        body: { id: button.dataset.id, status: button.dataset.status }
      })
      toast('状态已更新')
      await refresh()
    })
  })
  tbody.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api(`/api/candidate/open-url?id=${encodeURIComponent(button.dataset.open)}`)
      if (!result.url) {
        toast('没有可打开的职位链接')
        return
      }
      window.open(result.url, '_blank')
    })
  })
  bindCompanyReqTooltips(tbody)
}

function renderCompanyCell(item) {
  const req = String(item.jobRequirement ?? '').trim()
  const name = escapeHtml(item.company)
  if (!req) {
    return `<td>${name}</td>`
  }
  return `<td class="company-cell"><span class="company-tip-trigger" tabindex="0" data-candidate-id="${escapeHtml(item.id)}">${name}</span></td>`
}

function renderRecent() {
  const list = document.getElementById('recentList')
  const items = state.snapshot.candidates.slice(0, 8)
  list.innerHTML =
    items
      .map(
        (item) => `
          <div class="compact-item">
            <strong>${escapeHtml(item.title)} · ${escapeHtml(item.company)}</strong>
            <span>${escapeHtml(item.city)} / ${escapeHtml(item.salary)} / ${statusText[item.status] ?? item.status}</span>
          </div>
        `
      )
      .join('') || '<div class="compact-item"><strong>暂无候选</strong><span>点击“开始采集”生成第一批候选职位</span></div>'
}

function renderLogs() {
  const list = document.getElementById('logList')
  list.innerHTML =
    state.snapshot.logs
      .map(
        (item) => `
          <div class="log-item ${item.level}">
            <strong>${escapeHtml(item.message)}</strong>
            <time>${new Date(item.createdAt).toLocaleString()}</time>
          </div>
        `
      )
      .join('') || '<div class="log-item info"><strong>暂无日志</strong><time>操作后会显示在这里</time></div>'
}

async function saveConfig(event) {
  event.preventDefault()
  const form = event.currentTarget
  await api('/api/config', {
    method: 'POST',
    body: {
      keywords: form.keywords.value,
      cities: form.cities.value,
      salaryMin: Number(form.salaryMin.value || 0),
      salaryMax: Number(form.salaryMax.value || 0),
      experience: form.experience.value,
      dailyApplyLimit: Number(form.dailyApplyLimit.value || 30),
      excludeKeywords: form.excludeKeywords.value,
      blacklistCompanies: form.blacklistCompanies.value,
      greetingTemplates: form.greetingTemplates.value
    }
  })
  toast('配置已保存')
  await refresh()
}

async function saveAuth(event) {
  event.preventDefault()
  const form = event.currentTarget
  await api('/api/auth', {
    method: 'POST',
    body: {
      bossCookieJson: form.bossCookieJson.value,
      bossLocalStorageJson: form.bossLocalStorageJson.value
    }
  })
  toast('登录态已保存')
  await refresh()
}

async function clearAuth() {
  await api('/api/auth', { method: 'DELETE' })
  toast('登录态已清空')
  await refresh()
}

async function captureCookie() {
  await api('/api/auth/capture', { method: 'POST' })
  toast('浏览器已打开，请在浏览器中登录 BOSS 直聘')
}

async function collectJobs() {
  const result = await api('/api/collect', { method: 'POST' })
  const n = Array.isArray(result.candidates) ? result.candidates.length : 0
  toast(
    n > 0
      ? `采集完成，新增 ${n} 条（已写入候选）`
      : '采集结束：本次没有新入库职位，请打开「运行日志」查看原因（常见：均已投过/已拒绝被过滤，或需换关键词与城市）'
  )
  await refresh()
}

async function applyJobs() {
  const confirmed = state.snapshot.candidates.filter((item) => item.status === 'confirmed')
  if (!confirmed.length) {
    toast('请先确认要投递的候选')
    return
  }
  const ids = confirmed.map((c) => c.id)
  const result = await api('/api/apply', {
    method: 'POST',
    body: { candidateIds: ids }
  })
  toast(result.message || `投递已启动：${result.count} 个职位`)
  await refresh()
  scheduleApplySnapshotPolling(ids)
  switchView('candidates')
}

async function applyJobsOriginal() {
  const confirmed = state.snapshot.candidates.filter((item) => item.status === 'confirmed')
  if (!confirmed.length) {
    toast('请先确认要投递的候选')
    return
  }
  const ids = confirmed.map((c) => c.id)
  const result = await api('/api/apply-original', {
    method: 'POST',
    body: { candidateIds: ids }
  })
  toast(result.message || `Geek 策略投递已启动：${result.count} 个职位`)
  await refresh()
  scheduleApplySnapshotPolling(ids)
  switchView('logs')
}

async function batchConfirm() {
  const ids = state.snapshot.candidates.filter((item) => item.status === 'pending').map((item) => item.id)
  await api('/api/candidates/status', {
    method: 'POST',
    body: { ids, status: 'confirmed' }
  })
  toast(`已确认 ${ids.length} 个候选`)
  await refresh()
}

async function clearNewBadges() {
  const r = await api('/api/candidates/clear-new', { method: 'POST' })
  toast(r.cleared ? `已清除 ${r.cleared} 条 NEW 角标` : '当前没有 NEW 角标')
  await refresh()
}

async function exportData() {
  const data = await api('/api/export')
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `haitou-assistant-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

async function importData(event) {
  const file = event.target.files?.[0]
  if (!file) return
  const text = await file.text()
  await api('/api/import', {
    method: 'POST',
    body: JSON.parse(text)
  })
  toast('数据已导入')
  await refresh()
}

async function api(url, options = {}) {
  const response = await fetch(`${API_BASE}${url}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || '请求失败')
  }
  return data
}

function actionButton(item, status, text) {
  if (item.status === status) return ''
  return `<button data-id="${item.id}" data-status="${status}">${text}</button>`
}

function setText(id, value) {
  document.getElementById(id).textContent = value
}

function toText(value, separator = ', ') {
  return Array.isArray(value) ? value.join(separator) : value ?? ''
}

function toast(message) {
  const node = document.getElementById('toast')
  node.textContent = message
  node.classList.add('show')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.remove('show'), 1800)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}
