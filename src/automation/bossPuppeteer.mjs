import { addLogEntry } from '../store.js'

/** puppeteer-extra 为单例，重复 .use() 会叠插件导致 launch 异常，只注册一次 */
let bossPluginsReady = false

/**
 * 与 Geek 投递同款：stealth + laodeng + anonymize-ua
 * 采集 / 登录 / 投递应共用，否则仅 stealth 仍易被 BOSS 识别为自动化（环境异常、黑屏）
 */
export async function resolveBossPuppeteer() {
  let puppeteer
  try {
    const imported = await import('puppeteer-extra')
    puppeteer = imported.default
  } catch {
    await addLogEntry('error', 'puppeteer-extra 未安装，回退到 puppeteer')
    const stdPuppeteer = await import('puppeteer')
    puppeteer = stdPuppeteer.default
    return { puppeteer }
  }

  if (!bossPluginsReady) {
    try {
      const stealth = (await import('puppeteer-extra-plugin-stealth')).default
      puppeteer.use(stealth())
    } catch (e) {
      await addLogEntry('warning', `Stealth 插件加载失败：${e.message}`)
    }
    try {
      const laodengMod = await import('@geekgeekrun/puppeteer-extra-plugin-laodeng')
      const Laodeng = laodengMod.default ?? laodengMod
      puppeteer.use(Laodeng())
      await addLogEntry('info', '已加载 laodeng 反检测插件（Geek 同款）')
    } catch (e) {
      await addLogEntry('warning', `laodeng 插件未加载：${e.message}`)
    }
    try {
      const anonymize = (await import('puppeteer-extra-plugin-anonymize-ua')).default
      puppeteer.use(anonymize({ makeWindows: false }))
    } catch (e) {
      await addLogEntry('warning', `UA 匿名插件加载失败：${e.message}`)
    }
    bossPluginsReady = true
    await addLogEntry('info', 'BOSS 浏览器反检测已就绪（stealth + laodeng + anonymize-ua）')
  }

  return { puppeteer }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 若进入 BOSS 安全校验页，等待用户手动完成（最多 maxWaitMs）
 * @param {import('puppeteer').Page} page
 */
export async function waitThroughBossSecurityCheck(page, maxWaitMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    if (page.isClosed()) return false
    const url = page.url()
    if (!/security-check|security|_security_check/i.test(url)) {
      return true
    }
    await sleep(2000)
  }
  await addLogEntry('warning', '安全校验等待超时，请在本机 Chrome 手动打开 BOSS 完成验证后重试')
  return false
}
