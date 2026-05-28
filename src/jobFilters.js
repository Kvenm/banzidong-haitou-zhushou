/**
 * 采集阶段按投递配置过滤职位（薪资、排除词、黑名单等）
 */

/** 常见 IT 人力外包/驻场公司，采集时可一键过滤 */
export const COMMON_OUTSOURCING_COMPANIES = [
  '中软国际',
  '软通动力',
  '文思海辉',
  '中电金信',
  '东软集团',
  '博彦科技',
  '浪潮',
  '法本信息',
  '京北方',
  '佰钧成',
  '神州数码',
  '润和软件',
  '诚迈科技',
  '慧博云通',
  '拓维信息',
  '科蓝软件',
  '宇信科技',
  '天阳科技',
  '信雅达',
  '浙大网新',
  '汉得信息',
  '赛意信息',
  '鼎捷软件',
  '中科软',
  '亚信科技',
  '新致软件',
  '高伟达',
  '长亮科技',
  '柯莱特',
  '凌志软件',
  '海隆软件',
  '麦亚信',
  '微创软件',
  '金证股份',
  '华勤技术',
  '信华信',
  '银雁科技',
  '拓保软件',
  '埃森哲',
  'Infosys',
  '印孚瑟斯',
  '凯捷',
  '达内科技',
  '传智教育',
  '北大青鸟'
]

export function normalizeSourceId(sourceId) {
  if (sourceId == null || sourceId === '') return ''
  const s = String(sourceId).trim()
  if (!s) return ''
  return s.startsWith('boss-') ? s : `boss-${s}`
}

export function sourceIdVariants(sourceId) {
  const n = normalizeSourceId(sourceId)
  if (!n) return []
  const bare = n.replace(/^boss-/, '')
  return bare === n ? [n] : [n, bare, `boss-${bare}`]
}

export function parseSalaryK(salaryStr) {
  const str = String(salaryStr ?? '')
  if (!str.trim()) return null
  const range = str.match(/([\d.]+)\s*[-~]\s*([\d.]+)\s*[Kk千]/)
  if (range) {
    return { low: Number(range[1]), high: Number(range[2]) }
  }
  const single = str.match(/([\d.]+)\s*[Kk千]/)
  if (single) {
    const v = Number(single[1])
    return { low: v, high: v }
  }
  return null
}

export function matchesSalaryRange(salaryStr, config) {
  const minCfg = Number(config?.salaryMin)
  const maxCfg = Number(config?.salaryMax)
  if (!minCfg && !maxCfg) return true

  const parsed = parseSalaryK(salaryStr)
  if (!parsed) return true

  const min = minCfg || 0
  const max = maxCfg || 999
  return parsed.high >= min && parsed.low <= max
}

export function matchesExcludeKeywords(text, excludeKeywords = []) {
  if (!excludeKeywords?.length) return false
  const hay = String(text ?? '')
  return excludeKeywords.some((word) => word && hay.includes(word))
}

export function matchesJobSearchConfig(job, config) {
  const blacklist = config?.blacklistCompanies ?? []
  const additional = config?.excludeOutsourcingCompanies ?? []
  const allBlocked = [...blacklist, ...additional]

  for (const name of allBlocked) {
    if (!name) continue
    // 模糊匹配：公司名包含黑名单关键词（如「软通动力」命中「软通动力信息技术有限公司」）
    if (job.company && String(job.company).includes(name)) {
      return { ok: false, reason: `已过滤公司：${name}` }
    }
  }

  const blob = [job.title, job.company, job.jobRequirement].join('\n')
  if (matchesExcludeKeywords(blob, config?.excludeKeywords)) {
    return { ok: false, reason: '命中排除关键词' }
  }

  if (!matchesSalaryRange(job.salary, config)) {
    return { ok: false, reason: '薪资不在配置区间' }
  }

  return { ok: true }
}
