/**
 * Configuration for the Doubao recognizer.
 *
 * Two layers, because the two audiences differ:
 *  - the plugin row in the profile's `cordis.patch.yml` carries deployment
 *    values (endpoints, model ids, whether 顺稿 is on);
 *  - `~/.dsh/voice-doubao.json` carries the secrets the user pastes once,
 *    and stays the one file they have to touch.
 *
 * Environment variables win last so a one-off run can be pointed somewhere
 * else without editing anything.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the user keeps keys, beside the rest of the Harness state. */
export const CONFIG_FILE_NAME = 'voice-doubao.json'

/** Where the plugin records that it mounted. */
export const STATUS_FILE_NAME = 'voice-doubao.status.json'

/** @returns {string} the Harness state directory this plugin reads and writes. */
function homeDirectory() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** @returns {string} absolute path of the user-editable key file. */
export function configFilePath() {
  return join(homeDirectory(), CONFIG_FILE_NAME)
}

/**
 * Record one mount event. The Harness logs are not always reachable while the
 * desktop app is running, so "did my plugin actually load" needs an answer the
 * user (or a shell) can read without opening the UI.
 * @param {Record<string, unknown>} payload - mount facts, already redacted.
 * @returns {string} the path written, or an empty string when writing failed.
 */
export function writeStatus(payload) {
  const path = join(homeDirectory(), STATUS_FILE_NAME)
  try {
    writeFileSync(path, `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    return path
  } catch {
    // Diagnostics must never prevent the recognizer from registering.
    return ''
  }
}

/** Deployment defaults; every one of them can be overridden. */
export const DEFAULTS = {
  /**
   * 走哪条通道：
   *   'auto'（默认）—— 按录音长度自动选，见 lib/engine.js 的实测表
   *   'submit'      —— 录音文件识别 2.0 标准版：提交 + 轮询，音频 base64 直传
   *   'stream'      —— 大模型流式语音识别：WebSocket 直推音频帧
   *
   * 实测（每档 3 轮）：短句流式快 300~600ms，43 秒长录音提交快 3.5 秒，交叉点约 15 秒。
   */
  transport: 'auto',
  /** 'auto' 模式下，录音不超过这个秒数就走流式通道。 */
  autoStreamMaxSeconds: 15,
  // --- 通道一：录音文件识别 2.0 标准版 ---
  submitEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit',
  queryEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query',
  submitResourceId: 'volc.seedasr.auc',
  /** 轮询间隔与上限：默认最多等 150ms × 100 ≈ 15 秒（第一次查询不等待）。 */
  pollIntervalMs: 150,
  maxPolls: 100,
  // --- 通道二：大模型流式语音识别（WebSocket） ---
  endpoint: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
  // 小时版按音频时长计费。2.0 与 1.0 的资源 id 不同，接口协议一样：
  //   豆包流式语音识别模型2.0 小时版 volc.seedasr.sauc.duration —— 后付费 1 元/小时
  //   豆包流式语音识别模型1.0 小时版 volc.bigasr.sauc.duration —— 后付费 4.5 元/小时
  // 默认选 2.0：同样的接口，单价是 1.0 的 1/4.5，而且有 20 小时/半年的试用额度。
  // 并发版把 duration 换成 concurrent（100 元/并发/月，个人用不到）。
  resourceId: 'volc.seedasr.sauc.duration',
  /**
   * 会话帧里声明的音频容器格式。必须是 `pcm`：音频帧推的是剥掉 WAV 头的裸 PCM16LE。
   * 声明成 `wav` 会让服务端按容器去解，直接报
   * "The audio could not be decoded using the declared format."
   */
  streamFormat: 'pcm',
  modelName: 'bigmodel',
  appId: '',
  accessToken: '',
  apiKey: '',
  /**
   * 识别侧的口语顺滑（enable_ddc）。官方文档：删除或修改 ASR 结果里的
   * 停顿词、语气词、语义重复词。它不额外收费、也不需要第二个 Key，
   * 所以默认打开；想要逐字原样就关掉。
   */
  semanticSmoothing: true,
  /** 每个音频包的时长，厂商建议 100~200 ms。 */
  chunkMs: 200,
  /** 等会话帧回执的上限；等不到也开始推音频。 */
  ackTimeoutMs: 1000,
  /** 收尾的安全阀：音频发完后服务一直不说话时的静默窗口。要比任何在途响应都长。 */
  settleMs: 1500,
  // --- 大模型顺稿（火山方舟；填了 arkApiKey 才生效） ---
  arkEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  arkApiKey: '',
  // 方舟的模型 ID 会随版本更新，照抄控制台里看到的那个最稳。
  // 想换成别的模型（例如旗舰别名 doubao-seed-evolving）就改这里——前提是那个模型
  // 已经在方舟控制台开通，否则会返回 404 ModelNotOpen。
  arkModel: 'doubao-seed-2-1-lite-260915',
  polish: true,
  // --- 运行时 ---
  timeoutMs: 60000,
  logTranscripts: false,
}

/** Row config keys that may carry secrets, used to keep them out of logs. */
const SECRET_KEYS = ['accessToken', 'apiKey', 'arkApiKey']

/**
 * Read the user key file; a malformed file is reported rather than ignored,
 * because silently falling back to "no key" would look like a wrong API key.
 * @param {string} path - configured path.
 * @param {(message: string, error?: unknown) => void} [warn] - diagnostics sink.
 * @returns {Record<string, unknown>} parsed object, empty when absent.
 */
function readUserFile(path, warn = () => {}) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn(`${path} 必须是一个 JSON 对象，已忽略`)
      return {}
    }
    return parsed
  } catch (error) {
    warn(`${path} 解析失败，已忽略：${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

/** Environment overrides, keyed by their exact variable names. */
const ENV_KEYS = {
  DOUBAO_SPEECH_APP_ID: 'appId',
  DOUBAO_SPEECH_ACCESS_TOKEN: 'accessToken',
  DOUBAO_SPEECH_API_KEY: 'apiKey',
  DOUBAO_SPEECH_ENDPOINT: 'endpoint',
  DOUBAO_SPEECH_RESOURCE_ID: 'resourceId',
  DOUBAO_ARK_API_KEY: 'arkApiKey',
  DOUBAO_ARK_ENDPOINT: 'arkEndpoint',
  DOUBAO_ARK_MODEL: 'arkModel',
}

/**
 * Drop empty and undefined values so a blank field never masks a configured one,
 * and drop `_`-prefixed keys: those are the human-readable notes in the shipped
 * JSON template, and they must never reach the effective config or the status file.
 * @param {Record<string, unknown>} source - candidate layer.
 * @returns {Record<string, unknown>} the layer without empty or annotation entries.
 */
function withoutBlanks(source) {
  const out = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key.startsWith('_')) continue
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/** @returns {Record<string, unknown>} environment layer. */
function environmentLayer() {
  const out = {}
  for (const [variable, key] of Object.entries(ENV_KEYS)) {
    const value = process.env[variable]
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

/**
 * Merge every layer into the effective configuration.
 * @param {Record<string, unknown>} [rowConfig] - the plugin row's config block.
 * @param {(message: string, error?: unknown) => void} [warn] - diagnostics sink.
 * @returns {typeof DEFAULTS & Record<string, unknown>} effective configuration.
 */
export function loadConfig(rowConfig = {}, warn = () => {}) {
  const merged = {
    ...DEFAULTS,
    ...withoutBlanks(readUserFile(configFilePath(), warn)),
    ...withoutBlanks(rowConfig),
    ...environmentLayer(),
  }
  merged.polish = toBoolean(merged.polish)
  merged.semanticSmoothing = toBoolean(merged.semanticSmoothing)
  merged.logTranscripts = toBoolean(merged.logTranscripts)
  for (const key of ['timeoutMs', 'chunkMs', 'ackTimeoutMs', 'settleMs', 'pollIntervalMs', 'maxPolls']) {
    const value = Number(merged[key])
    merged[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  if (!['auto', 'submit', 'stream'].includes(String(merged.transport))) {
    warn(`transport 只能是 auto / submit / stream，收到 ${merged.transport}，已回落到 auto`)
    merged.transport = DEFAULTS.transport
  }
  const autoMax = Number(merged.autoStreamMaxSeconds)
  merged.autoStreamMaxSeconds = Number.isFinite(autoMax) && autoMax > 0 ? autoMax : DEFAULTS.autoStreamMaxSeconds
  return merged
}

/** Lenient boolean coercion for values that survived YAML/JSON/env layers. */
function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !['0', 'false', 'no', 'off', ''].includes(value.trim().toLowerCase())
  return Boolean(value)
}

/**
 * Decide which credential style the user configured.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {'apiKey' | 'appToken' | 'none'} detected style.
 */
export function credentialStyle(config) {
  if (config.apiKey) return 'apiKey'
  if (config.appId && config.accessToken) return 'appToken'
  return 'none'
}

/**
 * Fail before any network call when the user has not supplied a credential,
 * with a message that names the exact file to edit.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {void}
 */
export function assertCredentials(config) {
  if (credentialStyle(config) !== 'none') return
  throw new Error(
    `豆包语音识别还没配密钥：请把「豆包语音」控制台签发的 API Key 填到 ${configFilePath()}，` +
      '例如 {"apiKey": "你的Key"}；也可以用环境变量 DOUBAO_SPEECH_API_KEY。' +
      '注意：火山方舟（Ark）的 Key 不能用于语音识别，两个 Key 要分别申请。',
  )
}

/**
 * Whether the 顺稿 step can run: it is on, and an Ark key exists.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {boolean} true when polishing is usable.
 */
export function polishAvailable(config) {
  return toBoolean(config.polish) && Boolean(config.arkApiKey)
}

/**
 * A log-safe view of the configuration.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {Record<string, unknown>} configuration with secrets redacted.
 */
export function redacted(config) {
  const out = { ...config }
  for (const key of SECRET_KEYS) {
    out[key] = config[key] ? `已设置(${String(config[key]).length} 位)` : '未设置'
  }
  return out
}
