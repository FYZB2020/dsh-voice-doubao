/**
 * 录音文件识别（大模型 2.0 标准版）：提交 + 轮询，音频用 base64 直传。
 *
 * 为什么加这条通道（全部来自本机实测，不是从文档推的）：
 *
 *  1. 文档里 audio 只写了 url，官方三个示例也都传 url，看着像"必须先托管到公网"。
 *     但那条结论是在账号没有任何资源授权、所有请求都停在 403 的时候下的——问不到正文。
 *  2. 资源授权后直接试：把 9 秒 WAV 的 base64 塞进 audio.data，服务端返回
 *     X-Api-Status-Code=20000000，轮询拿到了完整转写。**base64 是收的。**
 *  3. 于是这条路既不需要公网托管，也不需要 WebSocket，纯 HTTP 两端点。
 *
 * 代价是比流式多一次轮询往返；好处是不挑资源（`volc.seedasr.auc` 就够），
 * 而且 0.8 元/小时比流式的 1 元/小时便宜。
 */

import { randomUUID } from 'node:crypto'

import { speechFailureReason } from './failure.js'

/** 服务端的任务状态码。 */
export const AUC_CODE = {
  SUCCESS: '20000000',
  PROCESSING: '20000001',
  QUEUED: '20000002',
}

/**
 * 组合取消信号与超时。
 * @param {AbortSignal | undefined} signal - 调用方取消。
 * @param {number} timeoutMs - 单次请求上限。
 * @returns {AbortSignal} 组合信号。
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * 构造两个端点共用的请求头。查询必须复用提交时的 X-Api-Request-Id——
 * 它就是任务 id，换一个就查不到自己的任务。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {string} requestId - 任务 id。
 * @returns {Record<string, string>} 请求头。
 */
export function buildAucHeaders(config, requestId) {
  const headers = {
    'content-type': 'application/json',
    'X-Api-Resource-Id': String(config.submitResourceId),
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
  }
  if (config.appId) headers['X-Api-App-Key'] = String(config.appId)
  if (config.accessToken) headers['X-Api-Access-Key'] = String(config.accessToken)
  if (config.apiKey) headers['X-Api-Key'] = String(config.apiKey)
  return headers
}

/**
 * 构造提交请求体，并把诊断需要的规模信息一并返回。
 * @param {Buffer} audio - 规范 WAV。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {string} [language] - 语言提示。
 * @returns {{ body: string, audioChars: number }} 请求体与 base64 长度。
 */
export function buildSubmitBody(audio, config, language) {
  const request = { model_name: String(config.modelName), enable_itn: true, enable_punc: true }
  if (config.semanticSmoothing) request.enable_ddc = true
  const tags = { zh: 'zh-CN', en: 'en-US', yue: 'yue-CN', ja: 'ja-JP', ko: 'ko-KR' }
  const audioPart = { format: 'wav', data: audio.toString('base64') }
  if (language && tags[language]) audioPart.language = tags[language]
  return {
    body: JSON.stringify({ user: { uid: 'dsh-voice-doubao' }, audio: audioPart, request }),
    audioChars: audioPart.data.length,
  }
}

/**
 * 把一次失败翻译成"该改什么"。
 *
 * 这套接口把状态放在响应头 X-Api-Status-Code / X-Api-Message 里，
 * body 里还有一份 header.{code,message}。三种原因必须分开说：
 * 没授权、Key 无效、以及真·参数错误。
 *
 * @param {Response} response - HTTP 响应。
 * @param {unknown} body - 已解析的响应体。
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {string} what - "提交" 或 "查询"。
 * @returns {Error} 带原因与做法的错误。
 */
export function aucFailure(response, body, config, what) {
  const payload = /** @type {any} */ (body)
  const code = response.headers.get('X-Api-Status-Code') ?? payload?.header?.code ?? ''
  const message = response.headers.get('X-Api-Message') ?? payload?.header?.message ?? payload?.error ?? ''
  const text = String(message)
  const where = `${what}失败：HTTP ${response.status}${code ? `　X-Api-Status-Code=${code}` : ''}${text ? `　服务端原话：${text}` : ''}`
  const reason = speechFailureReason({
    code: String(code),
    message: text,
    resourceId: String(config.submitResourceId),
    kind: '录音文件识别模型 2.0',
  })
  return new Error(`豆包${where}　${reason}`)
}

/**
 * 读一次响应体，容忍网关返回的非 JSON 页面。
 * @param {Response} response - HTTP 响应。
 * @returns {Promise<unknown>} 解析后的响应体或原文。
 */
async function readBody(response) {
  const text = await response.text()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 400) }
  }
}

/**
 * 用提交 + 轮询的方式转写一段录音。
 *
 * @param {object} input - 调用输入。
 * @param {Buffer} input.audio - 规范 WAV。
 * @param {string} [input.language] - 语言提示。
 * @param {Record<string, unknown>} input.config - 生效配置。
 * @param {AbortSignal} [input.signal] - 调用方取消。
 * @param {(message: string, error?: unknown) => void} [input.warn] - 诊断输出。
 * @returns {Promise<string>} 识别文字。
 */
export async function transcribeSubmit({ audio, language, config, signal, warn = () => {} }) {
  const requestId = randomUUID()
  const headers = buildAucHeaders(config, requestId)
  const { body } = buildSubmitBody(audio, config, language)

  const submit = await fetch(String(config.submitEndpoint), {
    method: 'POST',
    headers,
    body,
    signal: withTimeout(signal, Number(config.timeoutMs)),
  })
  const submitBody = await readBody(submit)
  const submitCode = submit.headers.get('X-Api-Status-Code')
  if (submit.status !== 200 || (submitCode !== null && submitCode !== AUC_CODE.SUCCESS)) {
    throw aucFailure(submit, submitBody, config, '提交')
  }
  if (config.logTranscripts) warn(`豆包提交成功，任务 ${requestId}，开始轮询`)

  let lastCode = ''
  for (let attempt = 0; attempt < Number(config.maxPolls); attempt++) {
    signal?.throwIfAborted()
    // 第一枪立刻打：短录音往往提交完就已经好了，白等一个间隔纯属浪费。
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Number(config.pollIntervalMs)))
    signal?.throwIfAborted()

    const query = await fetch(String(config.queryEndpoint), {
      method: 'POST',
      headers,
      body: '{}',
      signal: withTimeout(signal, Number(config.timeoutMs)),
    })
    const queryBody = await readBody(query)
    const code = query.headers.get('X-Api-Status-Code') ?? ''
    lastCode = code

    if (query.status === 200 && code === AUC_CODE.SUCCESS) {
      const text = /** @type {any} */ (queryBody)?.result?.text
      if (typeof text === 'string') return text
      throw new Error(`豆包查询成功但没有 result.text：${JSON.stringify(queryBody).slice(0, 300)}`)
    }
    // 排队中与处理中都不是错误，继续等。
    if (query.status === 200 && (code === AUC_CODE.PROCESSING || code === AUC_CODE.QUEUED)) continue
    throw aucFailure(query, queryBody, config, '查询')
  }
  throw new Error(
    `豆包识别在 ${Number(config.maxPolls)} 次轮询内没有返回结果（最后一次状态 ${lastCode || '未知'}）。` +
      '可以把 pollIntervalMs 或 maxPolls 调大。',
  )
}
