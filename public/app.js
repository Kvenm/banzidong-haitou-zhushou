const state = {
  snapshot: null,
  view: 'dashboard',
  statusFilter: 'actionable'
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

/** 预设投递岗位，与 BOSS 搜索关键词一致 */
const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const DEFAULT_TIME_SLOTS = ['21:00', '21:30']

const KEYWORD_JOB_OPTIONS = [
  '软件测试',
  '测试工程师',
  '高级测试工程师',
  '测试开发工程师',
  '嵌入式测试工程师',
  '自动化测试工程师',
  '中级测试工程师'
]

function coerceKeywordsArray(kw) {
  if (Array.isArray(kw)) return kw.map((s) => String(s).trim()).filter(Boolean)
  return String(kw ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function splitPresetAndExtra(words) {
  const preset = KEYWORD_JOB_OPTIONS.filter((k) => words.includes(k))
  const extra = words.filter((k) => !KEYWORD_JOB_OPTIONS.includes(k))
  return { preset, extra }
}

function getKeywordsModeFromForm(form) {
  return form.querySelector('input[name=keywordsMode]:checked')?.value === 'single' ? 'single' : 'multiple'
}

function inferKeywordsMode(config, presetHits) {
  if (presetHits.length > 1) return 'multiple'
  if (config.keywordsMode === 'single' || config.keywordsMode === 'multiple') return config.keywordsMode
  return 'single'
}

function buildPresetInputsHTML(mode, selectedSet) {
  if (mode === 'single') {
    return KEYWORD_JOB_OPTIONS.map((title) => {
      const escaped = escapeHtml(title)
      return `<label class="keyword-option"><input type="radio" name="keywordPresetPick" value="${escaped}" ${
        selectedSet.has(title) ? 'checked' : ''
      } /><span>${escaped}</span></label>`
    }).join('')
  }
  return KEYWORD_JOB_OPTIONS.map((title) => {
    const escaped = escapeHtml(title)
    return `<label class="keyword-option"><input type="checkbox" name="keywordPresetCb" value="${escaped}" ${
      selectedSet.has(title) ? 'checked' : ''
    } /><span>${escaped}</span></label>`
  }).join('')
}

function gatherCheckedPresets(form) {
  const mode = getKeywordsModeFromForm(form)
  if (mode === 'single') {
    const r = form.querySelector('#keywordPresetContainer input[name=keywordPresetPick]:checked')
    return r ? [r.value] : []
  }
  return [...form.querySelectorAll('#keywordPresetContainer input[name=keywordPresetCb]:checked')].map((i) => i.value)
}

/** 从配置表单读取关键词与模式（保存/采集共用） */
function readKeywordFieldsFromForm(form) {
  const presetPicked = gatherCheckedPresets(form)
  const orderedPresets = KEYWORD_JOB_OPTIONS.filter((k) => presetPicked.includes(k))
  const extraWords = coerceKeywordsArray(form.keywordExtra?.value ?? '')
  const extras = extraWords.filter((k) => !KEYWORD_JOB_OPTIONS.includes(k))
  const keywords = [...orderedPresets, ...extras]
  let keywordsMode = getKeywordsModeFromForm(form)
  if (keywords.length > 1) keywordsMode = 'multiple'
  return { keywords, keywordsMode }
}

function buildConfigPayloadFromForm(form) {
  const { keywords, keywordsMode } = readKeywordFieldsFromForm(form)
  const checked = []
  form.querySelectorAll('#outsourcingCheckboxList input:checked').forEach((cb) => {
    checked.push(cb.value)
  })
  const scheduleDays = []
  form.querySelectorAll('#dayPicker input:checked').forEach((cb) => {
    scheduleDays.push(Number(cb.value))
  })
  return {
    keywords,
    keywordsMode,
    cities: form.cities.value,
    salaryMin: Number(form.salaryMin.value || 0),
    salaryMax: Number(form.salaryMax.value || 0),
    experience: form.experience.value,
    dailyApplyLimit: Number(form.dailyApplyLimit.value || 30),
    excludeKeywords: form.excludeKeywords.value,
    blacklistCompanies: form.blacklistCompanies.value,
    excludeOutsourcingCompanies: checked,
    greetingTemplates: form.greetingTemplates.value,
    scheduleEnabled: form.scheduleEnabled?.checked || false,
    scheduleTimes: (() => {
      const times = []
      form.querySelectorAll('#timeSlots input:checked').forEach((cb) => times.push(cb.value))
      return times.length ? times : ['21:00', '21:30']
    })(),
    scheduleDays
  }
}

let keywordDropdownOpen = false

function setKeywordDropdownOpen(open) {
  keywordDropdownOpen = open
  const panel = document.getElementById('keywordDropdownPanel')
  const btn = document.getElementById('keywordDropdownTrigger')
  if (!panel || !btn) return
  panel.hidden = !open
  btn.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function closeKeywordDropdown() {
  setKeywordDropdownOpen(false)
}

function updateKeywordDropdownSummary() {
  const form = document.getElementById('configForm')
  const summary = document.getElementById('keywordDropdownSummary')
  if (!form || !summary) return
  const presetPicked = gatherCheckedPresets(form)
  const orderedPresets = KEYWORD_JOB_OPTIONS.filter((k) => presetPicked.includes(k))
  const extraWords = coerceKeywordsArray(form.keywordExtra?.value ?? '')
  const extras = extraWords.filter((k) => !KEYWORD_JOB_OPTIONS.includes(k))
  const parts = [...orderedPresets, ...extras]
  summary.textContent = parts.length ? parts.join('、') : '点击选择岗位…'
}

/** 切换单选/复选前读取当前勾选（不依赖尚未更新的 mode 单选框） */
function gatherPresetSelectionFromDom(form) {
  const fromCb = [
    ...form.querySelectorAll('#keywordPresetContainer input[name=keywordPresetCb]:checked')
  ].map((i) => i.value)
  if (fromCb.length) return fromCb
  const r = form.querySelector('#keywordPresetContainer input[name=keywordPresetPick]:checked')
  return r ? [r.value] : []
}

function rebuildPresetWithMode(form, newMode, prevSelected) {
  const prev = prevSelected ?? gatherPresetSelectionFromDom(form)
  const selected = new Set()
  if (newMode === 'single') {
    if (prev[0]) selected.add(prev[0])
  } else {
    prev.forEach((p) => selected.add(p))
  }
  const container = document.getElementById('keywordPresetContainer')
  if (!container) return
  container.innerHTML = buildPresetInputsHTML(newMode, selected)
}

function renderKeywordJobPanel(config) {
  const form = document.getElementById('configForm')
  if (!form?.keywordExtra) return
  const words = coerceKeywordsArray(config.keywords)
  const { preset, extra } = splitPresetAndExtra(words)
  const mode = inferKeywordsMode(config, preset)
  form.keywordExtra.value = extra.join(', ')

  for (const radio of form.querySelectorAll('input[name=keywordsMode]')) {
    radio.checked = radio.value === mode
  }

  const selected = new Set(preset)
  if (mode === 'single' && preset[0]) {
    selected.clear()
    selected.add(preset[0])
  }

  const container = document.getElementById('keywordPresetContainer')
  if (container) container.innerHTML = buildPresetInputsHTML(mode, selected)
  closeKeywordDropdown()
  updateKeywordDropdownSummary()
}

function setupKeywordJobControls() {
  if (setupKeywordJobControls._done) return
  setupKeywordJobControls._done = true

  const form = document.getElementById('configForm')
  const trigger = document.getElementById('keywordDropdownTrigger')
  const dropdown = document.querySelector('.keyword-dropdown')

  trigger?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    setKeywordDropdownOpen(!keywordDropdownOpen)
  })

  document.addEventListener('click', (e) => {
    if (!dropdown?.contains(e.target)) closeKeywordDropdown()
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeKeywordDropdown()
  })

  dropdown?.addEventListener('click', (e) => e.stopPropagation())

  form?.addEventListener('change', (e) => {
    const target = /** @type {HTMLInputElement} */ (e.target)
    if (target.matches('input[name=keywordsMode]')) {
      const prev = gatherPresetSelectionFromDom(form)
      rebuildPresetWithMode(form, target.value, prev)
      updateKeywordDropdownSummary()
      return
    }
    if (target.matches('#keywordPresetContainer input[name=keywordPresetCb]') && getKeywordsModeFromForm(form) === 'single') {
      if (target.checked) {
        form.querySelectorAll('#keywordPresetContainer input[name=keywordPresetCb]').forEach((el) => {
          if (el !== target) el.checked = false
        })
      }
    }
    if (target.closest?.('#keywordPresetContainer')) {
      updateKeywordDropdownSummary()
    }
  })

  form?.keywordExtra?.addEventListener('input', () => updateKeywordDropdownSummary())
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
document.getElementById('collectMobileBtn').addEventListener('click', collectJobsViaMobile)
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

/** 外包公司列表从前端常量定义，不再额外请求 API */
const OUTSOURCING_COMPANIES_LIST = [
  '中软国际', '软通动力', '文思海辉', '中电金信', '东软集团', '博彦科技', '浪潮',
  '法本信息', '京北方', '佰钧成', '神州数码', '润和软件', '诚迈科技', '慧博云通',
  '拓维信息', '科蓝软件', '宇信科技', '天阳科技', '信雅达', '浙大网新', '汉得信息',
  '赛意信息', '鼎捷软件', '中科软', '亚信科技', '新致软件', '高伟达', '长亮科技',
  '柯莱特', '凌志软件', '海隆软件', '麦亚信', '微创软件', '金证股份', '华勤技术',
  '信华信', '银雁科技', '拓保软件', '埃森哲', 'Infosys', '印孚瑟斯', '凯捷',
  '达内科技', '传智教育', '北大青鸟'
]

setupKeywordJobControls()
setupOutsourcingFilterControls()
setupScheduleControls()
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
  renderKeywordJobPanel(config)
  form.cities.value = toText(config.cities)
  form.salaryMin.value = config.salaryMin ?? ''
  form.salaryMax.value = config.salaryMax ?? ''
  form.experience.value = config.experience ?? ''
  form.dailyApplyLimit.value = config.dailyApplyLimit ?? 30
  form.excludeKeywords.value = toText(config.excludeKeywords)
  form.blacklistCompanies.value = toText(config.blacklistCompanies)
  form.greetingTemplates.value = toText(config.greetingTemplates, '\n')
  renderOutsourcingFilter(config)
  renderScheduleConfig(config)
}

function renderCandidates() {
  const tbody = document.getElementById('candidateRows')
  const candidates = state.snapshot.candidates.filter((item) => {
    if (state.statusFilter === 'all') return true
    if (state.statusFilter === 'actionable') {
      return ['pending', 'confirmed', 'applying'].includes(item.status)
    }
    return item.status === state.statusFilter
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
              <button data-mark-outsourcing="${escapeHtml(item.company || '')}">外包</button>
            </div>
          </td>
        </tr>
      `
    )
    .join('')

  tbody.querySelectorAll('[data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api('/api/candidate/status', {
          method: 'POST',
          body: { id: button.dataset.id, status: button.dataset.status }
        })
        // 直接更新本地状态，无需整页刷新
        const candidate = state.snapshot.candidates.find((c) => c.id === button.dataset.id)
        if (candidate) {
          candidate.status = button.dataset.status
          candidate.updatedAt = new Date().toISOString()
          if (button.dataset.status === 'applied') candidate.appliedAt = new Date().toISOString()
        }
        recalcStats()
        toast('状态已更新')
        renderStats()
        renderCandidates()
      } catch (e) {
        toast(String(e.message || e))
      }
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
  tbody.querySelectorAll('[data-mark-outsourcing]').forEach((button) => {
    button.addEventListener('click', () => {
      const company = button.dataset.markOutsourcing
      if (company) markCompanyAsOutsourcing(company).catch((e) => toast(String(e.message || e)))
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
  const payload = buildConfigPayloadFromForm(form)
  if (!payload.keywords.length) {
    toast('请至少选择一个投递岗位关键词')
    return
  }
  await api('/api/config', { method: 'POST', body: payload })
  toast(`配置已保存（${payload.keywords.length} 个搜索关键词：${payload.keywords.join('、')}）`)
  await refresh()
}

/** 采集前同步当前表单配置，避免只选了多选但未点「保存配置」 */
async function persistConfigFromForm() {
  const form = document.getElementById('configForm')
  if (!form) return null
  const payload = buildConfigPayloadFromForm(form)
  if (!payload.keywords.length) {
    throw new Error('请至少选择一个投递岗位关键词')
  }
  const { config } = await api('/api/config', { method: 'POST', body: payload })
  return config
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
  toast('浏览器已打开，请在浏览器中登录 BOSS 直聘，登录成功后自动检测…')

  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setTimeout(r, 3000))
    const snap = await api('/api/snapshot')
    if (snap.auth?.hasBossCookie) {
      state.snapshot = snap
      renderAll()
      toast('登录凭据已自动保存！可以开始采集了')
      return
    }
  }
  toast('等待登录超时，请手动刷新页面或重新获取')
}

async function collectJobs() {
  let config
  try {
    config = await persistConfigFromForm()
  } catch (e) {
    toast(String(e.message || e))
    switchView('config')
    return
  }

  const btn = document.getElementById('collectBtn')
  const originalText = btn ? btn.textContent : '开始采集'
  if (btn) {
    btn.disabled = true
    btn.textContent = '正在采集…'
    btn.classList.add('collecting')
  }

  let result
  try {
    result = await api('/api/collect', { method: 'POST', body: { config } })
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = originalText
      btn.classList.remove('collecting')
    }
  }

  const n = Array.isArray(result.candidates) ? result.candidates.length : 0
  const kwCount = Array.isArray(result.keywordsUsed) ? result.keywordsUsed.length : config?.keywords?.length ?? 0
  state.statusFilter = 'actionable'
  const filterEl = document.getElementById('statusFilter')
  if (filterEl) filterEl.value = 'actionable'
  toast(
    n > 0
      ? `采集完成（${kwCount} 个关键词），新增 ${n} 条待处理职位`
      : `采集结束（${kwCount} 个关键词）：本次没有新的待处理职位。可查看「运行日志」或调整关键词/城市`
  )
  await refresh()
}

async function collectJobsViaMobile() {
  const btn = document.getElementById('collectMobileBtn')
  const originalText = btn ? btn.textContent : 'App 端采集'
  if (btn) {
    btn.disabled = true
    btn.textContent = '移动端采集中…'
  }

  let result
  try {
    result = await api('/api/collect/mobile', { method: 'POST' })
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = originalText
    }
  }

  toast(`移动端采集已启动（${(result.keywordsUsed || []).length} 个关键词 × ${(result.cities || []).length} 个城市），完成后查看运行日志`)
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
  // 直接更新本地状态
  const idSet = new Set(ids)
  for (const c of state.snapshot.candidates) {
    if (idSet.has(c.id)) {
      c.status = 'confirmed'
      c.updatedAt = new Date().toISOString()
    }
  }
  recalcStats()
  toast(`已确认 ${ids.length} 个候选`)
  renderStats()
  renderCandidates()
}

async function clearNewBadges() {
  const r = await api('/api/candidates/clear-new', { method: 'POST' })
  for (const c of state.snapshot.candidates) c.isNew = false
  toast(r.cleared ? `已清除 ${r.cleared} 条 NEW 角标` : '当前没有 NEW 角标')
  renderCandidates()
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

function recalcStats() {
  const candidates = state.snapshot.candidates
  const byStatus = {}
  for (const c of candidates) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
  }
  const replied = byStatus.replied ?? 0
  const applied = (byStatus.applied ?? 0) + replied
  state.snapshot.stats = {
    total: candidates.length,
    pending: byStatus.pending ?? 0,
    confirmed: byStatus.confirmed ?? 0,
    applying: byStatus.applying ?? 0,
    applied,
    rejected: byStatus.rejected ?? 0,
    replied,
    replyRate: applied > 0 ? Math.round((replied / applied) * 1000) / 10 : 0
  }
}

function setText(id, value) {
  document.getElementById(id).textContent = value
}

function renderOutsourcingFilter(config) {
  const list = document.getElementById('outsourcingCheckboxList')
  if (!list) return
  const selected = new Set(config?.excludeOutsourcingCompanies ?? [])
  list.innerHTML = OUTSOURCING_COMPANIES_LIST.map((name) => {
    const checked = selected.has(name) ? ' checked' : ''
    return `<label class="multi-select-item"><input type="checkbox" value="${escapeHtml(name)}"${checked} /> ${escapeHtml(name)}</label>`
  }).join('')
  updateOutsourcingSummary()
}

function renderScheduleConfig(config) {
  const enabled = document.getElementById('scheduleEnabled')
  const options = document.getElementById('scheduleOptions')
  const dayPicker = document.getElementById('dayPicker')
  const timeSlots = document.getElementById('timeSlots')

  if (enabled) enabled.checked = config?.scheduleEnabled || false
  if (options) options.style.display = (config?.scheduleEnabled) ? '' : 'none'

  if (timeSlots) {
    const selected = Array.isArray(config?.scheduleTimes) && config.scheduleTimes.length
      ? config.scheduleTimes
      : DEFAULT_TIME_SLOTS
    timeSlots.innerHTML = DEFAULT_TIME_SLOTS.map((t) => {
      const checked = selected.includes(t) ? ' checked' : ''
      return `<label class="day-chip"><input type="checkbox" value="${t}"${checked} /> ${t}</label>`
    }).join('')
  }

  if (dayPicker) {
    const days = Array.isArray(config?.scheduleDays) && config.scheduleDays.length ? config.scheduleDays : [1, 2, 3, 4, 5]
    dayPicker.innerHTML = DAY_LABELS.map((label, i) => {
      const checked = days.includes(i) ? ' checked' : ''
      return `<label class="day-chip"><input type="checkbox" value="${i}"${checked} /> ${label}</label>`
    }).join('')
  }
}

function setupScheduleControls() {
  const toggle = document.getElementById('scheduleEnabled')
  const options = document.getElementById('scheduleOptions')
  toggle?.addEventListener('change', () => {
    if (options) options.style.display = toggle.checked ? '' : 'none'
  })
}

function updateOutsourcingSummary() {
  const summary = document.getElementById('outsourcingFilterSummary')
  const checked = document.querySelectorAll('#outsourcingCheckboxList input:checked')
  const n = checked.length
  summary.textContent = n > 0 ? `已选择 ${n} 家公司过滤` : '未选择过滤公司…'
}

function setupOutsourcingFilterControls() {
  const trigger = document.getElementById('outsourcingFilterTrigger')
  const panel = document.getElementById('outsourcingFilterPanel')
  if (!trigger || !panel) return

  trigger.addEventListener('click', () => {
    const open = panel.hidden
    panel.hidden = !open
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
  })

  document.addEventListener('click', (e) => {
    if (!panel.hidden && !trigger.contains(e.target) && !panel.contains(e.target)) {
      panel.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
    }
  })

  const selectAll = document.getElementById('outsourcingSelectAll')
  const deselectAll = document.getElementById('outsourcingDeselectAll')
  selectAll?.addEventListener('click', () => {
    document.querySelectorAll('#outsourcingCheckboxList input').forEach((cb) => { cb.checked = true })
    updateOutsourcingSummary()
  })
  deselectAll?.addEventListener('click', () => {
    document.querySelectorAll('#outsourcingCheckboxList input').forEach((cb) => { cb.checked = false })
    updateOutsourcingSummary()
  })

  document.getElementById('outsourcingCheckboxList')?.addEventListener('change', updateOutsourcingSummary)
}

async function markCompanyAsOutsourcing(companyName) {
  if (!companyName) return
  // 同步到后端黑名单
  const snap = await api('/api/snapshot')
  const existing = snap.config?.excludeOutsourcingCompanies ?? []
  if (existing.includes(companyName)) {
    toast(`「${companyName}」已在过滤列表中`)
    return
  }
  const updated = [...existing, companyName]
  await api('/api/config', {
    method: 'POST',
    body: { ...snap.config, excludeOutsourcingCompanies: updated }
  })
  toast(`已添加「${companyName}」到公司过滤，下次采集时自动跳过`)
  await refresh()
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
