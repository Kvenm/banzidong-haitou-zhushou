import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 职位详情页自动探测：截图 + 结构化 JSON，供排查选择器与点击坐标
 * @param {import('puppeteer').Page} page
 * @param {object} meta
 * @param {string} meta.encryptRaw
 * @param {string} [meta.candidateTitle]
 * @param {string} [meta.company]
 * @param {string[]} [meta.selectors]
 */
export async function captureJobDetailProbe(page, meta) {
  const dir = path.join(pkgRoot, 'data', 'captures')
  await fs.mkdir(dir, { recursive: true })
  const short = String(meta.encryptRaw ?? 'job').replace(/[^\w-]+/g, '_').slice(0, 32)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${short}-${stamp}`

  const defaultSels = meta.selectors ?? []

    const probe = await page.evaluate((sels, expectEncrypt) => {
      const shortText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
      const visible = (el) => {
        if (!el || el.nodeType !== 1) return false
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return false
        const st = window.getComputedStyle(el)
        if (st.visibility === 'hidden' || st.display === 'none') return false
        return true
      }

      const html = document.documentElement.innerHTML
      const domHasExpectedEncrypt =
        !!expectEncrypt &&
        (html.includes(expectEncrypt) || html.includes(String(expectEncrypt).replace(/~$/, '')))

      const chatLike = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter((el) => {
        if (!visible(el)) return false
        const t = shortText(el)
        return /立即沟通|继续沟通|聊一聊|投简历|感兴趣/.test(t)
      })

      const mainChat = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
      const chatKa = mainChat?.getAttribute?.('ka') ?? null

      return {
        href: location.href,
        title: document.title,
        ready: document.readyState,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        domHasExpectedEncrypt,
        hasJobDetailBox: !!document.querySelector('.job-detail-box'),
        hasJobDetailOperation: !!document.querySelector('.job-detail-operation'),
        opBtnChatCount: document.querySelectorAll('.op-btn-chat, [class*="op-btn-chat"]').length,
        mainChatKa: chatKa,
        chatLikeControls: chatLike.slice(0, 15).map((el) => ({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 160),
          text: shortText(el).slice(0, 80),
          rect: (() => {
            const r = el.getBoundingClientRect()
            return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
          })()
        })),
        selectorProbe: sels.map((sel) => {
          const el = document.querySelector(sel)
          return {
            sel,
            found: !!el,
            text: el ? shortText(el).slice(0, 100) : null,
            htmlSnippet: el ? el.outerHTML.slice(0, 500) : null
          }
        })
      }
    }, defaultSels, meta.encryptRaw)

  const pngPath = path.join(dir, `${base}.png`)
  await page.screenshot({ path: pngPath, fullPage: false }).catch(() => {})

  const payload = {
    ...meta,
    createdAt: new Date().toISOString(),
    png: path.basename(pngPath),
    probe
  }
  const jsonPath = path.join(dir, `${base}.json`)
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')

  await fs.writeFile(path.join(dir, 'latest-job-detail.json'), JSON.stringify(payload, null, 2), 'utf8')
  try {
    await fs.copyFile(pngPath, path.join(dir, 'latest-job-detail.png'))
  } catch {
    //
  }

  return { jsonPath, pngPath, probe, payload}
}
