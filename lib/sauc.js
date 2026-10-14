/**
 * Doubao streaming ASR (大模型流式语音识别) over WebSocket.
 *
 * Why streaming rather than 录音文件识别·极速版: the flash HTTP API documents
 * exactly one way to hand over audio — `audio.url`, a link the ASR service
 * downloads itself. A microphone inside DSH has raw bytes and nothing to host
 * them on, so the flash route would need an object-storage bucket and three
 * more credentials before a single word could be transcribed. The streaming
 * API takes the bytes directly over the socket, which is what this feature
 * actually has.
 *
 * Mode: `bigmodel_nostream` (流式输入模式). It returns the whole transcript
 * once the final (negative) packet arrives rather than emitting partials, and
 * the vendor documents it as the more accurate of the two. Our caller hands
 * over a finished recording, so partials would have nowhere to go anyway.
 *
 * Wire format (from the vendor protocol page): every frame is a 4-byte header
 * followed by an optional 4-byte sequence, a 4-byte big-endian payload size,
 * then the payload.
 *
 *   byte 0: protocol version (4 bits) | header size in 4-byte words (4 bits)
 *   byte 1: message type  (4 bits) | message-type flags (4 bits)
 *   byte 2: serialization (4 bits) | compression (4 bits)
 *   byte 3: reserved
 */

import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import WebSocket from 'ws'

import { speechFailureReason } from './failure.js'

const PROTOCOL_VERSION = 0b0001
const HEADER_WORDS = 0b0001

/** Message types carried in header byte 1, high nibble. */
export const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0b0001,
  AUDIO_ONLY_REQUEST: 0b0010,
  FULL_SERVER_RESPONSE: 0b1001,
  SERVER_ACK: 0b1011,
  SERVER_ERROR: 0b1111,
}

/** Header byte 1, low nibble. */
export const FLAG = {
  NONE: 0b0000,
  POSITIVE_SEQUENCE: 0b0001,
  LAST_WITHOUT_SEQUENCE: 0b0010,
  LAST_WITH_SEQUENCE: 0b0011,
}

const SERIALIZATION = { NONE: 0b0000, JSON: 0b0001 }
const COMPRESSION = { NONE: 0b0000, GZIP: 0b0001 }

/** Language hints the streaming service spells differently from our provider list. */
const LANGUAGE_TAGS = {
  zh: 'zh-CN',
  en: 'en-US',
  yue: 'yue-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
}

/** 100 ms of 16 kHz mono PCM16 — the vendor's advised packet size is 100–200 ms. */
const BYTES_PER_MS = 32

/** Above this much unsent data, pause between packets so a long take stays bounded. */
const BACKPRESSURE_BYTES = 1 << 20

/** Yield to the event loop this often, so early server responses are handled while uploading. */
const YIELD_EVERY_FRAMES = 20

/**
 * Build one 4-byte protocol header.
 * @param {object} parts - header fields.
 * @returns {Buffer} 4 bytes.
 */
export function buildHeader({ messageType, flags = FLAG.NONE, serialization = SERIALIZATION.NONE, compression = COMPRESSION.NONE }) {
  const header = Buffer.alloc(4)
  header[0] = (PROTOCOL_VERSION << 4) | HEADER_WORDS
  header[1] = (messageType << 4) | flags
  header[2] = (serialization << 4) | compression
  header[3] = 0
  return header
}

/**
 * Build one complete request frame.
 * @param {object} parts - frame fields.
 * @param {number} parts.messageType - message type.
 * @param {number} [parts.flags] - message-type flags.
 * @param {number} [parts.serialization] - serialization method.
 * @param {number} [parts.sequence] - sequence number, when the flags call for one.
 * @param {Buffer} [parts.payload] - payload bytes.
 * @returns {Buffer} the frame.
 */
export function buildFrame({ messageType, flags = FLAG.NONE, serialization = SERIALIZATION.NONE, sequence, payload }) {
  const body = payload ?? Buffer.alloc(0)
  const parts = [buildHeader({ messageType, flags, serialization })]
  if (flags === FLAG.POSITIVE_SEQUENCE || flags === FLAG.LAST_WITH_SEQUENCE) {
    const seq = Buffer.alloc(4)
    seq.writeInt32BE(sequence ?? 1)
    parts.push(seq)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  parts.push(size)
  if (body.length > 0) parts.push(body)
  return Buffer.concat(parts)
}

/**
 * Build the first frame: session parameters, no audio yet.
 * @param {object} input - request inputs.
 * @param {Record<string, unknown>} input.config - effective configuration.
 * @param {string} [input.language] - provider language hint.
 * @returns {Buffer} full client request frame.
 */
export function buildFullClientRequest({ config, language }) {
  const audio = {
    // 这里必须声明 pcm，不能声明 wav：音频帧推的是剥掉 WAV 头的裸 PCM16LE。
    // 声明 wav 会让服务端按容器去解，直接报 "could not be decoded using the declared
    // format"——这个 bug 只有真实服务能抓到（本地 mock 会把错误的声明也当成正确）。
    format: String(config.streamFormat ?? 'pcm'),
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1,
  }
  // The streaming service only accepts an explicit language tag, and only this
  // mode reads the field at all; `auto` means "let the model decide", i.e. omit it.
  const tag = LANGUAGE_TAGS[language]
  if (tag) audio.language = tag

  const request = {
    model_name: String(config.modelName),
    enable_itn: true,
    enable_punc: true,
  }
  if (config.semanticSmoothing) request.enable_ddc = true

  const payload = Buffer.from(JSON.stringify({ user: { uid: 'dsh-voice-doubao' }, audio, request }), 'utf8')
  return buildFrame({
    messageType: MESSAGE_TYPE.FULL_CLIENT_REQUEST,
    flags: FLAG.NONE,
    serialization: SERIALIZATION.JSON,
    payload,
  })
}

/**
 * Build one audio frame.
 * @param {Buffer} chunk - raw PCM16 bytes.
 * @returns {Buffer} audio-only request frame.
 */
export function buildAudioFrame(chunk) {
  return buildFrame({ messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST, flags: FLAG.NONE, payload: chunk })
}

/**
 * Build the final (negative) packet: audio message type, last-packet flag, no payload.
 * @returns {Buffer} last packet.
 */
export function buildLastFrame() {
  return buildFrame({ messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST, flags: FLAG.LAST_WITHOUT_SEQUENCE })
}

/**
 * Parse one server frame.
 *
 * The protocol page draws a sequence field in the server response, but which
 * fields are actually present is what the flags say; server builds differ, so
 * both layouts are attempted and the one whose payload is valid JSON wins.
 *
 * @param {Buffer} frame - complete server frame.
 * @returns {{ messageType: number, flags: number, sequence: number, body: any, raw: Buffer }} parsed frame.
 */
export function parseServerFrame(frame) {
  const headerBytes = (frame[0] & 0x0f) * 4
  const messageType = frame[1] >> 4
  const flags = frame[1] & 0x0f
  const compression = frame[2] & 0x0f
  const rest = frame.subarray(headerBytes)

  /** @type {{ sequence: number, size: number, offset: number }[]} */
  const candidates = []
  if (rest.length >= 8) candidates.push({ sequence: rest.readInt32BE(0), size: rest.readUInt32BE(4), offset: 8 })
  if (rest.length >= 4) candidates.push({ sequence: 0, size: rest.readUInt32BE(0), offset: 4 })

  for (const candidate of candidates) {
    if (candidate.offset + candidate.size > rest.length) continue
    let payload = rest.subarray(candidate.offset, candidate.offset + candidate.size)
    if (compression === COMPRESSION.GZIP) {
      try {
        payload = gunzipSync(payload)
      } catch {
        continue
      }
    }
    const text = payload.toString('utf8')
    if (text.trim() === '') continue
    try {
      return { messageType, flags, sequence: candidate.sequence, body: JSON.parse(text), raw: payload }
    } catch {
      // Not this layout (or not JSON at all); try the next candidate.
    }
  }
  return { messageType, flags, sequence: 0, body: null, raw: rest }
}

/**
 * Compose the WebSocket handshake headers.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {Record<string, string>} headers for the upgrade request.
 */
export function buildHandshakeHeaders(config) {
  const headers = {
    'X-Api-Resource-Id': String(config.resourceId),
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1',
    'X-Api-Connect-Id': randomUUID(),
  }
  if (config.appId) headers['X-Api-App-Key'] = String(config.appId)
  if (config.accessToken) headers['X-Api-Access-Key'] = String(config.accessToken)
  if (config.apiKey) headers['X-Api-Key'] = String(config.apiKey)
  return headers
}

/**
 * Describe a server error frame in terms of what the user should fix.
 *
 * The one that bit us in practice: the concurrent SKU of the streaming model
 * ships with zero concurrency, so the very first request answers
 * `quota exceeded for types: concurrency`. That reads like "out of quota" but
 * actually means "you bought the wrong billing mode" — the hourly SKU is the
 * pay-as-you-go one.
 *
 * @param {any} body - parsed error payload.
 * @param {Buffer} raw - raw payload, for when it was not JSON.
 * @param {Record<string, unknown>} config - effective configuration, for the resource id.
 * @returns {Error} error carrying the service's own words and the fix.
 */
function errorFrom(body, raw, config) {
  const code = body?.code ?? body?.error_code ?? ''
  const message = body?.message ?? body?.error ?? raw?.toString('utf8')?.slice(0, 300) ?? ''
  const reason = speechFailureReason({
    code: String(code),
    message: String(message),
    resourceId: String(config?.resourceId ?? ''),
    kind: '流式语音识别',
  })
  return new Error(`豆包流式识别返回错误${code ? `（code=${code}）` : ''}${message ? `：${message}` : ''}　${reason}`)
}

/**
 * Explain a rejected handshake in terms of what the user can change.
 *
 * Two failures look alike from the outside but need opposite fixes, and only
 * the response body tells them apart: an unknown key answers `401 Invalid
 * X-Api-Key`, while a valid key with no grant for the resource answers `403
 * requested resource not granted`. That is the difference between "retype your
 * key" and "go activate the model", so they get different messages.
 *
 * @param {import('node:http').IncomingMessage} response - the upgrade response.
 * @param {string} body - response body, already read.
 * @param {Record<string, unknown>} config - effective configuration.
 * @returns {Error} error naming the cause and the fix.
 */
function handshakeError(response, body, config) {
  const detail = `${response.statusCode} ${response.statusMessage ?? ''}`.trim()
  const reason = /not granted/i.test(body)
    ? `这个 Key 是有效的，但没有被授权使用 ${config.resourceId}。` +
      '去「豆包语音」控制台的「语音识别」里点【试用】或【开通】对应模型；' +
      '如果已经开通，确认 Key 和模型在同一个项目下。'
    : /invalid x-api-key/i.test(body)
      ? 'API Key 无效。确认它来自「豆包语音」控制台（/speech/new/）——火山方舟的 Key 不能用于语音识别。'
      : `请检查 API Key、模型是否已开通，以及 resourceId 是否与你开通的模型一致——` +
        `当前是 ${config.resourceId}，只开通了 1.0 的话要改成 volc.bigasr.sauc.duration` +
        '（方舟的 Key 不能用于语音识别）。'
  return new Error(`豆包流式识别握手失败：HTTP ${detail}${body ? `　服务端原话：${body}` : ''}　${reason}`)
}

/**
 * Transcribe a finished recording through Doubao streaming ASR.
 *
 * The recording is pushed as fast as the socket accepts it — the caller already
 * has the whole thing in memory, so pacing to real time would only add the
 * recording's own duration to the wait.
 *
 * @param {object} input - call inputs.
 * @param {Buffer} input.pcm - raw 16 kHz mono PCM16 samples, no WAV header.
 * @param {string} [input.language] - provider language hint.
 * @param {Record<string, unknown>} input.config - effective configuration.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @param {(message: string, error?: unknown) => void} [input.warn] - diagnostics sink.
 * @returns {Promise<string>} recognised text.
 */
export async function transcribeStreaming({ pcm, language, config, signal, warn = () => {} }) {
  const headers = buildHandshakeHeaders(config)
  const socket = new WebSocket(String(config.endpoint), { headers, handshakeTimeout: Number(config.timeoutMs) })

  /** Latest transcript seen; the final response carries the complete one. */
  let latest = ''
  /** True once the negative packet has gone out; before that, no result is final. */
  let audioSent = false
  let settled = false
  let usable = false
  /** Safety valve: answers with what we have if the service goes quiet without saying it is done. */
  let quiet

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // The closing frame may never arrive. Text already received is still the
      // answer — but only if the whole recording actually went out: a segment
      // reported mid-upload is not the transcript.
      if (audioSent && latest !== '') finish(null, latest)
      else if (latest !== '') finish(new Error('豆包流式识别没收到收尾结果，只拿到半截文字，请重试'))
      else finish(new Error(`豆包流式识别超时（${config.timeoutMs} ms）`))
    }, Number(config.timeoutMs))
    const ackTimer = setTimeout(() => {
      // Some deployments never acknowledge the session frame; start pushing anyway.
      if (!usable) void pushAudio()
    }, Number(config.ackTimeoutMs))

    /**
     * Restart the safety valve. Restarting matters: a segment result can arrive
     * after the negative packet, and a fixed timer would answer with that
     * segment before the real closing response lands.
     */
    function armQuiet() {
      clearTimeout(quiet)
      quiet = setTimeout(() => finish(null, latest), Number(config.settleMs))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      clearTimeout(ackTimer)
      clearTimeout(quiet)
      signal?.removeEventListener('abort', onAbort)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    function finish(error, text) {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(text ?? latest)
    }
    function onAbort() {
      finish(signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消'))
    }

    /** Send the whole recording, then the negative packet. */
    async function pushAudio() {
      if (usable || settled) return
      usable = true
      const chunkBytes = Math.max(2, Math.round(Number(config.chunkMs) * BYTES_PER_MS))
      let sent = 0
      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        if (settled || socket.readyState !== WebSocket.OPEN) return
        socket.send(buildAudioFrame(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length))))
        // A long recording would otherwise be queued into the socket all at once,
        // and any response that arrives mid-upload would not be read until the end.
        if (++sent % YIELD_EVERY_FRAMES === 0) await new Promise((resolve) => setImmediate(resolve))
        if (socket.bufferedAmount > BACKPRESSURE_BYTES) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (settled || socket.readyState !== WebSocket.OPEN) return
      socket.send(buildLastFrame())
      audioSent = true
      if (config.logTranscripts) warn('豆包流式识别：音频已全部发送，等待结果')
    }

    // Listeners go on before anything can settle or bail out. `ws` emits 'error'
    // when a socket is closed before its handshake finishes, and an 'error' with
    // no listener is an uncaught exception — so a call cancelled before the
    // connection was established would otherwise take the whole process down.
    socket.on('open', () => {
      if (settled) return
      socket.send(buildFullClientRequest({ config, language }))
    })

    socket.on('message', (data) => {
      if (settled) return
      const frame = parseServerFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
      if (frame.messageType === MESSAGE_TYPE.SERVER_ERROR) {
        finish(errorFrom(frame.body, frame.raw, config))
        return
      }
      if (frame.messageType === MESSAGE_TYPE.SERVER_ACK) {
        // Session accepted: start pushing the recording.
        pushAudio()
        return
      }
      if (frame.messageType === MESSAGE_TYPE.FULL_SERVER_RESPONSE) {
        const text = frame.body?.result?.text
        if (typeof text === 'string' && text !== '') latest = text
        if (!usable) {
          // First response doubles as the acknowledgement; audio can start now.
          void pushAudio()
          return
        }
        if (!audioSent) {
          // Streaming-input mode reports at its 15 s mark while audio is still
          // uploading. That is a segment, not the answer: keep sending and wait
          // for the response to the negative packet.
          return
        }
        // A negative sequence or the last-packet flag marks the closing response.
        const last = frame.sequence < 0 || (frame.flags & FLAG.LAST_WITH_SEQUENCE) === FLAG.LAST_WITH_SEQUENCE
        if (last) {
          finish(null, latest)
          return
        }
        // Unmarked result after the negative packet: hold it and let the safety
        // valve decide, so a closing response arriving later still wins.
        armQuiet()
      }
    })

    socket.on('unexpected-response', (_request, response) => {
      // The body carries the actionable part, and it arrives after the headers.
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        finish(handshakeError(response, Buffer.concat(chunks).toString('utf8').trim().slice(0, 300), config))
      })
      response.on('error', () => finish(handshakeError(response, '', config)))
    })

    socket.on('error', (error) => finish(new Error(`豆包流式识别连接失败：${error.message}`)))

    socket.on('close', () => {
      if (settled) return
      if (audioSent && latest !== '') finish(null, latest)
      else if (latest !== '') finish(new Error('豆包流式识别连接中断，只拿到半截文字，请重试'))
      else finish(new Error('豆包流式识别连接被关闭，且没有返回任何文字'))
    })

    // Cancellation is wired last, so every listener above already exists by the
    // time an already-aborted signal settles the call.
    if (signal) {
      if (signal.aborted) {
        finish(signal.reason instanceof Error ? signal.reason : new Error('语音识别已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
