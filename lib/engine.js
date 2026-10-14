/**
 * 选一条通道，把一段录音转成文字。
 *
 * 两条通道都真实跑通过，差别在资源要求与延迟：
 *
 *   submit  录音文件识别 2.0 标准版——提交 + 轮询，base64 直传，0.8 元/小时。
 *           只要 volc.seedasr.auc 一个资源，不需要公网托管。多一次轮询往返。
 *   stream  大模型流式语音识别——WebSocket 直推音频帧，1 元/小时。
 *           说完负包就返回，少一次往返；但需要开通流式那个资源。
 *
 * 校验规范 WAV 的活放在这里，两条通道共用：不管走哪条，非法录音都要在联网前被拒。
 */

import { transcribeSubmit } from './auc.js'
import { transcribeStreaming } from './sauc.js'
import { readWave } from './wav.js'

/**
 * @param {object} input - 调用输入。
 * @param {Buffer} input.audio - 规范 WAV（16 kHz 单声道 PCM16）。
 * @param {string} [input.language] - 语言提示。
 * @param {Record<string, unknown>} input.config - 生效配置。
 * @param {AbortSignal} [input.signal] - 调用方取消。
 * @param {(message: string, error?: unknown) => void} [input.warn] - 诊断输出。
 * @returns {Promise<{ text: string, audioSeconds: number }>} 文字与实测时长。
 */
export async function transcribeRecording({ audio, language, config, signal, warn }) {
  const wave = readWave(audio)
  const transport = chooseTransport(config, wave.audioSeconds)
  if (config.logTranscripts) warn(`dsh-voice-doubao：${wave.audioSeconds.toFixed(1)} 秒 → 走 ${transport} 通道`)
  const text =
    transport === 'stream'
      ? await transcribeStreaming({
          // 流式协议要的是裸采样，WAV 头到这里已经完成使命。
          pcm: audio.subarray(wave.dataOffset, wave.dataOffset + wave.dataBytes),
          language,
          config,
          signal,
          warn,
        })
      : await transcribeSubmit({ audio, language, config, signal, warn })
  return { text, audioSeconds: wave.audioSeconds }
}

/**
 * 按录音长度挑通道。
 *
 * 两条通道都是在真实服务上量过的（`test/bench.mjs`，每档 3 轮、交替顺序）：
 *
 *   4.3 秒   提交 1234ms   流式 1174ms     流式略快
 *   9.1 秒   提交 2343ms   流式 1714ms     流式快 27%
 *  21.0 秒   提交 3187ms   流式 3462ms     提交略快
 *  43.1 秒   提交 4150ms   流式 7619ms     提交快 84%
 *
 * 交叉点大约在 15 秒附近：短句走流式省几百毫秒，长录音走提交能省 3 秒以上。
 * 所以不要二选一，按长度自动走。
 *
 * @param {Record<string, unknown>} config - 生效配置。
 * @param {number} audioSeconds - 实测录音时长。
 * @returns {'submit' | 'stream'} 该走的通道。
 */
export function chooseTransport(config, audioSeconds) {
  const mode = String(config.transport)
  if (mode === 'stream' || mode === 'submit') return mode
  return audioSeconds <= Number(config.autoStreamMaxSeconds) ? 'stream' : 'submit'
}
