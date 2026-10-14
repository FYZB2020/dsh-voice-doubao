/**
 * dsh-voice-doubao — Host side.
 *
 * The shipped voice-input bundle gives the microphone button and one local
 * recognizer (SenseVoice). The speech-to-text service is a registry, so a
 * cloud recognizer is a second `register()` call — no UI code, no fork of the
 * shipped plugin. This plugin contributes exactly that, twice:
 *
 *   doubao            豆包听写，原样返回识别文字
 *   doubao-polished   同一路识别，再让大模型把口语顺成用户本来想打的句子
 *
 * Both are `location: "cloud"`, which tells the microphone UI that there is
 * nothing to download and no preparation step to run.
 */

import { assertCredentials, configFilePath, credentialStyle, loadConfig, polishAvailable, redacted, writeStatus } from './config.js'
import { polishTranscript } from './ark.js'
import { transcribeRecording } from './engine.js'
import { acceptPolished, shouldPolish } from './polish.js'

export const name = 'dsh-voice-doubao'

/** The recognizer registry this plugin contributes to. */
export const inject = ['speechToText']

/**
 * Language hints the service validates a selection against. The recording UI
 * only offers what a provider publishes, so the list has to be truthful about
 * what the model accepts; `auto` covers everything else.
 */
const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** Provider ids, kept in one place because the user selects them by id. */
const RAW_PROVIDER_ID = 'doubao'
const POLISHED_PROVIDER_ID = 'doubao-polished'

/**
 * Mount the recognizers on the speech-to-text service.
 * @param {any} ctx - Host context owning the registry.
 * @param {Record<string, unknown>} [rowConfig] - the plugin row's config block.
 * @returns {void}
 */
export function apply(ctx, rowConfig = {}) {
  /** Diagnostics go to the Harness log; a missing logger must not break speech. */
  const warn = (message, error) => {
    try {
      if (error !== undefined) ctx.logger?.warn?.(message, error)
      else ctx.logger?.warn?.(message)
    } catch {
      // Logging is best-effort: never let it fail a transcription.
    }
  }

  const config = loadConfig(rowConfig, warn)
  warn(`dsh-voice-doubao 已加载：${JSON.stringify(redacted(config))}`)
  if (!polishAvailable(config)) {
    warn('dsh-voice-doubao：未配置 ARK 密钥，"豆包听写 + 顺稿" 会退化为原样识别')
  }
  // 没配方舟 Key 时不注册"顺稿"那条：它会静默退化成纯识别，摆在下拉里只会让人
  // 以为"切了也没变智能"——选项不该承诺它做不到的事。
  const polishReady = polishAvailable(config)
  const registered = polishReady ? [RAW_PROVIDER_ID, POLISHED_PROVIDER_ID] : [RAW_PROVIDER_ID]

  // 状态文件记录"服务当前选中的是哪个识别器"，直接回答"接上了吗、现在用的是谁"。
  const statusBase = {
    loaded: true,
    plugin: name,
    providers: registered,
    credentials: credentialStyle(config),
    polish: polishReady,
    configPath: configFilePath(),
    config: redacted(config),
  }
  const readSelection = () => {
    try {
      return ctx.speechToText.snapshot?.()?.selection ?? null
    } catch {
      return null
    }
  }
  let latestSelection = readSelection()
  /** 每次调用都带上最新的选择，避免写出过期的快照。 */
  const writeStatusNow = (extra = {}) => writeStatus({ ...statusBase, selection: latestSelection, ...extra })
  writeStatusNow()

  // 只在启动时记一次是不够的：用户在界面里切换识别器之后，那个快照就过期了，
  // 于是"我看到的是 sensevoice-local、实际已经在用豆包"这种误判就出现了。
  // 服务提供 follow()：一个每次变化都吐出完整快照的异步生成器，用它把状态文件变成实时的。
  if (typeof ctx.speechToText.follow === 'function') {
    const watcher = new AbortController()
    ctx.effect(() => () => watcher.abort())
    void (async () => {
      try {
        for await (const snapshot of ctx.speechToText.follow(watcher.signal)) {
          latestSelection = snapshot?.selection ?? null
          writeStatusNow()
        }
      } catch {
        // 服务销毁或观察者被取消，正常收场
      }
    })()
  }

  /**
   * Run one recording: recognize, then optionally rewrite, then report the
   * measured duration the meter and the transcript both use.
   * @param {{ audio: Buffer, language?: string }} input - resolved recording.
   * @param {AbortSignal} signal - caller cancellation.
   * @param {boolean} polish - whether this provider runs the rewriting pass.
   * @param {string} [model] - Ark model for the rewriting pass; omitted uses the configured default.
   * @param {string} [providerId] - which recognizer the user selected; recorded for diagnostics.
   * @returns {Promise<{ text: string, audioSeconds: number, inferenceSeconds: number }>} transcript.
   */
  const transcribe = async ({ audio, language }, signal, polish, model, providerId) => {
    assertCredentials(config)
    const startedAt = Date.now()
    const { text: recognized, audioSeconds } = await transcribeRecording({ audio, language, config, signal, warn })
    let text = recognized
    let polished = false

    if (polish && polishAvailable(config) && shouldPolish(text)) {
      try {
        const candidate = await polishTranscript({
          text,
          config: model === undefined ? config : { ...config, arkModel: model },
          signal,
        })
        if (acceptPolished(text, candidate)) {
          text = candidate
          polished = true
        } else {
          warn('dsh-voice-doubao：顺稿结果长度异常，已保留原始识别文字')
        }
      } catch (error) {
        // Recognition already succeeded; a rewriting failure must not lose it.
        warn(`dsh-voice-doubao：顺稿失败，已回退到原始识别文字（${error instanceof Error ? error.message : String(error)}）`)
      }
    }

    const inferenceSeconds = (Date.now() - startedAt) / 1000
    if (config.logTranscripts) warn(`dsh-voice-doubao 识别结果（${text.length} 字）：${text}`)
    // 把"刚才是谁处理的"写进状态文件：这样"到底有没有走豆包""顺稿有没有生效"
    // 不再是凭感觉猜——外部读一下文件就知道。默认只记事实，不记内容；
    // 想看原文就把 logTranscripts 打开。
    writeStatusNow({
      lastRun: {
        at: new Date().toISOString(),
        providerId: String(providerId ?? ''),
        transport: String(config.transport),
        polished,
        audioSeconds: Number(audioSeconds.toFixed(2)),
        chars: text.length,
        inferenceSeconds: Number(inferenceSeconds.toFixed(2)),
        ...(config.logTranscripts ? { text } : {}),
      },
    })
    return { text, audioSeconds, inferenceSeconds }
  }

  /**
   * One registration record, shared by every provider this plugin contributes.
   * @param {string} id - stable provider id the user selects.
   * @param {string} label - display name in the microphone selector.
   * @param {boolean} polish - whether this provider rewrites its transcript.
   * @param {string} [model] - Ark model for the rewriting pass.
   * @returns {object} provider registration.
   */
  const provider = (id, label, polish, model) => ({
    info: {
      id,
      name: label,
      location: 'cloud',
      languages: LANGUAGES,
      // A cloud recognizer has nothing to prepare, which is what an empty list means.
      downloadSources: [],
    },
    transcribe: async (input, signal) => await transcribe(input, signal, polish, model, id),
  })

  ctx.effect(() => {
    // 只注册两条。之前还有第三条"旗舰模型"（doubao-seed-evolving），撤掉了：
    // 实测那个模型没在账号里开通时会返回 404 ModelNotOpen，插件只能静默回退成原文——
    // 又是一条"看着有、其实不干活"的选项。顺稿用哪个模型交给 arkModel 一个开关。
    const disposers = [ctx.speechToText.register(provider(RAW_PROVIDER_ID, '豆包听写（云端）', false))]
    if (polishReady) {
      disposers.push(ctx.speechToText.register(provider(POLISHED_PROVIDER_ID, '豆包听写 + 顺稿（云端）', true)))
    }
    return async () => {
      for (const dispose of disposers) await dispose()
    }
  })
}

export { RAW_PROVIDER_ID, POLISHED_PROVIDER_ID }
