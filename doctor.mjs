/**
 * dsh-voice-doubao 体检。
 *
 * 一条命令回答"现在到底能不能用、缺什么、下一步做什么"，不用去翻日志或猜。
 * 只读，不联网，不改任何东西。
 *
 *   node doctor.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE || 'desktop'
// 和 install.mjs 同一套逻辑：显式给了 DSH_HOME 就从它推导，
// 不理会继承来的 DSH_PROFILE_DIR（否则"体检临时目录"会去体检真实 profile）。
const profileDir = process.env.DSH_HOME
  ? join(home, 'profiles', profile)
  : process.env.DSH_PROFILE_DIR || join(home, 'profiles', profile)
const configPath = join(home, 'voice-doubao.json')
const statusPath = join(home, 'voice-doubao.status.json')

const lines = []
const todo = []
let ok = 0
let bad = 0
/** Report one required fact; a failure is printed with what to do about it. */
function check(label, good, detail, fix) {
  if (good) {
    ok++
    console.log(`  ✓ ${label}${detail ? `　${detail}` : ''}`)
  } else {
    bad++
    console.log(`  ✗ ${label}${detail ? `　${detail}` : ''}`)
    if (fix) todo.push(fix)
  }
}
/** Report a fact that is worth knowing but is not required. */
function info(label, detail) {
  console.log(`  · ${label}${detail ? `　${detail}` : ''}`)
}

/**
 * 磁盘上的插件代码是不是比"正在运行的那一份"新。
 *
 * 插件只在启动时加载，所以改完代码不重启还是旧行为。判断方法很直接：
 * 拿 `lib/index.js` 的修改时间和状态文件（插件上次加载时写的）比。
 *
 * @param {{mtime: Date}} statusStat - 状态文件的 stat。
 * @returns {boolean} 代码更新则为真。
 */
function codeIsNewerThan(statusStat) {
  try {
    const entry = join(here, 'lib', 'index.js')
    if (!existsSync(entry)) return false
    return statSync(entry).mtime > statusStat.mtime
  } catch {
    return false
  }
}

/**
 * 读 profile 补丁层里 `speech-to-text` 那一行配置的 defaultProvider。
 * 这是"默认值"；用户在界面里切换后，实时的选择写在状态文件里。
 * @returns {string} 配置的默认识别器 id，读不到则为空串。
 */
function readConfiguredProvider() {
  const patch = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patch)) return ''
  try {
    const text = readFileSync(patch, 'utf8')
    // 只做很轻的解析：找到 speech-to-text 那一行之后的第一个 defaultProvider。
    const at = text.indexOf('- id: speech-to-text')
    if (at < 0) return ''
    const window = text.slice(at, at + 400)
    const match = window.match(/defaultProvider:\s*([^\s#]+)/)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

console.log('dsh-voice-doubao 体检\n')

// --- 1. 密钥 ----------------------------------------------------------------
console.log('[1/4] 密钥')
let config = null
if (!existsSync(configPath)) {
  check('密钥文件存在', false, configPath, `新建 ${configPath}，内容写成 {"apiKey": "你的Key"}`)
} else {
  check('密钥文件存在', true, configPath)
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
    check('JSON 格式合法', true)
  } catch (error) {
    check('JSON 格式合法', false, error.message, `修好 ${configPath} 的 JSON（注意别漏逗号或引号）`)
  }
}
if (config) {
  const style = config.apiKey ? 'apiKey（新版控制台）' : config.appId && config.accessToken ? 'App ID + Access Token（旧版控制台）' : null
  check(
    '识别用凭据已填',
    style !== null,
    style ?? 'apiKey / appId / accessToken 都是空的',
    `把「豆包语音」控制台的 API Key 填进 ${configPath} 的 apiKey（注意不是火山方舟的 Key）`,
  )
  // 顺稿是可选的，不算失败
  info(
    '顺稿用凭据（可选）',
    config.arkApiKey ? '已填，可以用「+ 顺稿」那两条识别器' : '没填——不影响使用，只是少了最后那道润色',
  )
}

// --- 2. 插件自带依赖 --------------------------------------------------------
console.log('\n[2/4] 插件文件')
check('插件代码在位', existsSync(join(here, 'lib', 'index.js')))
check(
  '自带依赖 ws 在位',
  existsSync(join(here, 'node_modules', 'ws', 'package.json')),
  undefined,
  `在 ${here} 下执行 pnpm add ws 重新装依赖`,
)
check(
  'bundle 清单声明了 patch',
  (() => {
    try {
      return typeof JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).dsh?.bundle?.patch === 'string'
    } catch {
      return false
    }
  })(),
)
check('cordis.patch.yml 在位', existsSync(join(here, 'cordis.patch.yml')))

// --- 3. profile 安装 --------------------------------------------------------
console.log(`\n[3/4] profile 安装（${profile}）`)
const linkPath = join(profileDir, 'node_modules', 'dsh-voice-doubao')
check('profile 里有链接', existsSync(join(linkPath, 'lib', 'index.js')), linkPath, '运行 pnpm install 或重新建立链接')
let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
} catch {
  // 读不到就让下面的检查报出来
}
const bundles = manifest?.dsh?.profile?.bundles ?? []
check(
  'package.json 里声明了依赖',
  Boolean(manifest?.dependencies?.['dsh-voice-doubao']),
  undefined,
  `把 "dsh-voice-doubao": "link:${here}" 加回 profile 的 dependencies`,
)
check(
  'bundle 列表里包含本插件',
  bundles.includes('dsh-voice-doubao'),
  undefined,
  '把 dsh-voice-doubao 加回 profile 的 dsh.profile.bundles',
)
// 麦克风按钮不是本插件画的，是官方语音输入 bundle 提供的；它没启用的话，
// 识别器注册得再好用户也点不到麦克风。
check(
  '语音输入界面（官方 bundle）已启用',
  bundles.includes('@deepseek-ai/dsh-experimental-voice-input-bundle'),
  '麦克风按钮由它提供',
  '把 @deepseek-ai/dsh-experimental-voice-input-bundle 加回 profile 的 dsh.profile.bundles',
)
info(
  '本地 SenseVoice 模型（不选豆包时用的就是它）',
  existsSync(join(home, 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx', 'model.int8.onnx')) ? '已下载' : '未下载',
)

// --- 4. 是否已经加载 --------------------------------------------------------
console.log('\n[4/4] 是否已加载')
if (!existsSync(statusPath)) {
  check(
    '插件已加载',
    false,
    `没有 ${statusPath}`,
    '重启一次 DeepSeek Harness（profile 只在启动时组合，改完必须重启）',
  )
} else {
  // 变量名不能叫 info —— 会遮蔽上面的 info() 辅助函数
  const statusStat = statSync(statusPath)
  let status = null
  try {
    status = JSON.parse(readFileSync(statusPath, 'utf8'))
  } catch {
    // 下面按"内容不可读"处理
  }
  check('插件已加载', true, `${statusPath}（${statusStat.mtime.toLocaleString()}）`)
  if (status) {
    check('注册出的识别器', Array.isArray(status.providers) && status.providers.length > 0, (status.providers ?? []).join(', '))
    // 这一项回答"现在点麦克风到底走谁"。没切到豆包的话，识别质量不会变。
    // 状态文件现在由插件订阅服务变化实时改写，所以它是"界面里实际选的"。
    const selected = status.selection?.providerId
    if (selected === undefined || selected === null) {
      info('当前选中的识别器', '这次加载没记下来（旧状态文件）——重启一次就会写进去')
    } else {
      check(
        '当前选中的识别器就是豆包',
        String(selected).startsWith('doubao'),
        `现在选的是 ${selected}`,
        '在「插件管理 → 语音输入 → 配置」里把识别器切成「豆包听写（云端）」，然后重启',
      )
    }
    // 对照一下 profile 里配置的"默认值"：两者不一致通常说明你在界面里手动切换过，
    // 以状态文件（实时）为准。这一行是给排查用的。
    const configured = readConfiguredProvider()
    if (configured) {
      // 只说事实，不替用户断言"你切过"——状态文件可能是上一次启动留下的快照。
      const mismatch = selected && selected !== configured
      info('profile 里配置的默认识别器', `${configured}${mismatch ? `（状态文件里记的是 ${selected}）` : ''}`)
    }
    check(
      '插件读到的凭据',
      status.credentials !== 'none',
      `credentials = ${status.credentials}`,
      '重启时还没读到密钥；确认 apiKey 填好后再重启一次',
    )
    // "刚才那句话到底有没有走豆包"——看这里，不用凭感觉猜。
    // 但要先判断：磁盘上的代码是不是比正在跑的那份新。插件是启动时加载的，
    // 改了代码不重启就还是旧行为——这时候催用户"说一句试试"是白费功夫。
    const stale = codeIsNewerThan(statusStat)
    if (status.lastRun?.at) {
      const run = status.lastRun
      info(
        '最近一次识别',
        `${new Date(run.at).toLocaleString()}　${run.providerId || '未知'} 处理，${run.audioSeconds}s 音频 → ${run.chars} 字，` +
          `${run.inferenceSeconds}s${run.polished ? '，顺稿已生效' : ''}${run.text ? `　「${run.text}」` : ''}`,
      )
    } else if (stale) {
      info(
        '最近一次识别',
        '还没有记录。插件的代码在上次启动之后又改过，这个功能要**重启一次**才会开始记录',
      )
      check('磁盘上的代码与正在运行的一致', false, '代码比运行中的那份新', '重启一次 DeepSeek Harness，新功能才会生效')
    } else {
      info('最近一次识别', '还没有记录——对着麦克风说一句，然后重新跑一次这个体检')
    }
  }
}

// --- 结论 -------------------------------------------------------------------
console.log(`\n${ok} 项正常${bad > 0 ? `，${bad} 项待处理` : '，全部就绪'}`)

if (todo.length === 0) {
  console.log('\n全都就绪。跑一次真实识别验证：')
  console.log('  node test/live.mjs')
  console.log('或者直接回 DSH 界面，点输入框旁边的麦克风试试。')
} else {
  console.log('\n下一步：')
  todo.forEach((item, index) => console.log(`  ${index + 1}. ${item}`))
}

process.exitCode = bad === 0 ? 0 : 1
