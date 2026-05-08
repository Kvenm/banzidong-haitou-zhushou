#!/usr/bin/env node
/**
 * 打开数据库中第一个「已确认」职位详情并写入 data/captures/latest-job-detail.*
 * 用法：cd haitou-assistant-next && node scripts/capture-job-detail-once.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDb } from '../src/store.js'
import { launchBossBrowser } from '../src/automation/launchBossBrowser.mjs'
import { captureJobDetailProbe } from '../src/automation/captureJobDetailProbe.mjs'
import { injectBossLocalStorage } from '../src/automation/injectBossLocalStorage.mjs'

const GEEK_JOBS = 'https://www.zhipin.com/web/geek/jobs'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(root, '..')

function normalizeBossEncryptJobId(id) {
  let s = String(id ?? '').trim()
  if (s.toLowerCase().endsWith('.html')) s = s.slice(0, -5)
  return s
}

const CHAT_BTN_SELECTORS = [
  '.job-detail-box .op-btn.op-btn-chat',
  '.job-detail-box .job-detail-operate .op-btn-chat',
  '.job-detail-operation .op-btn.op-btn-chat',
  'a.btn.btn-startchat',
  'a.btn-startchat',
  '.job-banner-operation a.btn-startchat',
  'a.op-btn.op-btn-chat',
  '.job-detail-header .op-btn.op-btn-chat',
  '.op-btn.op-btn-chat'
]

async function main() {
  const db = await readDb()
  const cookies = JSON.parse(db.auth?.bossCookieJson || '[]')
  if (!Array.isArray(cookies) || cookies.length === 0) {
    console.error('db.json 中无 bossCookieJson，无法打开已登录详情')
    process.exit(1)
  }

  const confirmed = (db.candidates || []).filter((c) => c.status === 'confirmed')
  const c = confirmed[0]
  if (!c) {
    console.error('没有 status=confirmed 的候选')
    process.exit(1)
  }

  const encryptRaw = c.raw?.encryptJobId ?? c.sourceId?.replace(/^boss-/, '')
  const expectNorm = normalizeBossEncryptJobId(encryptRaw)
  const jobUrl = `https://www.zhipin.com/job_detail/${encryptRaw}.html`

  const puppeteerMod = await import('puppeteer-extra')
  const puppeteer = puppeteerMod.default
  try {
    puppeteer.use((await import('puppeteer-extra-plugin-stealth')).default())
  } catch {
    //
  }

  const browser = await launchBossBrowser(puppeteer, {
    defaultViewport: { width: 1440, height: 900 }
  })

  const page = (await browser.pages())[0]

  for (const ck of cookies) {
    if (Object.hasOwn(ck, 'sameSite')) ck.sameSite = 'unspecified'
    try {
      await page.setCookie(ck)
    } catch {
      //
    }
  }

  const lsText = String(db.auth?.bossLocalStorageJson ?? '').trim()
  if (lsText) {
    try {
      const lsObj = JSON.parse(lsText)
      if (lsObj && typeof lsObj === 'object' && !Array.isArray(lsObj)) {
        await injectBossLocalStorage(browser, lsObj)
      }
    } catch {
      //
    }
  }

  await page.goto(GEEK_JOBS, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2500))

  await page.goto(jobUrl, { waitUntil: 'load', timeout: 60000, referer: GEEK_JOBS }).catch(async () => {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: GEEK_JOBS })
  })
  await new Promise((r) => setTimeout(r, 3500))

  for (let i = 0; i < 60; i++) {
    const u = page.url()
    if (u.includes('zhipin.com') && !u.startsWith('about:')) break
    await new Promise((r) => setTimeout(r, 250))
  }

  const { jsonPath, probe } = await captureJobDetailProbe(page, {
    encryptRaw: expectNorm,
    candidateTitle: c.title,
    company: c.company,
    selectors: CHAT_BTN_SELECTORS
  })

  console.log('已写入', path.relative(pkgRoot, jsonPath))
  console.log(JSON.stringify(probe, null, 2))

  await browser.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
