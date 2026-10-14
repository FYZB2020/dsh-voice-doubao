/**
 * 打包 dsh-voice-doubao。
 *
 * 产出两份东西，**故意分开**：
 *
 *   1. dist/dsh-voice-doubao-<版本>.zip   —— 插件包，不含任何密钥，可以发布/发给别人
 *   2. dist/我的密钥-勿外传/              —— 只有你自己用的那份，里面是明文密钥
 *
 * 分开的理由：密钥绝不能混进要发给别人的包里。这两件事一旦混在一个文件里，
 * 迟早会有人把带密钥的包发出去。
 *
 *   node tools/make-package.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(dirname(root), 'dist')
const stage = join(dist, 'dsh-voice-doubao')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** 要打进插件包的东西。目录用 { from, to } 形式逐个列清楚，避免手滑带进密钥或临时文件。 */
const contents = [
  { from: 'package.json' },
  { from: 'cordis.patch.yml' },
  { from: 'LICENSE' },
  { from: 'install.mjs' },
  { from: 'doctor.mjs' },
  { from: 'probe-resources.mjs' },
  { from: '安装.cmd' },
  { from: '体检.cmd' },
  { from: '使用说明.md' },
  { from: '技术说明.md' },
  { from: 'README.md' },
  { from: 'lib' },
  // 测试留着：别人可以自己跑一遍验证，也是"这东西敢给你看"的凭据
  { from: 'test', skip: ['sample-long.wav', 'sample-60s.wav', 'sample-silence.wav', 'sample-lead-silence.wav'] },
  // 自带依赖：不带上它，流式通道在别人机器上会缺 ws
  { from: 'node_modules/ws' },
]

console.log(`打包 dsh-voice-doubao@${version}`)
console.log(`  源目录 : ${root}`)
console.log(`  输出   : ${dist}\n`)

// --- 1. 铺干净的一层 ---------------------------------------------------------
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

let fileCount = 0
for (const item of contents) {
  const from = join(root, item.from)
  if (!existsSync(from)) {
    console.error(`✗ 缺少 ${item.from}`)
    process.exit(1)
  }
  const to = join(stage, item.from)
  // dereference：把 junction/软链接解开成真实文件，否则别人解压出来是一堆坏链接
  cpSync(from, to, { recursive: true, dereference: true })
  if (item.skip) for (const name of item.skip) rmSync(join(to, name), { force: true })
  fileCount += countFiles(to)
  console.log(`  + ${item.from}`)
}

/**
 * 数一个路径下的文件个数（用于报告）。
 * @param {string} path - 目录或文件。
 * @returns {number} 文件数。
 */
function countFiles(path) {
  const info = statSync(path)
  if (info.isFile()) return 1
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(path, entry.name)) : 1
  }
  return total
}

// 保险丝：.cmd 必须是 CRLF 换行。
//
// Windows 的 cmd.exe 只认 CRLF；LF 换行的 .cmd 会被逐行错位解析，双击直接报一堆
// "不是内部或外部命令"。这个坑我踩过一次，所以把它钉成打包前的硬检查。
for (const name of ['安装.cmd', '体检.cmd']) {
  const full = join(stage, name)
  const bytes = readFileSync(full)
  let bareLf = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && (i === 0 || bytes[i - 1] !== 13)) bareLf++
  }
  if (bareLf > 0) {
    console.error(`✗ ${name} 里有 ${bareLf} 个裸 LF 换行，cmd.exe 会解析错乱。请转成 CRLF 再打包。`)
    process.exit(1)
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    console.error(`✗ ${name} 带 UTF-8 BOM，cmd.exe 会把它当成命令的一部分。`)
    process.exit(1)
  }
}
console.log('✓ .cmd 换行与编码检查通过（CRLF、无 BOM）')

// 保险丝：插件包里绝不能出现密钥
const secrets = ['voice-doubao.json', '.env', 'keys.json']
for (const name of secrets) {
  if (existsSync(join(stage, name))) {
    console.error(`✗ 插件包里出现了 ${name}，拒绝打包`)
    process.exit(1)
  }
}
// 再扫一遍内容里有没有 ark- 开头的 Key
let leaked = ''
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      scan(full)
    } else if (/\.(mjs|js|json|md|yml|yaml|txt)$/.test(entry.name)) {
      const text = readFileSync(full, 'utf8')
      const hit = text.match(/ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{5}/)
      if (hit) leaked = `${relative(stage, full)}: ${hit[0].slice(0, 12)}…`
    }
  }
}
scan(stage)
if (leaked) {
  console.error(`✗ 插件包里发现疑似密钥：${leaked}`)
  process.exit(1)
}
console.log(`\n✓ 插件包已铺好：${fileCount} 个文件，未发现密钥`)

// --- 2. 压成 zip -------------------------------------------------------------
const zip = join(dist, `dsh-voice-doubao-${version}.zip`)
rmSync(zip, { force: true })
const { execFileSync } = await import('node:child_process')
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path "${stage}" -DestinationPath "${zip}" -CompressionLevel Optimal -Force`],
  { stdio: 'inherit' },
)
const zipKb = Math.round(statSync(zip).size / 1024)
console.log(`✓ 插件包：${zip}  (${zipKb} KB)`)

// --- 3. 单独的一份密钥（只给自己）-------------------------------------------
const configPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voice-doubao.json')
const privateDir = join(dist, '我的密钥-勿外传')
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  rmSync(privateDir, { recursive: true, force: true })
  mkdirSync(privateDir, { recursive: true })
  // 直接写成可以用的配置文件：复制到新电脑的 %USERPROFILE%\.dsh\ 下就行
  writeFileSync(
    join(privateDir, 'voice-doubao.json'),
    `${JSON.stringify(
      {
        _警告: '这个文件里有明文密钥。只用于你自己的另一台电脑，不要发给任何人、不要传到网上。',
        _怎么用: '复制到新电脑的 %USERPROFILE%\\.dsh\\voice-doubao.json（覆盖同名文件），然后重启 DeepSeek Harness 即可，不用再申请。',
        _这是谁的: '你自己的「豆包语音」API Key 和「火山方舟」API Key。',
        apiKey: config.apiKey ?? '',
        arkApiKey: config.arkApiKey ?? '',
        arkModel: config.arkModel ?? 'doubao-seed-2-1-lite-260915',
        polish: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(privateDir, '说明.txt'),
    [
      '这份是你的密钥，不要外传。',
      '',
      '内容：',
      '  voice-doubao.json  —— 里面是你的两个 Key（明文）',
      '',
      '用法（换电脑/第二台电脑）：',
      '  1. 先按「使用说明.md」把插件装上（那个包可以随便传）',
      '  2. 把这个 voice-doubao.json 复制到：',
      '       %USERPROFILE%\\.dsh\\voice-doubao.json',
      '     （如果那儿已经有同名文件，直接覆盖）',
      '  3. 重启 DeepSeek Harness —— 完事，不用重新申请 Key',
      '',
      '注意：',
      '  · 这个文件等于你的账号使用权。别放进任何要分享的文件夹。',
      '  · 想给别人用，让对方自己去领免费额度（20 小时/半年），不要给这个文件。',
      '',
    ].join('\n'),
    'utf8',
  )
  const mask = (value) => (value ? `${String(value).slice(0, 4)}…${String(value).slice(-4)}（${String(value).length} 位）` : '（空）')
  console.log(`✓ 密钥包：${privateDir}`)
  console.log(`    apiKey    ${mask(config.apiKey)}`)
  console.log(`    arkApiKey ${mask(config.arkApiKey)}`)
} else {
  console.log(`· 没找到 ${configPath}，跳过密钥包`)
}

console.log(`
完成。两份东西：
  ${zip}
      → 可以发布、可以发给朋友。里面没有任何密钥。
  ${privateDir}
      → 只给你自己（或你自己的第二台电脑）。里面有明文密钥，别外传。
`)
