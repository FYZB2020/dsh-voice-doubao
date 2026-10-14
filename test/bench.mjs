/**
 * 两条通道的真实耗时基准。
 *
 * 为什么要量：实测下来流式在短句上更快，在长录音上反而更慢——交叉点不靠猜，
 * 量出来再决定默认值。这个脚本直接调生产代码（lib/engine.js），只跳过 UI 那层。
 *
 *   node test/bench.mjs [每档轮数]
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadConfig } from '../lib/config.js'
import { transcribeRecording } from '../lib/engine.js'
import { readWave } from '../lib/wav.js'

const here = dirname(fileURLToPath(import.meta.url))
const rounds = Number(process.argv[2] ?? 3)

const samples = ['sample-short.wav', 'sample-zh.wav', 'sample-lead-silence.wav', 'sample-long.wav', 'sample-60s.wav']
const base = loadConfig()
if (!base.apiKey) {
  console.log('没有配置识别凭据，先填 apiKey。')
  process.exit(2)
}

/**
 * 跑一轮并计时。
 * @param {Buffer} audio - 规范 WAV。
 * @param {'submit'|'stream'} transport - 通道。
 * @returns {Promise<number>} 毫秒。
 */
async function timed(audio, transport) {
  const config = { ...base, transport }
  const started = Date.now()
  await transcribeRecording({ audio, language: 'auto', config })
  return Date.now() - started
}

const rows = []
for (const name of samples) {
  const audio = readFileSync(join(here, name))
  const seconds = readWave(audio).audioSeconds
  const result = { name, seconds, submit: [], stream: [] }
  for (let round = 0; round < rounds; round++) {
    // 交替顺序，避免总是后跑的那个吃亏或占便宜
    if (round % 2 === 0) {
      result.submit.push(await timed(audio, 'submit'))
      result.stream.push(await timed(audio, 'stream'))
    } else {
      result.stream.push(await timed(audio, 'stream'))
      result.submit.push(await timed(audio, 'submit'))
    }
  }
  const avg = (list) => Math.round(list.reduce((sum, value) => sum + value, 0) / list.length)
  result.submitAvg = avg(result.submit)
  result.streamAvg = avg(result.stream)
  rows.push(result)
  console.log(
    `${name.padEnd(26)} ${seconds.toFixed(1).padStart(5)}s  ` +
      `提交+轮询 ${String(result.submitAvg).padStart(5)}ms  ` +
      `流式 ${String(result.streamAvg).padStart(5)}ms  ` +
      `→ ${result.streamAvg < result.submitAvg ? '流式更快' : '提交更快'}`,
  )
}

console.log('\n各档原始数据：')
for (const row of rows) {
  console.log(`  ${row.name.padEnd(26)} 提交 ${row.submit.join(',')}  流式 ${row.stream.join(',')}`)
}
