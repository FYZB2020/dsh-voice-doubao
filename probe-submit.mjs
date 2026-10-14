/**
 * 用一个【已授权】的资源，直接问服务端：录音文件识别的 audio 到底收不收 base64。
 *
 * 背景：早先没能验证这件事——文档只写了 audio.url，官方示例也都传 url，但那时账号
 * 没有任何资源被授权，任何请求都停在 403，问不到正文。现在 volc.seedasr.auc 已授权，
 * 就可以直接把这段音频的 base64 塞进 audio.data，看服务端认不认。
 *
 *   node probe-submit.mjs
 *
 * 只提交一次 9 秒样本，费用约 0.002 元。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { configFilePath, credentialStyle, loadConfig } from './lib/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const config = loadConfig()
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const QUERY = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'
const RESOURCE_ID = 'volc.seedasr.auc' // 录音文件识别 2.0 标准版（已授权）

console.log(`密钥文件: ${configFilePath()}`)
console.log(`鉴权方式: ${credentialStyle(config)}`)
if (credentialStyle(config) === 'none') {
  console.log('还没配置识别凭据。')
  process.exit(2)
}

const wav = readFileSync(join(here, 'test', 'sample-zh.wav'))
const base64 = wav.toString('base64')
console.log(`素材: test/sample-zh.wav　${wav.length} 字节　base64 ${base64.length} 字符\n`)

function headers(requestId) {
  const out = {
    'content-type': 'application/json',
    'X-Api-Resource-Id': RESOURCE_ID,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  }
  if (config.appId) out['X-Api-App-Key'] = config.appId
  if (config.accessToken) out['X-Api-Access-Key'] = config.accessToken
  if (config.apiKey) out['X-Api-Key'] = config.apiKey
  return out
}

function show(label, response, body) {
  console.log(`${label}: HTTP ${response.status}　X-Api-Status-Code=${response.headers.get('X-Api-Status-Code') ?? ''}　X-Api-Message=${response.headers.get('X-Api-Message') ?? ''}`)
  if (body) console.log(`  响应体: ${body.slice(0, 500).replace(/\s+/g, ' ')}`)
}

const requestId = randomUUID()

console.log('── 试 A：把音频 base64 放进 audio.data ──')
const submitA = await fetch(ENDPOINT, {
  method: 'POST',
  headers: headers(requestId),
  body: JSON.stringify({
    user: { uid: 'dsh-voice-probe' },
    audio: { format: 'wav', data: base64 },
    request: { model_name: 'bigmodel', enable_itc: undefined },
  }),
  signal: AbortSignal.timeout(30000),
})
const bodyA = await submitA.text()
show('提交结果', submitA, bodyA)
const codeA = submitA.headers.get('X-Api-Status-Code')

if (codeA === '20000000') {
  console.log('\n→ 服务端接受了 base64！等一下再查询结果……')
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const query = await fetch(QUERY, {
      method: 'POST',
      headers: headers(requestId),
      body: '{}',
      signal: AbortSignal.timeout(30000),
    })
    const bodyQ = await query.text()
    const codeQ = query.headers.get('X-Api-Status-Code')
    console.log(`  第 ${attempt} 次查询：X-Api-Status-Code=${codeQ} ${query.headers.get('X-Api-Message') ?? ''}`)
    if (codeQ === '20000000') {
      let text = ''
      try {
        text = JSON.parse(bodyQ)?.result?.text ?? ''
      } catch {
        // 不是 JSON 就把原文打出来
      }
      console.log(`\n识别结果：${text || '(没有解析到 result.text)'}`)
      if (!text) console.log(`原始响应：${bodyQ.slice(0, 600)}`)
      break
    }
    if (codeQ !== '20000001' && codeQ !== '20000002') {
      console.log(`  查询失败：${bodyQ.slice(0, 400)}`)
      break
    }
  }
} else {
  console.log('\n→ 服务端没接受 base64（见上面的 code/message）。')
  console.log('  这印证了文档的写法：这条产品线要 audio.url，必须先把音频托管到公网。')
  console.log('\n── 试 B：换成 audio.url（指向一个下不动的地址），看是不是只缺 url ──')
  const submitB = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(randomUUID()),
    body: JSON.stringify({
      user: { uid: 'dsh-voice-probe' },
      audio: { url: 'https://example.invalid/none.wav', format: 'wav' },
      request: { model_name: 'bigmodel' },
    }),
    signal: AbortSignal.timeout(30000),
  })
  show('提交结果', submitB, await submitB.text())
}
