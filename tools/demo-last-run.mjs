/**
 * 演示"最近一次识别"那行是怎么来的。
 *
 * 用一个**临时 DSH_HOME**（绝不碰真实文件），把插件挂到一个最小 ctx 上，
 * 拿真实录音打真实豆包 + 真实方舟，然后跑 doctor 看它打印什么。
 *
 *   node tools/demo-last-run.mjs
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const demoHome = mkdtempSync(join(tmpdir(), 'vd-demo-'))
process.env.DSH_HOME = demoHome
process.env.DSH_PROFILE_DIR = join(demoHome, 'profiles', 'desktop')

// 把真实密钥复制进临时家目录（只读地拷一份，不动原件）
const realConfig = join(realHome, 'voice-doubao.json')
if (!existsSync(realConfig)) {
  console.error('找不到 ' + realConfig)
  process.exit(2)
}
copyFileSync(realConfig, join(demoHome, 'voice-doubao.json'))
console.log(`临时 DSH_HOME: ${demoHome}\n（你的真实状态文件不会被碰）\n`)

const { apply } = await import(new URL('../lib/index.js', import.meta.url))

/** 抓住插件注册出来的识别器。 */
const registered = new Map()
const ctx = {
  logger: { warn: () => void 0 },
  effect: (run) => {
    run()
  },
  speechToText: {
    register: (provider) => {
      registered.set(provider.info.id, provider)
      return async () => registered.delete(provider.info.id)
    },
    snapshot: () => ({ providers: [], selection: { providerId: 'doubao-polished', language: 'auto' } }),
  },
}

apply(ctx, {})
console.log('注册出的识别器：' + [...registered.keys()].join(', '))

const audio = readFileSync(join(root, 'test', 'sample-zh.wav'))
console.log(`\n拿真实录音打真实服务（${(audio.length / 32000).toFixed(1)} 秒）…`)
const started = Date.now()
const result = await registered.get('doubao-polished').transcribe({ audio, language: 'auto' }, undefined)
console.log(`等了 ${((Date.now() - started) / 1000).toFixed(2)} 秒，转出来：${result.text}\n`)

console.log('='.repeat(72))
console.log('现在跑 doctor（同一个临时家目录），看"最近一次识别"那行：\n')
// doctor 在"有待处理项"时会以退出码 1 结束——这是正常行为，不是失败。
let out = ''
try {
  out = execFileSync(process.execPath, [join(root, 'doctor.mjs')], { env: { ...process.env }, encoding: 'utf8' })
} catch (error) {
  out = error.stdout ?? ''
}
for (const line of out.split('\n')) {
  if (/最近一次|当前选中|项正常/.test(line)) console.log(line)
}
console.log('='.repeat(72))
console.log('\n临时目录里的状态文件内容（这就是那行的数据来源）：')
const status = JSON.parse(readFileSync(join(demoHome, 'voice-doubao.status.json'), 'utf8'))
console.log(JSON.stringify(status.lastRun, null, 2))

// 收摊：临时家目录里有一份密钥副本，不能留在磁盘上
rmSync(demoHome, { recursive: true, force: true })
console.log('\n（临时目录已删除，你的真实状态文件全程没被碰过）')
