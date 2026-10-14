/**
 * A local stand-in for Doubao's streaming ASR service.
 *
 * It frames and parses messages with its own small implementation rather than
 * importing the plugin's codec: a mock that shares the parser it is testing can
 * only prove the two halves agree with each other, not that either matches the
 * vendor's protocol page. Every byte this mock writes is built from that page's
 * field table.
 *
 * State is kept per connection, because the service accepts several recordings
 * at once; the `received` object still exposes the aggregate fields the simpler
 * tests read.
 */

import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

const MESSAGE_TYPE = { AUDIO_ONLY: 0b0010, SERVER_ACK: 0b1011, FULL_SERVER_RESPONSE: 0b1001, SERVER_ERROR: 0b1111 }

/**
 * Build one protocol frame.
 * @param {object} parts - frame fields.
 * @returns {Buffer} the frame.
 */
export function frame({ messageType, flags = 0, serialization = 0b0001, sequence, payload = Buffer.alloc(0) }) {
  const head = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4) | 0x00, 0x00])
  const parts = [head]
  if (flags & 0b0001) {
    const seq = Buffer.alloc(4)
    seq.writeInt32BE(sequence ?? 0)
    parts.push(seq)
  }
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  parts.push(size)
  if (payload.length > 0) parts.push(payload)
  return Buffer.concat(parts)
}

/**
 * A server response carrying `result.text`, in the sequence or no-sequence layout.
 * @param {string} text - transcript to report.
 * @param {object} [options] - layout switches.
 * @param {number} [options.sequence] - sequence number; negative marks the final response.
 * @param {boolean} [options.withSequenceField] - use the sequence-bearing layout.
 * @param {boolean} [options.final] - mark the response as the closing one.
 * @returns {Buffer} the frame.
 */
export function responseFrame(text, { sequence = -1, withSequenceField = true, final = true } = {}) {
  const payload = Buffer.from(JSON.stringify({ audio_info: { duration: 1000 }, result: { text } }), 'utf8')
  if (withSequenceField) {
    return frame({ messageType: MESSAGE_TYPE.FULL_SERVER_RESPONSE, flags: final ? 0b0011 : 0b0001, sequence, payload })
  }
  return frame({ messageType: MESSAGE_TYPE.FULL_SERVER_RESPONSE, flags: 0b0000, payload })
}

/**
 * Parse one client frame. Independent of the plugin's parser on purpose.
 * @param {Buffer} buffer - one WebSocket binary message.
 * @returns {{ messageType: number, flags: number, payload: Buffer }} parsed frame.
 */
export function parseClientFrame(buffer) {
  const headerBytes = (buffer[0] & 0x0f) * 4
  const messageType = buffer[1] >> 4
  const flags = buffer[1] & 0x0f
  let offset = headerBytes
  if (flags & 0b0001) offset += 4
  const size = buffer.readUInt32BE(offset)
  offset += 4
  return { messageType, flags, payload: buffer.subarray(offset, offset + size) }
}

/**
 * Start the mock service.
 * @param {object} [options] - behaviour switches.
 * @param {string} [options.text] - transcript to return.
 * @param {(index: number) => string} [options.textFor] - per-connection transcript, for concurrency checks.
 * @param {boolean} [options.unauthorized] - reject the upgrade instead of accepting it.
 * @param {number} [options.rejectStatus] - status for that rejection, 401 by default.
 * @param {string} [options.rejectReason] - reason phrase for that rejection.
 * @param {string} [options.rejectBody] - body for that rejection, so the client's message can be checked.
 * @param {boolean} [options.sendAck] - acknowledge the session frame.
 * @param {boolean} [options.withSequenceField] - use the sequence-bearing response layout.
 * @param {number} [options.resultDelayMs] - delay before answering the last packet.
 * @param {string} [options.partialText] - a segment result emitted mid-upload, as the real service does past its 15 s mark.
 * @param {string} [options.latePartialText] - a segment result emitted *after* the negative packet, before the closing one.
 * @param {{code: number, message: string}} [options.errorFrame] - answer with a server error instead.
 * @param {boolean} [options.silent] - never answer, to exercise cancellation and timeouts.
 * @returns {Promise<{ url: string, received: any, close: () => Promise<void> }>} running mock.
 */
export async function startMockSauc(options = {}) {
  const settings = {
    text: '我们把这个接口先接上',
    textFor: null,
    unauthorized: false,
    sendAck: true,
    withSequenceField: true,
    resultDelayMs: 0,
    partialText: null,
    latePartialText: null,
    errorFrame: null,
    silent: false,
    ...options,
  }

  /**
   * Per-connection state, plus the aggregate view the older assertions read.
   * `received.session`, `received.headers` and `received.partialSent` describe
   * the first connection that had them, which is what a single-recording test
   * means by them.
   */
  const received = {
    connections: 0,
    closed: 0,
    headers: null,
    session: null,
    audioBytes: 0,
    audioPayloads: [],
    frames: [],
    lastPacketSeen: false,
    partialSent: false,
    partialBeforeLast: undefined,
    latePartialSent: false,
    perConnection: [],
  }

  const wss = new WebSocketServer({ noServer: true })
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const index = received.connections++
    received.headers ??= request.headers
    if (settings.unauthorized) {
      const status = settings.rejectStatus ?? 401
      const reason = settings.rejectReason ?? 'Unauthorized'
      const body = settings.rejectBody ?? ''
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n` +
          'content-type: application/json\r\n' +
          `content-length: ${Buffer.byteLength(body)}\r\n` +
          'connection: close\r\n\r\n' +
          body,
      )
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, index))
  })

  wss.on('connection', (socket, _request, index) => {
    const state = { index, headers: _request.headers, session: null, audioBytes: 0, audioPayloads: [], lastPacketSeen: false, closed: false }
    received.perConnection.push(state)
    const answer = settings.textFor ? settings.textFor(index) : settings.text

    socket.on('close', () => {
      state.closed = true
      received.closed++
    })

    socket.on('message', (data) => {
      const parsed = parseClientFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
      received.frames.push(parsed.messageType)

      if (state.session === null && parsed.payload.length > 0) {
        try {
          state.session = JSON.parse(parsed.payload.toString('utf8'))
        } catch {
          state.session = { unparsed: parsed.payload.toString('utf8') }
        }
        received.session ??= state.session
        if (settings.sendAck) {
          socket.send(frame({ messageType: MESSAGE_TYPE.SERVER_ACK }))
        }
        return
      }

      if (parsed.messageType === MESSAGE_TYPE.AUDIO_ONLY) {
        state.audioBytes += parsed.payload.length
        state.audioPayloads.push(parsed.payload.length)
        received.audioBytes += parsed.payload.length
        received.audioPayloads.push(parsed.payload.length)

        // The real service reports a segment once the input passes 15 s; the
        // client must not mistake that for the answer.
        if (settings.partialText && parsed.payload.length > 0 && !state.partialSent) {
          state.partialSent = true
          received.partialSent = true
          // Record whether it beat the negative packet: only then does it test
          // the client's "is this the answer yet" decision.
          received.partialBeforeLast = !state.lastPacketSeen
          socket.send(responseFrame(settings.partialText, { sequence: 1, final: false }))
        }

        if (parsed.payload.length === 0) {
          state.lastPacketSeen = true
          received.lastPacketSeen = true
          if (settings.silent) return
          const replyFinal = () => {
            if (settings.errorFrame) {
              const payload = Buffer.from(JSON.stringify(settings.errorFrame), 'utf8')
              socket.send(frame({ messageType: MESSAGE_TYPE.SERVER_ERROR, payload }))
              return
            }
            socket.send(responseFrame(answer, { withSequenceField: settings.withSequenceField }))
          }
          const reply = () => {
            if (settings.latePartialText) {
              state.latePartialSent = true
              received.latePartialSent = true
              socket.send(responseFrame(settings.latePartialText, { sequence: 2, final: false }))
            }
            if (settings.resultDelayMs > 0) setTimeout(replyFinal, settings.resultDelayMs)
            else replyFinal()
          }
          reply()
        }
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
