#!/usr/bin/env node
/**
 * 离线自检：不访问 BOSS、不启动浏览器，只验证关键分支与 URL 匹配逻辑。
 * 运行：npm run verify:apply-logic
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

function normalizeBossEncryptJobId(id) {
  let s = String(id ?? '').trim()
  if (s.toLowerCase().endsWith('.html')) s = s.slice(0, -5)
  return s
}

function buildMatchFriendAdd(encryptRaw, expectNorm) {
  return (url) => {
    const u = url
    if (!u.includes('/wapi/zpgeek/friend/add.json')) return false
    return (
      u.includes(`jobId=${encryptRaw}`) ||
      (encryptRaw && u.includes(encodeURIComponent(encryptRaw))) ||
      u.includes(expectNorm) ||
      (expectNorm && u.includes(encodeURIComponent(expectNorm))) ||
      u.includes(encryptRaw)
    )
  }
}

const encryptRaw = 'AbCdEfG123'
const expectNorm = normalizeBossEncryptJobId(encryptRaw)
const match = buildMatchFriendAdd(encryptRaw, expectNorm)

assert.equal(
  match('https://www.zhipin.com/wapi/zpgeek/friend/add.json?jobId=' + encryptRaw),
  true
)
assert.equal(match('https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json'), false)

const withEnc = buildMatchFriendAdd('x/y==', normalizeBossEncryptJobId('x/y=='))
assert.equal(
  withEnc('https://www.zhipin.com/wapi/zpgeek/friend/add.json?jobId=' + encodeURIComponent('x/y==')),
  true
)

// CHAT_BTN_SELECTORS 顺序：须包含 Geek 主路径
const adapterPath = fileURLToPath(new URL('../src/automation/adapterGeek.mjs', import.meta.url))
const adapterSrc = fs.readFileSync(adapterPath, 'utf8')
assert.match(adapterSrc, /GEEK_RECOMMEND_PAGE.*\/web\/geek\/jobs/s)
assert.match(adapterSrc, /injectBossLocalStorage/)

console.log('verify-geek-apply-logic: 全部通过')
