import { addLogEntry } from '../store.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(__dirname, '../../data')
const BOSS_PROFILE_DIR = path.join(dataDir, 'boss-browser-profile')

function ensureProfileDir() {
  if (!fs.existsSync(BOSS_PROFILE_DIR)) {
    fs.mkdirSync(BOSS_PROFILE_DIR, { recursive: true })
    fs.mkdirSync(path.join(BOSS_PROFILE_DIR, 'Default'), { recursive: true })
  }
}

/** BOSS 场景下降低自动化痕迹的 Chromium 参数（与 stealth 互补） */
const DEFAULT_BOSS_CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--window-size=1440,900',
  '--lang=zh-CN,zh;q=0.9',
  '--restore-last-session'
]

/**
 * 依次尝试多种方式启动可视浏览器（BOSS 自动化用）
 * 默认优先 Puppeteer 自带的 Chromium（与多数用户此前能投递成功时的环境一致）；
 * 若需优先本机 Google Chrome：启动前设置环境变量 HAITOU_PREFER_SYSTEM_CHROME=1，或传 preferSystemChrome: true。
 * @param {import('puppeteer').PuppeteerNode} puppeteer
 * @param {import('puppeteer').LaunchOptions & { preferSystemChrome?: boolean }} [options]
 */
export async function launchBossBrowser(puppeteer, options = {}) {
  const { defaultViewport, args: extraArgs, preferSystemChrome, ...rest } = options
  const useSystemChromeFirst =
    preferSystemChrome === true || process.env.HAITOU_PREFER_SYSTEM_CHROME === '1'
  const mergedArgs = [...DEFAULT_BOSS_CHROME_ARGS, ...(extraArgs?.length ? extraArgs : [])]
  ensureProfileDir()
  const common = {
    headless: false,
    acceptInsecureCerts: true,
    userDataDir: BOSS_PROFILE_DIR,
    args: mergedArgs,
    ...(defaultViewport ? { defaultViewport } : {}),
    ...rest
  }

  /** @type {Array<[string, () => Promise<import('puppeteer').Browser>]>} */
  const attempts = []

  const exe = process.env.PUPPETEER_EXECUTABLE_PATH?.trim()
  if (exe) {
    attempts.push([
      '环境变量 PUPPETEER_EXECUTABLE_PATH',
      () => puppeteer.launch({ ...common, executablePath: exe })
    ])
  }

  const bundled = () => puppeteer.launch({ ...common })
  const channelChrome = () =>
    puppeteer.launch({
      ...common,
      channel: 'chrome'
    })

  if (useSystemChromeFirst) {
    attempts.push(['本机 Google Chrome（channel: chrome）', channelChrome])
    attempts.push(['Puppeteer 下载的 Chromium', bundled])
  } else {
    attempts.push(['Puppeteer 下载的 Chromium', bundled])
    attempts.push(['本机 Google Chrome（channel: chrome）', channelChrome])
  }

  let lastErr
  for (const [label, fn] of attempts) {
    try {
      const browser = await fn()
      await addLogEntry('info', `浏览器已启动：${label}`)
      return browser
    } catch (e) {
      lastErr = e
      await addLogEntry('warning', `启动失败 [${label}]：${e.message}`)
    }
  }

  await addLogEntry(
    'error',
    `无法启动浏览器。bundled Chromium 与系统 Chrome 均失败：${lastErr?.message ?? 'unknown'}。可在项目目录执行：npx puppeteer browsers install chrome；或安装 Google Chrome；或设置 PUPPETEER_EXECUTABLE_PATH`
  )
  throw lastErr
}
