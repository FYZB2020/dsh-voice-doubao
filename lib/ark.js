/**
 * The 顺稿 step: one chat completion that turns a raw transcript into the
 * sentence the speaker meant to type.
 *
 * Kept separate from the recognizer because the two have nothing in common
 * beyond being HTTP: different product, different endpoint, different
 * credential, and a failure here must never lose a transcript that already
 * succeeded.
 */

import { POLISH_SYSTEM_PROMPT, cleanReply } from './polish.js'

const HTTP_OK = 200

/**
 * Compose the caller's cancellation with a wall-clock deadline.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {number} timeoutMs - maximum duration of the request.
 * @returns {AbortSignal} combined signal.
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Turn a failed response into a readable error, preferring the API's own words.
 * @param {Response} response - HTTP response.
 * @param {unknown} body - parsed body, when it parsed.
 * @returns {Error} error carrying status and provider message.
 */
export function failureFrom(response, body) {
  const payload = /** @type {any} */ (body)
  const apiMessage = payload?.error?.message ?? payload?.message ?? payload?.Message ?? ''
  const apiCode = payload?.error?.code ?? payload?.code ?? ''
  const detail = [apiCode && `code=${apiCode}`, apiMessage && `message=${apiMessage}`].filter(Boolean).join(' ')
  return new Error(`顺稿失败：HTTP ${response.status}${detail ? ` (${detail})` : ''}`)
}

/**
 * Read one response body, tolerating the non-JSON error pages gateways return.
 * @param {Response} response - HTTP response.
 * @returns {Promise<unknown>} parsed body or raw text.
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
 * Build the Ark chat request that tidies a transcript.
 *
 * `thinking: disabled` keeps a copy-editing job from spending its budget on
 * reasoning tokens: the task is mechanical, and the answer is due immediately.
 *
 * @param {string} text - raw transcript.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {{ url: string, headers: Record<string, string>, body: string }} the request.
 */
export function buildPolishRequest(text, config) {
  return {
    url: String(config.arkEndpoint),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.arkApiKey}`,
    },
    body: JSON.stringify({
      model: String(config.arkModel),
      temperature: 0.1,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: POLISH_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  }
}

/**
 * Rewrite one transcript into the sentence the user meant to type.
 * @param {object} input - call inputs.
 * @param {string} input.text - raw transcript.
 * @param {Record<string, unknown>} input.config - effective configuration.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {Promise<string>} polished text.
 */
export async function polishTranscript({ text, config, signal }) {
  const request = buildPolishRequest(text, config)
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: withTimeout(signal, Number(config.timeoutMs)),
  })
  const body = await readBody(response)
  if (response.status !== HTTP_OK) throw failureFrom(response, body)
  const payload = /** @type {any} */ (body)
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error(`顺稿失败：模型返回了无法解析的结果 ${JSON.stringify(body).slice(0, 300)}`)
  }
  return cleanReply(content)
}
