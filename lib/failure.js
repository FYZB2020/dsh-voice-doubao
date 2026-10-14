/**
 * 把豆包语音的失败原因翻译成"用户该做什么"。
 *
 * 两条通道（提交通道和流式通道）的错误码是同一套家族，措辞必须一致：
 * 同一个 20000003 在两条路上不该给出两种解释。更重要的是一件事——
 * 这些码里只有一部分和"账号/资源"有关，其余是"录音本身有问题"。
 * 把静音说成"去检查资源开通"会把用户引到完全错误的方向，这是实测踩到的。
 */

/** 明确表示"录音里没有人声"的状态码。 */
const SILENCE_CODES = new Set(['20000003', '20000015', '45000002'])

/** 明确表示"请求参数不对"的状态码。 */
const PARAMETER_CODES = new Set(['45000001', '45000051'])

/**
 * @param {object} input - 失败事实。
 * @param {string} [input.code] - 服务端状态码。
 * @param {string} [input.message] - 服务端原话。
 * @param {string} input.resourceId - 本次用的资源 id。
 * @param {string} [input.kind] - "语音识别" 之类，写进通用兜底里。
 * @returns {string} 给用户看的处置建议。
 */
export function speechFailureReason({ code, message, resourceId, kind = '语音识别' }) {
  const text = String(message ?? '')
  const status = String(code ?? '')

  if (/not granted/i.test(text)) {
    return `这个 Key 是有效的，但没有被授权使用 ${resourceId}。去「豆包语音」控制台的「语音识别」里点【试用】或【开通】对应模型；如果已经开通，确认 Key 和模型在同一个项目下。`
  }
  if (/invalid x-api-key/i.test(text)) {
    return 'API Key 无效。确认它来自「豆包语音」控制台（/speech/new/）——火山方舟的 Key 不能用于语音识别。'
  }
  if (/concurrency/i.test(text)) {
    return '这是"并发额度为 0"：开通的是并发版，而并发要按路数单独买（默认 0 路）。个人用请改开通小时版/按量后付费——流式这边对应的资源 id 是 volc.seedasr.sauc.duration。'
  }
  // 录音本身的问题——这类最容易被误报成"账号没开通"，所以放在前面单独说清。
  if (SILENCE_CODES.has(status) || /no valid speech|silence audio|empty audio/i.test(text)) {
    return '录音里没有检测到人声。检查麦克风有没有真的采到声音，或者你刚才确实没说话——这不是账号或密钥的问题。'
  }
  if (PARAMETER_CODES.has(status)) {
    return '请求参数无效。这多半是插件这边的问题，不是你的操作；可以打开 logTranscripts 看会话参数。'
  }
  if (status === '45000151') {
    return '音频格式不正确：录音文件损坏，或不是 16 kHz 单声道 PCM16。'
  }
  if (/timeout|timed out/i.test(text)) {
    return '服务端处理超时。可以稍后重试，或把 timeoutMs 调大。'
  }
  return `请检查 ${kind} 是否已开通，以及资源 id 是否与你开通的模型一致。`
}
