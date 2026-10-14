/**
 * 把豆包语音这边能问的都问一遍，拿到服务端的原话。
 *
 * 403 只说明"没权限"，不说明为什么。这个脚本：
 *   1. 逐个试流式识别的四种资源 id，并把 403 的响应体也读出来；
 *   2. 用同一个 Key 调一次录音文件识别（HTTP，故意给一个下不动的地址，
 *      不会真的转写、不产生时长费用），看这个 Key 对语音服务本身有没有权限。
 *
 *   node probe-resources.mjs
 */

import { randomUUID } from 'node:crypto'

import { configFilePath, credentialStyle, loadConfig } from './lib/config.js'

const WebSocket = (await import('ws')).default

const config = loadConfig()
console.log(`密钥文件: ${configFilePath()}`)
console.log(`鉴权方式: ${credentialStyle(config)}`)
console.log(`接口: ${config.endpoint}\n`)

if (credentialStyle(config) === 'none') {
  console.log('还没配置识别凭据。')
  process.exit(2)
}

function authHeaders(resourceId, overrideKey) {
  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1',
    'X-Api-Connect-Id': randomUUID(),
  }
  if (config.appId) headers['X-Api-App-Key'] = config.appId
  if (config.accessToken) headers['X-Api-Access-Key'] = config.accessToken
  const key = overrideKey ?? config.apiKey
  if (key) headers['X-Api-Key'] = key
  return headers
}

/** 只做握手；失败时把响应体也读出来。 */
function probeWebSocket(resourceId, overrideKey) {
  return new Promise((resolve) => {
    const socket = new WebSocket(config.endpoint, { headers: authHeaders(resourceId, overrideKey), handshakeTimeout: 15000 })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try {
        socket.terminate()
      } catch {
        // 已经关了
      }
      resolve(result)
    }
    socket.on('open', () => done({ ok: true }))
    socket.on('unexpected-response', (_request, response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').trim()
        done({
          ok: false,
          detail: `${response.statusCode} ${response.statusMessage ?? ''}`.trim(),
          apiCode: response.headers['x-api-status-code'] ?? '',
          apiMessage: response.headers['x-api-message'] ?? '',
          body: body.slice(0, 300),
        })
      })
      response.on('error', () => done({ ok: false, detail: `${response.statusCode}` }))
    })
    socket.on('error', (error) => done({ ok: false, detail: error.message }))
  })
}

/** 录音文件识别的 HTTP 接口：申请参数校验，不会真的转写。 */
async function probeHttp(resourceId, endpoint) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(resourceId) },
      // 故意给一个下不动的地址：服务端会在下载阶段失败，不会产生转写时长
      body: JSON.stringify({
        user: { uid: 'dsh-voice-probe' },
        audio: { url: 'https://example.invalid/probe.wav', format: 'wav' },
        request: { model_name: 'bigmodel' },
      }),
      signal: AbortSignal.timeout(20000),
    })
    const text = await response.text()
    return {
      ok: response.ok,
      detail: `HTTP ${response.status}`,
      apiCode: response.headers.get('X-Api-Status-Code') ?? '',
      apiMessage: response.headers.get('X-Api-Message') ?? '',
      body: text.trim().slice(0, 300),
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function report(label, result) {
  const bits = [result.detail, result.apiCode && `X-Api-Status-Code=${result.apiCode}`, result.apiMessage && `X-Api-Message=${result.apiMessage}`]
    .filter(Boolean)
    .join('  ')
  console.log(`  ${result.ok ? '✓' : '✗'}  ${label}　→ ${bits}`)
  if (result.body) console.log(`        响应体: ${result.body.replace(/\s+/g, ' ')}`)
}

console.log('── 流式识别（本插件用的） ──')
const streaming = [
  ['volc.seedasr.sauc.duration', '流式 2.0 小时版'],
  ['volc.seedasr.sauc.concurrent', '流式 2.0 并发版'],
  ['volc.bigasr.sauc.duration', '流式 1.0 小时版'],
  ['volc.bigasr.sauc.concurrent', '流式 1.0 并发版'],
]
let working = null
for (const [resourceId, label] of streaming) {
  const result = await probeWebSocket(resourceId)
  report(`${resourceId}（${label}）`, result)
  if (result.ok) working ??= resourceId
}

console.log('\n── 录音文件识别（另一条产品线，用来判断"到底是什么没开通"） ──')
// 标准版走 submit 接口，极速版走 flash 接口；把两代的都列出来，
// 这样能区分"整个语音服务都没开通"和"开通了别的产品、唯独没开流式"。
const flash = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
const submit = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const http = [
  ['volc.seedasr.auc_turbo', '录音文件识别 2.0 极速版', flash],
  ['volc.bigasr.auc_turbo', '录音文件识别 1.0 极速版', flash],
  ['volc.seedasr.auc', '录音文件识别 2.0 标准版', submit],
  ['volc.bigasr.auc', '录音文件识别 1.0 标准版', submit],
]
let grantedOther = null
for (const [resourceId, label, endpoint] of http) {
  const result = await probeHttp(resourceId, endpoint)
  report(`${resourceId}（${label}）`, result)
  // 只要不是"没授权"，就说明这个 Key 对该资源是有权限的
  if (!(result.body ?? '').includes('not granted') && !(result.apiMessage ?? '').includes('not granted')) {
    grantedOther ??= `${resourceId}（${label}）`
  }
}

console.log('\n── 对照实验：故意用一个乱编的 Key ──')
// 如果乱编的 Key 报的错和真 Key 一模一样，那"resource not granted"就说明不了
// Key 是否有效，就不能拿它下结论。
const control = await probeWebSocket('volc.seedasr.sauc.duration', randomUUID())
report('乱编的 Key → volc.seedasr.sauc.duration', control)
const controlBody = control.body ?? ''
const realBody = 'requested resource not granted'
console.log(
  control.ok
    ? '  ⚠ 乱编的 Key 居然握手成功了，说明这个错误检测不成立，需要换一种判断方式。'
    : controlBody.includes('not granted')
      ? '  → 乱编的 Key 得到的是同一种错误，所以这句话只说明"没授权"，不能证明 Key 有效。'
      : `  → 乱编的 Key 得到的是不同的错误，说明真 Key 至少被服务端认出来了（真 Key 的错误体含 "${realBody}"）。`,
)

console.log('')
if (working) {
  console.log(`结论：流式识别能用的资源 id 是 ${working}。`)
  if (working !== config.resourceId) console.log(`把配置里的 resourceId 改成它即可。`)
} else if (grantedOther) {
  console.log(`结论：流式识别全部没授权，但 ${grantedOther} 是有权限的。`)
  console.log('说明这个 Key 是有效的、也在对的项目里，只是"流式语音识别"这个模型没开通。')
  console.log('去 https://console.volcengine.com/speech/new/ 的「语音识别」里开通它（或点【试用】）。')
} else {
  console.log('结论：所有语音识别资源都返回 requested resource not granted。')
  console.log('Key 本身有效（对照实验证明），但名下没有授权任何语音识别资源。')
  console.log('去 https://console.volcengine.com/speech/new/ ：')
  console.log('  1) 先看左上角「项目」——Key 与模型必须在同一个项目下')
  console.log('  2) 左侧「语音识别」→「豆包流式语音识别模型 2.0」→ 点【试用】或【开通】')
}
process.exitCode = working ? 0 : 1
