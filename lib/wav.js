/**
 * Recording contract.
 *
 * The browser contribution always uploads one canonical WAV: 16 kHz, mono,
 * PCM16 (the API Remote validates exactly that before the provider is called).
 * The provider only needs two facts from it — that the header really says that,
 * and how many seconds of audio it describes, because the cloud API bills by
 * duration and the transcript carries the measured length back to the UI.
 */

/** @typedef {{ sampleRate: number, channels: number, bitsPerSample: number, audioSeconds: number, dataBytes: number }} WaveInfo */

/**
 * Parse and validate a canonical 16 kHz mono PCM16 WAV buffer.
 * @param {Buffer} buffer - complete recording, as handed to the provider.
 * @returns {WaveInfo} validated format facts and measured duration.
 */
export function readWave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('录音数据不是有效的 WAV')
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('录音数据不是有效的 WAV 文件头')
  }

  let offset = 12
  let format = null
  let dataOffset = -1
  let dataBytes = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16) throw new Error('WAV 格式块不完整')
      const audioFormat = buffer.readUInt16LE(body)
      const channels = buffer.readUInt16LE(body + 2)
      const sampleRate = buffer.readUInt32LE(body + 4)
      const bitsPerSample = buffer.readUInt16LE(body + 14)
      if (audioFormat !== 1) throw new Error('WAV 必须是未压缩的 PCM 编码')
      format = { sampleRate, channels, bitsPerSample }
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, Math.max(0, buffer.length - body))
    }
    // Chunks are word-aligned: an odd payload is followed by one pad byte.
    offset = body + size + (size % 2)
  }

  if (!format) throw new Error('WAV 缺少 fmt 格式块')
  if (dataBytes === 0 || dataOffset < 0) throw new Error('WAV 里没有音频数据')
  if (format.sampleRate !== 16000) throw new Error(`录音采样率必须是 16 kHz，实际为 ${format.sampleRate}`)
  if (format.channels !== 1) throw new Error(`录音必须是单声道，实际为 ${format.channels} 声道`)
  if (format.bitsPerSample !== 16) throw new Error(`录音必须是 16 位采样，实际为 ${format.bitsPerSample} 位`)

  const frameBytes = (format.bitsPerSample / 8) * format.channels
  return {
    ...format,
    audioSeconds: dataBytes / frameBytes / format.sampleRate,
    dataOffset,
    dataBytes,
  }
}

/**
 * Build one canonical WAV of silence. Used by the offline tests; harmless in
 * production and kept here so the contract has a single definition.
 * @param {number} seconds - duration to synthesize.
 * @param {number} [sampleRate] - sample rate, 16 kHz by default.
 * @returns {Buffer} complete WAV file.
 */
export function silentWave(seconds, sampleRate = 16000) {
  const frames = Math.max(0, Math.round(seconds * sampleRate))
  const dataBytes = frames * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}
