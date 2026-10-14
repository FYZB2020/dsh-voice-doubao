/**
 * Live check: run one recording through the exact production code path against
 * the real Doubao streaming endpoint, and print what came back.
 *
 * This is the step that needs a real API Key; everything else is covered by
 * `offline.test.mjs` (unit + protocol + fallbacks) and by the Cordis
 * integration check (mount + service contract).
 *
 * Usage:
 *   node test/live.mjs                    用自带的中文样本 test/sample-zh.wav
 *   node test/live.mjs <某个.wav>         用你自己的录音（必须 16kHz 单声道 PCM16）
 *   node test/live.mjs --asr-only         只验证识别，不验证顺稿
 *   node test/live.mjs --mock             不联网：用本地假服务验证脚本本身
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { credentialStyle, configFilePath, loadConfig, polishAvailable, redacted } from '../lib/config.js'
import { polishTranscript } from '../lib/ark.js'
import { transcribeRecording } from '../lib/engine.js'
import { shouldPolish } from '../lib/polish.js'
import { readWave } from '../lib/wav.js'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((item) => item.startsWith('--')))
const positional = argv.filter((item) => !item.startsWith('--'))

/** Local stand-ins for both services, so this script can be checked without a key. */
async function startMocks() {
  const { startMockSauc } = await import('./mock-sauc.mjs')
  const asr = await startMockSauc({ text: '嗯 那个 就是 我想 说 一下 我们 把 这个 语音识别 的 接口 先 接 上' })
  const ark = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '我想说一下，我们把这个语音识别的接口先接上。' } }] }))
    })
  })
  await new Promise((resolve) => ark.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: asr.url,
    arkEndpoint: `http://127.0.0.1:${ark.address().port}/chat`,
    close: async () => {
      await asr.close()
      await new Promise((resolve) => ark.close(resolve))
    },
  }
}

const mock = flags.has('--mock') ? await startMocks() : null
const config = loadConfig(
  mock ? { endpoint: mock.endpoint, arkEndpoint: mock.arkEndpoint, apiKey: 'mock', arkApiKey: 'mock' } : {},
)

console.log('=== 配置 ===')
console.log(`密钥文件      : ${configFilePath()}`)
console.log(`鉴权方式      : ${credentialStyle(config)}`)
console.log(`顺稿          : ${polishAvailable(config) ? '开' : '关（没有 arkApiKey）'}`)
console.log(`识别通道      : ${config.transport}`)
console.log(`识别接口      : ${config.transport === 'stream' ? config.endpoint : config.submitEndpoint}`)
console.log(`资源 id       : ${config.transport === 'stream' ? config.resourceId : config.submitResourceId}`)
console.log(`其余配置      : ${JSON.stringify(redacted(config))}`)

if (credentialStyle(config) === 'none' && !mock) {
  console.log('\n还没有配密钥，先把这个填上再跑：')
  console.log(`  ${configFilePath()}`)
  console.log('  {"apiKey": "豆包语音控制台签发的 API Key"}')
  console.log('注意：必须用「豆包语音」控制台的 Key，火山方舟的 Key 不能用于语音识别。')
  process.exitCode = 2
} else {
  const wavPath = positional[0] ?? join(here, 'sample-zh.wav')
  console.log(`\n=== 素材 ===\n${wavPath}`)
  const audio = readFileSync(wavPath)
  const wave = readWave(audio)
  console.log(
    `合法：16 kHz / ${wave.channels} 声道 / ${wave.bitsPerSample} 位，时长 ${wave.audioSeconds.toFixed(2)} 秒，${audio.length} 字节`,
  )

  console.log('\n=== 识别 ===')
  const startedAsr = Date.now()
  let raw = ''
  try {
    const result = await transcribeRecording({ audio, language: 'auto', config })
    raw = result.text
  } catch (error) {
    console.log(`失败：${error instanceof Error ? error.message : String(error)}`)
    if (/not granted/i.test(String(error?.message))) {
      console.log('\n这是"没授权"，不是 Key 的问题：去 https://console.volcengine.com/speech/new/')
      console.log('左侧「语音识别」→「豆包流式语音识别模型 2.0」→ 点【试用】或【开通】。')
      console.log('开通后跑一次 probe-resources.mjs 确认，再回来跑这个脚本。')
    } else if (/Invalid X-Api-Key/i.test(String(error?.message))) {
      console.log('\n这个 Key 无效。确认它来自「豆包语音」控制台（/speech/new/）；方舟的 Key 不能用于识别。')
    } else {
      console.log('\n跑一次 probe-resources.mjs 可以看到四种资源各自的授权状态。')
    }
    await mock?.close()
    process.exit(1)
  }
  console.log(`耗时 ${((Date.now() - startedAsr) / 1000).toFixed(2)} 秒`)
  console.log(`原文：${raw}`)

  if (polishAvailable(config) && !flags.has('--asr-only') && shouldPolish(raw)) {
    console.log('\n=== 顺稿 ===')
    const startedPolish = Date.now()
    try {
      const polished = await polishTranscript({ text: raw, config })
      console.log(`耗时 ${((Date.now() - startedPolish) / 1000).toFixed(2)} 秒`)
      console.log(`整理后：${polished}`)
    } catch (error) {
      console.log(`顺稿失败（识别结果仍然可用）：${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (!flags.has('--asr-only')) {
    console.log('\n（跳过顺稿：没有 arkApiKey，或原文太短）')
  }

  console.log('\n通过：识别这一路是通的。回到 DSH 点麦克风选「豆包听写 + 顺稿（云端）」即可。')
  await mock?.close()
}
