/**
 * dsh-voice-doubao 安装脚本。
 *
 * 做四件事，全部可重复执行（跑第二遍不会出问题）：
 *   1. 把本目录链接进 DSH profile 的 node_modules
 *   2. 往 profile 的 package.json 里登记依赖
 *   3. 把本插件加进 dsh.profile.bundles
 *   4. 如果没有密钥文件，生成一份带注释的模板
 *
 * 不联网、不装依赖、不动你已有的配置（只做增补，改前先备份）。
 *
 *   node install.mjs                     # 自动找 ~/.dsh/profiles/desktop
 *   node install.mjs --profile-dir <目录> # 指定 profile
 *   node install.mjs --dry-run           # 只看会改什么，不动文件
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')

/**
 * 读一个命令行开关的值。
 * @param {string} name - 开关名。
 * @returns {string} 值，没给则为空串。
 */
function flag(name) {
  const at = argv.indexOf(name)
  if (at < 0) return ''
  return argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : ''
}

// 哪个 profile 是"目标"，这件事必须保守。
//
// 踩过的坑：`DSH_PROFILE_DIR` 是 DSH 自己注入给子进程的环境变量。如果只按
// "DSH_PROFILE_DIR 优先"来算，那么任何带着自定义 DSH_HOME 的调用（测试、脚本、
// 给别人演示）都会**打到真实 profile 上**——我就这么误伤过一次。
// 所以：显式指定 DSH_HOME 时，一切都从它推导，不再理会继承来的 DSH_PROFILE_DIR。
const explicitHome = Boolean(process.env.DSH_HOME)
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const homeProfile = join(dshHome, 'profiles', 'desktop')
const inherited = process.env.DSH_PROFILE_DIR || ''
const chosen = flag('--profile-dir') || (explicitHome ? homeProfile : inherited || homeProfile)
const profileDir = resolve(chosen)
const packageJsonPath = join(profileDir, 'package.json')

// 保险：选中的 profile 不在本次 DSH_HOME 之下时，大声说出来（并说明怎么改），
// 免得"以为在演练、其实动了真配置"。
const withinHome = profileDir.toLowerCase().startsWith(resolve(dshHome).toLowerCase())
if (!withinHome && !flag('--profile-dir')) {
  console.log(`⚠ 注意：选中的 profile 不在 DSH_HOME 之下`)
  console.log(`    DSH_HOME        = ${resolve(dshHome)}`)
  console.log(`    选中的 profile  = ${profileDir}`)
  if (inherited) console.log(`    来自继承的环境变量 DSH_PROFILE_DIR = ${inherited}`)
  console.log(`    确认这是你要装的目标；要不是，加 --profile-dir 指定，或先清掉 DSH_PROFILE_DIR。\n`)
}

const PLUGIN_NAME = 'dsh-voice-doubao'
/** pnpm 的 link: 协议，路径用正斜杠最稳。 */
const linkSpec = `link:${here.replace(/\\/g, '/')}`

console.log('dsh-voice-doubao 安装')
console.log(`  插件目录 : ${here}`)
console.log(`  DSH_HOME : ${dshHome}`)
console.log(`  profile  : ${profileDir}`)
if (dryRun) console.log('  模式     : dry-run（不会改任何文件）')
console.log('')

/** 打印后退出。 */
function fail(message, hint) {
  console.error(`✗ ${message}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

if (!existsSync(packageJsonPath)) {
  fail(
    `没有找到 profile 的 package.json：${packageJsonPath}`,
    [
      '说明：',
      '  1) 确认 DeepSeek Harness 已经至少启动过一次（它会自动创建 profile）',
      '  2) 如果你用的是别的 profile 名，用 --profile-dir 指定，例如：',
      '     node install.mjs --profile-dir "%USERPROFILE%\\.dsh\\profiles\\desktop"',
      '  3) 也可以用环境变量 DSH_PROFILE_DIR 指定',
    ].join('\n'),
  )
}

let profile = null
/** 去掉 UTF-8 BOM。Windows 记事本另存为 UTF-8 会加上它，而 JSON.parse 不认。 */
const stripBom = (text) => text.replace(/^\uFEFF/, '')
try {
  profile = JSON.parse(stripBom(readFileSync(packageJsonPath, 'utf8')))
} catch (error) {
  fail(
    `profile 的 package.json 不是合法 JSON：${error.message}`,
    '先手工修好它，或者用同目录下的 package.json.bak-* 备份覆盖回去。',
  )
}

// --- 1. 依赖登记 -------------------------------------------------------------
profile.dependencies = profile.dependencies ?? {}
const before = profile.dependencies[PLUGIN_NAME]
const dependencyChanged = before !== linkSpec
profile.dependencies[PLUGIN_NAME] = linkSpec

// --- 2. bundle 清单 ----------------------------------------------------------
profile.dsh = profile.dsh ?? {}
profile.dsh.profile = profile.dsh.profile ?? {}
profile.dsh.profile.bundles = profile.dsh.profile.bundles ?? []
const bundles = profile.dsh.profile.bundles
const bundleChanged = !bundles.includes(PLUGIN_NAME)
if (bundleChanged) bundles.push(PLUGIN_NAME)

// 依赖顺序不重要，但按键名排一下让 diff 干净
profile.dependencies = Object.fromEntries(Object.entries(profile.dependencies).sort(([a], [b]) => a.localeCompare(b)))

console.log('将要做的改动：')
console.log(
  `  ${dependencyChanged ? '改' : '·'} dependencies["${PLUGIN_NAME}"] = ${linkSpec}${before && before !== linkSpec ? `（原来是 ${before}）` : ''}`,
)
console.log(`  ${bundleChanged ? '加' : '·'} dsh.profile.bundles += ${PLUGIN_NAME}`)
console.log(`  · node_modules/${PLUGIN_NAME} → ${here}`)
console.log('')

if (!dryRun) {
  // 先建链接，再改清单。
  //
  // 顺序是有讲究的：万一中途出错或被打断，留下的应该是"链接建好了、清单还没改"
  // ——那只是没生效，无害。反过来则会留下"清单指着一个不存在的目录"，
  // 那会让 DSH 启动时找不到插件。
  const modules = join(profileDir, 'node_modules')
  mkdirSync(modules, { recursive: true })
  const linkPath = join(modules, PLUGIN_NAME)
  if (existsSync(linkPath) || isLink(linkPath)) {
    if (isLink(linkPath)) {
      unlinkSync(linkPath)
    } else {
      fail(
        `${linkPath} 已存在，而且不是链接（是真实目录）。`,
        '为避免删掉你自己的文件，安装脚本不会动它。请先把它移走再跑一次。',
      )
    }
  }
  symlinkSync(here, linkPath, 'junction')
  console.log(`✓ 已创建链接 node_modules/${PLUGIN_NAME}`)

  // 备份（带时间戳，永不覆盖已有备份），然后写回
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${packageJsonPath}.bak-voice-doubao-${stamp}`
  if (!existsSync(backup)) copyFileSync(packageJsonPath, backup)
  writeFileSync(packageJsonPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  console.log(`✓ 已更新 ${packageJsonPath}`)
  console.log(`  备份：${backup}`)
} else {
  console.log('（dry-run：以上改动都没有真的写下去）')
}

/**
 * 这个路径是不是链接/联接（而不是真实目录）。
 * @param {string} path - 待检查的路径。
 * @returns {boolean} 是链接则为真。
 */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// --- 3. 前置条件检查 ---------------------------------------------------------
// 本插件只是往"语音输入"的识别器列表里加东西；官方那个 bundle 没启用的话，
// 连麦克风按钮都没有，装了也看不见。这里只提示，不替用户改（改别人的 bundle
// 清单越权了，而且插件管理里点一下就开了）。
const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'
if (!profile.dsh.profile.bundles.includes(VOICE_BUNDLE)) {
  console.log(`\n⚠ profile 的 bundle 清单里没有 ${VOICE_BUNDLE}`)
  console.log('  没有它就没有麦克风按钮，本插件的识别器也无处可选。')
  console.log('  处理办法：打开 DSH 的「插件管理」，启用「语音输入」，然后重启。')
}

// --- 4. 密钥文件模板 ---------------------------------------------------------
const configPath = join(dshHome, 'voice-doubao.json')
if (existsSync(configPath)) {
  console.log(`· 密钥文件已存在，没有动它：${configPath}`)
} else if (!dryRun) {
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        _说明: '把「豆包语音」控制台签发的 API Key 填到 apiKey 里，然后重启 DeepSeek Harness。',
        _控制台: 'https://console.volcengine.com/speech/new/ → 右侧「API 调用」；要先开通「录音文件识别模型 2.0」并点【试用】领 20 小时免费额度。',
        _顺稿: 'arkApiKey 是「火山方舟」的 Key，可选；只在你想让大模型把口语顺成书面句子时才需要。',
        apiKey: '',
        arkApiKey: '',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`✓ 已生成密钥文件模板：${configPath}`)
} else {
  console.log(`· 将会生成密钥文件模板：${configPath}`)
}

console.log(`
下一步：
  1. 打开 ${configPath}，把 apiKey 填上（没开通的话看「使用说明.md」第二节）
  2. 重启 DeepSeek Harness（profile 只在启动时组合）
  3. 体检一下：

     node "${join(here, 'doctor.mjs')}"

     看到「15 项正常，全部就绪」就成了。
  4. 回到聊天界面，点输入框旁边的麦克风，识别器选「豆包听写（云端）」
     或者「豆包听写 + 顺稿（云端）」（配了 arkApiKey 才有这一条）
`)

// 提示一下包是否完整——半路解压失败是真实会发生的
if (!existsSync(join(here, 'lib', 'index.js'))) {
  console.error(`⚠ 警告：${join(here, 'lib', 'index.js')} 不存在，这个包好像不完整。`)
}
