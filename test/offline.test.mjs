/**
 * Offline checks for dsh-voice-doubao.
 *
 * The recognizer talks to a WebSocket service, so the tests run against
 * `mock-sauc.mjs` — a local fake that builds its frames from the vendor's own
 * field table rather than from the plugin's codec. Nothing here touches the
 * network, needs a key, or costs anything.
 *
 * Run: node test/offline.test.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- isolate configuration before the plugin reads it -----------------------
const home = mkdtempSync(join(tmpdir(), 'voice-doubao-test-'))
process.env.DSH_HOME = home
for (const key of Object.keys(process.env)) if (key.startsWith('DOUBAO_')) delete process.env[key]

const { readWave, silentWave } = await import('../lib/wav.js')
const { cleanReply, acceptPolished, shouldPolish } = await import('../lib/polish.js')
const {
  buildFullClientRequest,
  buildAudioFrame,
  buildLastFrame,
  buildHandshakeHeaders,
  parseServerFrame,
  MESSAGE_TYPE,
} = await import('../lib/sauc.js')
const { configFilePath, loadConfig } = await import('../lib/config.js')
const { apply } = await import('../lib/index.js')
const { startMockSauc, frame, responseFrame } = await import('./mock-sauc.mjs')

// --- tiny assertion harness -------------------------------------------------
/** 默认资源 id：流式 2.0 小时版。与 lib/config.js 的默认值保持一致。 */
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function rejects(name, run, contains) {
  try {
    await run()
    check(name, false, '没有抛出错误')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(name, message.includes(contains), `错误信息是：${message}`)
  }
}

// --- the plugin mounted on a fake Host context ------------------------------
/** @type {Map<string, any>} */
const providers = new Map()
const logged = []
/** 测试里手动推动服务变化：模拟用户在界面里切换识别器。 */
let selectionNow = { providerId: 'doubao', language: 'auto' }
let pushSelection = null
const ctx = {
  logger: { warn: (message, error) => logged.push([message, error]) },
  effect: (run) => {
    run()
  },
  speechToText: {
    register: (provider) => {
      providers.set(provider.info.id, provider)
      return async () => providers.delete(provider.info.id)
    },
    snapshot: () => ({ providers: [], selection: selectionNow }),
    // 服务的真实接口：每次变化吐一个完整快照的异步生成器。
    async *follow(signal) {
      yield { providers: [], selection: selectionNow }
      while (!signal.aborted) {
        const next = await new Promise((resolve) => {
          pushSelection = resolve
        })
        yield next
      }
    },
  },
}

function mount(rowConfig) {
  providers.clear()
  apply(ctx, {
    // 这一套测试针对 WebSocket 那条通道；提交通道另有一段。
    transport: 'stream',
    apiKey: 'test-key',
    arkApiKey: 'ark-test-key',
    arkModel: 'doubao-seed-2-1-lite-260915',
    ...rowConfig,
  })
}

// --- 1. WAV contract --------------------------------------------------------
console.log('\nWAV 契约')
{
  const audio = silentWave(2.5)
  const wave = readWave(audio)
  check('2.5 秒的规范 WAV 解析出正确时长', Math.abs(wave.audioSeconds - 2.5) < 1e-6, `${wave.audioSeconds}`)
  check('采样率被识别为 16 kHz', wave.sampleRate === 16000, `${wave.sampleRate}`)
  check('单声道被识别为 1', wave.channels === 1, `${wave.channels}`)
  check('给出 PCM 数据起点', wave.dataOffset === 44, `${wave.dataOffset}`)
  check('PCM 长度 = 时长 × 32000', wave.dataBytes === 80000, `${wave.dataBytes}`)

  await rejects('非 16 kHz 被拒绝', async () => readWave(silentWave(1, 44100)), '16 kHz')
  await rejects('空数据被拒绝', async () => readWave(Buffer.alloc(10)), 'WAV')
  await rejects('非 RIFF 头被拒绝', async () => readWave(Buffer.alloc(64)), 'WAV')
}

// --- 2. protocol codec ------------------------------------------------------
console.log('\n协议分帧')
{
  // 默认值来自配置层，所以这里用真实默认值构造，而不是手搓一个 config
  const defaults = loadConfig({})
  check('默认配置就打开了识别侧顺滑', defaults.semanticSmoothing === true)
  const session = buildFullClientRequest({ config: defaults, language: 'auto' })
  check('会话帧首字节 = 版本1|头长1', session[0] === 0x11, `0x${session[0].toString(16)}`)
  check('会话帧类型 = full client request', session[1] >> 4 === MESSAGE_TYPE.FULL_CLIENT_REQUEST)
  check('会话帧序列化 = JSON', session[2] >> 4 === 0b0001, `0x${session[2].toString(16)}`)
  check('会话帧 payload size 为大端', session.readUInt32BE(4) === session.length - 8, `${session.readUInt32BE(4)}`)
  const sessionBody = JSON.parse(session.subarray(8).toString('utf8'))
  // 必须是 pcm：流式音频帧推的是剥掉 WAV 头的裸 PCM16LE。早先这里写的是 wav，
  // 结果真实服务报 "could not be decoded using the declared format"——
  // 本地 mock 会把错误声明也当正确，所以这条期望值本身就是 bug。
  check(
    '声明 pcm / 16k / 16bit / 单声道',
    sessionBody.audio.format === 'pcm' && sessionBody.audio.rate === 16000 && sessionBody.audio.bits === 16 && sessionBody.audio.channel === 1,
    JSON.stringify(sessionBody.audio),
  )
  check('模型档为 bigmodel', sessionBody.request.model_name === 'bigmodel')
  check('language=auto 时不发语言字段', sessionBody.audio.language === undefined)
  check('默认开启识别侧顺滑', sessionBody.request.enable_ddc === true)

  const zh = buildFullClientRequest({ config: { modelName: 'bigmodel' }, language: 'zh' })
  check('zh 映射为 zh-CN', JSON.parse(zh.subarray(8).toString('utf8')).audio.language === 'zh-CN')
  const verbatim = buildFullClientRequest({ config: { modelName: 'bigmodel', semanticSmoothing: false }, language: 'auto' })
  check('关掉后不下发 enable_ddc', JSON.parse(verbatim.subarray(8).toString('utf8')).request.enable_ddc === undefined)

  const audioFrame = buildAudioFrame(Buffer.alloc(6400))
  check('音频帧类型 = audio only', audioFrame[1] >> 4 === MESSAGE_TYPE.AUDIO_ONLY_REQUEST, `0x${audioFrame[1].toString(16)}`)
  check('音频帧 payload size = 6400', audioFrame.readUInt32BE(4) === 6400)
  check('音频帧无序列号字段', audioFrame.length === 8 + 6400, `${audioFrame.length}`)

  const last = buildLastFrame()
  check('末包长度为 8', last.length === 8, `${last.length}`)
  check('末包 flag = 0b0010（负包）', (last[1] & 0x0f) === 0b0010, `0b${(last[1] & 0x0f).toString(2)}`)
  check('末包 payload size = 0', last.readUInt32BE(4) === 0)

  // 服务端返回：带 sequence 字段与不带 sequence 字段两种布局都要能解析
  const withSeq = responseFrame('带序列号的返回', { sequence: -1, withSequenceField: true })
  const parsedWithSeq = parseServerFrame(withSeq)
  check('解析带 sequence 的返回', parsedWithSeq.body?.result?.text === '带序列号的返回', JSON.stringify(parsedWithSeq.body))
  check('解析出负的 sequence', parsedWithSeq.sequence === -1, `${parsedWithSeq.sequence}`)
  const noSeq = responseFrame('不带序列号的返回', { withSequenceField: false })
  const parsedNoSeq = parseServerFrame(noSeq)
  check('解析不带 sequence 的返回', parsedNoSeq.body?.result?.text === '不带序列号的返回', JSON.stringify(parsedNoSeq.body))

  const errorFrame = frame({ messageType: MESSAGE_TYPE.SERVER_ERROR, payload: Buffer.from(JSON.stringify({ code: 45000001, message: 'bad' })) })
  check('识别错误帧', parseServerFrame(errorFrame).messageType === MESSAGE_TYPE.SERVER_ERROR)

  const headers = buildHandshakeHeaders({ apiKey: 'K', resourceId: DEFAULT_RESOURCE_ID })
  check('握手头带 X-Api-Key', headers['X-Api-Key'] === 'K')
  check('握手头带资源 id', headers['X-Api-Resource-Id'] === DEFAULT_RESOURCE_ID)
  check('握手头带 X-Api-Sequence: -1', headers['X-Api-Sequence'] === '-1')
  check('握手头带 connect id', typeof headers['X-Api-Connect-Id'] === 'string' && headers['X-Api-Connect-Id'].length > 10)
  check('握手头带 request id', typeof headers['X-Api-Request-Id'] === 'string')
  const legacy = buildHandshakeHeaders({ appId: 'A', accessToken: 'T', resourceId: 'r' })
  check('旧版控制台用 App-Key + Access-Key', legacy['X-Api-App-Key'] === 'A' && legacy['X-Api-Access-Key'] === 'T')
  check('旧版控制台不发 X-Api-Key', legacy['X-Api-Key'] === undefined)
}

// --- 3. 顺稿规则 ------------------------------------------------------------
console.log('\n顺稿规则')
{
  check('去掉代码围栏', cleanReply('```\n你好世界\n```') === '你好世界')
  check('去掉整体引号', cleanReply('“你好世界”') === '你好世界')
  check('去掉"整理后："前缀', cleanReply('整理后：你好世界') === '你好世界')
  check('空回复返回空串', cleanReply('   ') === '')
  check('短文本不触发顺稿', shouldPolish('嗯') === false)
  check('长文本触发顺稿', shouldPolish('那个我想说一下这个事情') === true)
  check('空结果是不可接受的', acceptPolished('原文', '') === false)
  check('正常改写可接受', acceptPolished('嗯 那个 我们 把 接口 接 一下', '我们把接口接一下。') === true)
  check('膨胀成答案不可接受', acceptPolished('今天天气怎么样', '今天天气'.repeat(30)) === false)

  // 下面三组是顺稿提示词的实测输出。护栏必须放行它们——真实顺稿通常是变短的，
  // 如果这里被拦下，说明护栏收得太紧，用户会拿到没整理过的原文。
  const measured = [
    ['嗯 那个 我 觉得 我们 应该 把 这个 接口 先 接 上 然后 再 说 后面 的 事情', '我觉得我们应该把这个接口先接上，再说后面的事情。'],
    ['那个 你 帮 我 看 一下 这个 报错 是 什么 意思 啊', '你帮我看一下这个报错是什么意思啊？'],
    ['嗯嗯 好 的 好 的 那 就 这样 吧', '嗯嗯，好的好的，那就这样吧。'],
  ]
  for (const [raw, out] of measured) {
    check(`实测顺稿输出通过护栏（${out.slice(0, 10)}…）`, acceptPolished(raw, cleanReply(out)) === true)
  }
  // 护栏是粗网：它拦的是"明显跑去回答问题"的膨胀输出，不是语义判断。
  // 真正的第一道防线是提示词里的"不回答问题"，这条由 prompt-check 单独验证。
  const runaway = `这个报错的意思是你的 API Key 没有配置。${'你需要在配置文件里填上豆包语音的密钥，然后重启 DSH。'.repeat(3)}`
  check('跑去回答问题的膨胀输出被拒绝', acceptPolished(measured[1][0], runaway) === false)
}

// --- 4. 端到端（本地假服务） ------------------------------------------------
console.log('\n端到端')
{
  const asr = await startMockSauc({ text: '嗯 那个 我们 把 这个 接口 先 接 上' })
  const ark = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      ark.seen = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '我们把这个接口先接上。' } }] }))
    })
  })
  await new Promise((resolve) => ark.listen(0, '127.0.0.1', resolve))
  const arkUrl = `http://127.0.0.1:${ark.address().port}/chat`

  mount({ endpoint: asr.url, arkEndpoint: arkUrl })

  check('配置了方舟 Key 时注册两个识别器', providers.size === 2, [...providers.keys()].join(','))
  const info = providers.get('doubao-polished').info
  check('识别器标记为云端', info.location === 'cloud', info.location)
  check('语言列表含 auto', info.languages.includes('auto'))
  check('云端识别器没有下载源', info.downloadSources.length === 0)

  const audio = silentWave(2.5)
  const result = await providers.get('doubao-polished').transcribe({ audio, language: 'auto' })
  check('返回顺稿后的文字', result.text === '我们把这个接口先接上。', result.text)
  check('返回音频时长', Math.abs(result.audioSeconds - 2.5) < 1e-6, `${result.audioSeconds}`)
  check('返回推理耗时', typeof result.inferenceSeconds === 'number' && result.inferenceSeconds >= 0)

  check('握手带上 API Key', asr.received.headers['x-api-key'] === 'test-key', JSON.stringify(asr.received.headers))
  check('握手带上资源 id', asr.received.headers['x-api-resource-id'] === DEFAULT_RESOURCE_ID)
  check('握手带上 X-Api-Sequence', asr.received.headers['x-api-sequence'] === '-1')
  check('会话参数声明 16k/16bit/单声道', asr.received.session?.audio?.rate === 16000 && asr.received.session?.audio?.bits === 16 && asr.received.session?.audio?.channel === 1)
  check('推送的 PCM 字节数与录音一致', asr.received.audioBytes === 80000, `${asr.received.audioBytes}`)
  const audioPackets = asr.received.audioPayloads.filter((size) => size > 0)
  check('200ms 分包得到 13 个音频包', audioPackets.length === 13, `${audioPackets.length}`)
  check('每个音频包不超过 200ms', audioPackets.every((size) => size <= 6400), audioPackets.join(','))
  check('最后一包是空 payload 的负包', asr.received.audioPayloads.at(-1) === 0, `${asr.received.audioPayloads.at(-1)}`)
  check('发了负包', asr.received.lastPacketSeen)
  check('顺稿请求带 Bearer', ark.seen !== undefined)
  check('顺稿请求关掉深度思考', ark.seen?.thinking?.type === 'disabled', JSON.stringify(ark.seen?.thinking))
  check('顺稿 system 提示要求只做整理', JSON.stringify(ark.seen?.messages?.[0]?.content ?? '').includes('不回答问题'))

  // 原样识别的那条不应该触发顺稿
  ark.seen = undefined
  const raw = await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  check('原样识别返回识别原文', raw.text.includes('接口'), raw.text)
  check('原样识别不调顺稿', ark.seen === undefined)

  ark.seen = undefined
  await providers.get('doubao-polished').transcribe({ audio: silentWave(1), language: 'auto' })
  check('顺稿用 arkModel 指定的模型', ark.seen?.model === 'doubao-seed-2-1-lite-260915', String(ark.seen?.model))

  // 没配方舟 Key 时，不该出现"顺稿"选项：它们会静默退化成纯识别，
  // 摆在下拉里等于对用户承诺一件做不到的事。这条是用户实际反馈逼出来的。
  mount({ endpoint: asr.url, arkEndpoint: arkUrl, arkApiKey: '' })
  check(
    '没配方舟 Key 时不显示顺稿选项',
    providers.size === 1 && providers.has('doubao'),
    [...providers.keys()].join(','),
  )

  // 不带 sequence 字段的服务端布局也要能走通
  await asr.close()
  const alt = await startMockSauc({ text: '备用布局', withSequenceField: false })
  mount({ endpoint: alt.url, arkEndpoint: arkUrl })
  const altResult = await providers.get('doubao').transcribe({ audio: silentWave(0.5), language: 'auto' })
  check('服务端不带 sequence 字段也能解析', altResult.text === '备用布局', altResult.text)
  await alt.close()

  // 音频超过 15 秒时，流式输入模式会先给一段中间结果。它不能当成最终答案，
  // 也不能让整段录音被截断。
  const partial = await startMockSauc({ text: '嗯 那个 我 觉得 我们 应该 把 这个 接口 先 接 上', partialText: '嗯 那个 我 觉得' })
  mount({ endpoint: partial.url, arkApiKey: '' })
  const long = await providers.get('doubao').transcribe({ audio: silentWave(20), language: 'auto' })
  check('长录音不会被中间结果截断', long.text === '嗯 那个 我 觉得 我们 应该 把 这个 接口 先 接 上', long.text)
  check('中间结果确实早于负包到达（真的考到了收尾判断）', partial.received.partialBeforeLast === true, `partialSent=${partial.received.partialSent} lastSeen=${partial.received.lastPacketSeen}`)
  check('20 秒录音推送了 20 秒的 PCM', partial.received.audioBytes === 640000, `${partial.received.audioBytes}`)
  await partial.close()

  // 更刁钻的时序：中间结果排在负包之后才回来，且最终结果晚 400ms 才到。
  // 收尾窗口必须让最终结果赢，不能被那段中间结果先截走。
  const late = await startMockSauc({ text: '最终完整的句子', latePartialText: '中间的半句', resultDelayMs: 400 })
  mount({ endpoint: late.url, arkApiKey: '' })
  const lateResult = await providers.get('doubao').transcribe({ audio: silentWave(20), language: 'auto' })
  check('负包之后才到的中间结果不会覆盖最终结果', lateResult.text === '最终完整的句子', lateResult.text)
  check('确实发了晚到的中间结果', late.received.latePartialSent === true)
  await late.close()

  // 证明上一条断言不是空跑：把安全阀调到比 400ms 的在途响应还短，就会截断。
  // 这同时钉住了 settleMs 必须大于任何在途响应间隔这一设计约束。
  const tooShort = await startMockSauc({ text: '最终完整的句子', latePartialText: '中间的半句', resultDelayMs: 400 })
  mount({ endpoint: tooShort.url, arkApiKey: '', settleMs: 100 })
  const truncated = await providers.get('doubao').transcribe({ audio: silentWave(2), language: 'auto' })
  check('安全阀过短确实会截断（说明收尾判断真的在起作用）', truncated.text === '中间的半句', truncated.text)
  await tooShort.close()

  await new Promise((resolve) => ark.close(resolve))
}

// --- 5. 取消与并发 ----------------------------------------------------------// 麦克风界面上有停止/取消，用户也可能连着说几段；这两条都是会走到的路径。
console.log('\n取消与并发')
{
  // 取消：服务端一直不回，用户中途点停止——必须立刻中断，不能干等到超时
  const quiet = await startMockSauc({ silent: true })
  mount({ endpoint: quiet.url, arkApiKey: '' })
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' }, controller.signal)
  setTimeout(() => controller.abort(new Error('用户点了停止')), 120)
  let cancelMessage = ''
  try {
    await pending
  } catch (error) {
    cancelMessage = error instanceof Error ? error.message : String(error)
  }
  const elapsed = Date.now() - startedAt
  check('取消会立刻中断并带出原因', cancelMessage.includes('用户点了停止'), cancelMessage)
  check('取消没有干等到超时', elapsed < 1000, `${elapsed}ms`)
  await new Promise((resolve) => setTimeout(resolve, 120))
  check('取消后连接被关掉（不泄漏 socket）', quiet.received.closed >= 1, `closed=${quiet.received.closed}`)
  await quiet.close()

  // 还没开始就取消：这是最容易漏的一条。ws 在连接建立前被 close 会 emit 'error'，
  // 如果那时还没绑定 error 监听，整个进程会因未捕获异常挂掉。
  const preAborted = await startMockSauc({ silent: true })
  mount({ endpoint: preAborted.url, arkApiKey: '' })
  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  const already = new AbortController()
  already.abort(new Error('还没开始就取消了'))
  let preMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' }, already.signal)
  } catch (error) {
    preMessage = error instanceof Error ? error.message : String(error)
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  process.off('uncaughtException', onUncaught)
  check('未开始就取消会立刻失败并带出原因', preMessage.includes('还没开始就取消了'), preMessage)
  check(
    '未开始就取消不会抛出未捕获异常',
    uncaught.length === 0,
    uncaught.map((error) => error?.message).join(' | '),
  )
  await preAborted.close()

  // 并发：三段录音同时识别，各自拿各自的文字
  const many = await startMockSauc({ textFor: (index) => `第${index + 1}条` })
  mount({ endpoint: many.url, arkApiKey: '' })
  const results = await Promise.all(
    [0, 1, 2].map(() => providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })),
  )
  check('三段并发都返回了', results.length === 3)
  check('三段结果互不串台', new Set(results.map((item) => item.text)).size === 3, results.map((item) => item.text).join(' / '))
  check(
    '三段结果正好是各自那一条',
    results.map((item) => item.text).sort().join(',') === '第1条,第2条,第3条',
    results.map((item) => item.text).join(','),
  )
  check('开了三个独立连接', many.received.connections === 3, `${many.received.connections}`)
  check('每段录音的字节数各自记对', many.received.perConnection.every((state) => state.audioBytes === 32000))
  await many.close()
}

// --- 6. 回退与报错 ----------------------------------------------------------
console.log('\n回退与报错')
{
  // 顺稿接口挂掉：必须保留识别结果
  const asr = await startMockSauc({ text: '我们把这个接口接一下' })
  const dead = createServer()
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadUrl = `http://127.0.0.1:${dead.address().port}/chat`
  await new Promise((resolve) => dead.close(resolve)) // 端口已关闭，连接必然失败

  mount({ endpoint: asr.url, arkEndpoint: deadUrl })
  const fallback = await providers.get('doubao-polished').transcribe({ audio: silentWave(1), language: 'auto' })
  check('顺稿失败时保留识别文字', fallback.text === '我们把这个接口接一下', fallback.text)
  check('顺稿失败会写日志', logged.some(([message]) => String(message).includes('顺稿失败')))
  await asr.close()

  // 顺稿接口卡住不回：识别结果必须照常返回，不能被一起拖死
  const hangingArk = createServer((request) => {
    request.resume() // 收下请求，永不响应
  })
  await new Promise((resolve) => hangingArk.listen(0, '127.0.0.1', resolve))
  const slowAsr = await startMockSauc({ text: '我们把这个接口接一下' })
  mount({
    endpoint: slowAsr.url,
    arkEndpoint: `http://127.0.0.1:${hangingArk.address().port}/chat`,
    timeoutMs: 700,
  })
  const hungStartedAt = Date.now()
  const hung = await providers.get('doubao-polished').transcribe({ audio: silentWave(1), language: 'auto' })
  const hungTook = Date.now() - hungStartedAt
  check('顺稿卡住时照常返回识别结果', hung.text === '我们把这个接口接一下', hung.text)
  check('顺稿卡住不会拖很久（受 timeoutMs 约束）', hungTook < 3000, `${hungTook}ms`)
  await slowAsr.close()
  hangingArk.closeAllConnections?.()
  await new Promise((resolve) => hangingArk.close(resolve))

  // 服务端返回错误帧
  const bad = await startMockSauc({ errorFrame: { code: 45000001, message: 'invalid request' } })
  mount({ endpoint: bad.url, arkApiKey: '' })
  await rejects(
    '服务端错误帧会带出错误码',
    async () => await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' }),
    '45000001',
  )
  await bad.close()

  // 实测踩到的坑：开通「并发版」但没买并发路数时，第一次请求就报这个。
  // 它读起来像"额度用完了"，其实意思是"买错了计费方式"，提示必须说清。
  const noConcurrency = await startMockSauc({
    errorFrame: { code: 0, message: 'quota exceeded for types: concurrency' },
  })
  mount({ endpoint: noConcurrency.url, arkApiKey: '' })
  let concurrencyMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  } catch (error) {
    concurrencyMessage = error instanceof Error ? error.message : String(error)
  }
  check('并发额度为 0 时说明是计费方式选错', concurrencyMessage.includes('并发额度为 0'), concurrencyMessage)
  check('并发额度提示里给出小时版的资源 id', concurrencyMessage.includes('volc.seedasr.sauc.duration'), concurrencyMessage)
  check('并发额度提示里保留服务端原话', concurrencyMessage.includes('quota exceeded'), concurrencyMessage)
  await noConcurrency.close()

  // 静音：真实服务返回 20000003 + "no valid speech in audio"。这条最容易被误报成
  // "账号没开通"，而它和账号毫无关系——所以专门钉一条回归测试。
  const silentFrame = await startMockSauc({ errorFrame: { code: '20000003', message: '[Normal silence audio] Handle response: no valid speech in audio' } })
  mount({ endpoint: silentFrame.url, arkApiKey: '' })
  let silenceMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  } catch (error) {
    silenceMessage = error instanceof Error ? error.message : String(error)
  }
  check('静音会说清是"没检测到人声"', silenceMessage.includes('没有检测到人声'), silenceMessage)
  check('静音不会被误报成"没开通"', !silenceMessage.includes('没有被授权') && !silenceMessage.includes('是否已开通'), silenceMessage)
  await silentFrame.close()

  // 握手被拒
  const denied = await startMockSauc({ unauthorized: true })
  mount({ endpoint: denied.url, arkApiKey: '' })
  let handshakeMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  } catch (error) {
    handshakeMessage = error instanceof Error ? error.message : String(error)
  }
  check('握手 401 报出可诊断的错误', handshakeMessage.includes('HTTP 401'), handshakeMessage)
  // 改了默认资源 id 之后，这条提示更重要：要指回当前用的 id 和 1.0 的退路
  check('握手报错里点名了当前资源 id', handshakeMessage.includes(DEFAULT_RESOURCE_ID), handshakeMessage)
  check('握手报错里给出 1.0 的退路', handshakeMessage.includes('volc.bigasr.sauc.duration'), handshakeMessage)
  check('握手报错里提醒方舟 Key 不能用', handshakeMessage.includes('方舟'), handshakeMessage)
  await denied.close()

  // 真实服务对这两种失败给的响应完全不同，处置也完全相反（这是实测出来的）：
  //   401 {"error":"Invalid X-Api-Key"}                              → Key 有问题
  //   403 {"error":"[resource_id=…] requested resource not granted"} → Key 没问题，去开通模型
  async function handshakeFailureOf(mock) {
    mount({ endpoint: mock.url, arkApiKey: '' })
    try {
      await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const ungranted = await startMockSauc({
    unauthorized: true,
    rejectStatus: 403,
    rejectReason: 'Forbidden',
    rejectBody: `{"error":"[resource_id=${DEFAULT_RESOURCE_ID}] requested resource not granted"}`,
  })
  const ungrantedMessage = await handshakeFailureOf(ungranted)
  check(
    '403 未授权会提示"Key 有效但没开通"',
    ungrantedMessage.includes('没有被授权') && ungrantedMessage.includes('开通'),
    ungrantedMessage,
  )
  check('403 会把服务端原话带出来', ungrantedMessage.includes('requested resource not granted'), ungrantedMessage)
  check('403 不会被误报成 Key 无效', !ungrantedMessage.includes('API Key 无效'), ungrantedMessage)
  await ungranted.close()

  const invalidKey = await startMockSauc({
    unauthorized: true,
    rejectStatus: 401,
    rejectReason: 'Unauthorized',
    rejectBody: '{"error":"Invalid X-Api-Key"}',
  })
  const invalidKeyMessage = await handshakeFailureOf(invalidKey)
  check('401 无效 Key 会直说 Key 无效', invalidKeyMessage.includes('API Key 无效'), invalidKeyMessage)
  check('401 不会被误报成"没授权"', !invalidKeyMessage.includes('没有被授权'), invalidKeyMessage)
  await invalidKey.close()

  // 服务端一直不回
  const silent = await startMockSauc({ silent: true })
  mount({ endpoint: silent.url, arkApiKey: '', timeoutMs: 1500, ackTimeoutMs: 200 })
  await rejects(
    '超时会中断并报错',
    async () => await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' }),
    '超时',
  )
  await silent.close()

  // 没有密钥：必须指出要改哪个文件，而且不应该发起连接
  const probe = await startMockSauc({})
  mount({ endpoint: probe.url, apiKey: undefined, appId: undefined, accessToken: undefined, arkApiKey: undefined })
  writeFileSync(configFilePath(), '{}', 'utf8')
  await rejects(
    '没有密钥时给出可操作的提示',
    async () => await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' }),
    'voice-doubao.json',
  )
  check('缺密钥时不会去连服务', probe.received.connections === 0, `${probe.received.connections}`)

  // 非法音频：在联网前就被拒绝
  mount({ endpoint: probe.url, arkApiKey: '' })
  await rejects(
    '非法音频在联网前被拒绝',
    async () => await providers.get('doubao').transcribe({ audio: silentWave(1, 44100), language: 'auto' }),
    '16 kHz',
  )
  check('非法音频不会去连服务', probe.received.connections === 0, `${probe.received.connections}`)
  await probe.close()
}

// --- 7. 配置文件优先级 ------------------------------------------------------
console.log('\n配置文件')
{
  writeFileSync(configFilePath(), JSON.stringify({ apiKey: 'from-file', arkApiKey: 'ark-file' }), 'utf8')
  const { redacted } = await import('../lib/config.js')
  const loaded = loadConfig({})
  check('从 JSON 文件读到密钥', loaded.apiKey === 'from-file', loaded.apiKey)
  check('脱敏视图不泄露密钥', !JSON.stringify(redacted(loaded)).includes('from-file'))
  const overridden = loadConfig({ endpoint: 'wss://example.invalid/x' })
  check('行配置可覆盖默认值', overridden.endpoint === 'wss://example.invalid/x')
  check('行配置为空时不覆盖文件密钥', overridden.apiKey === 'from-file')
  check('默认走流式输入模式', loadConfig({}).endpoint.endsWith('/sauc/bigmodel_nostream'), loadConfig({}).endpoint)
  check('默认资源 id 指向 2.0 小时版（单价 1 元/小时）', loadConfig({}).resourceId === 'volc.seedasr.sauc.duration', loadConfig({}).resourceId)
  process.env.DOUBAO_SPEECH_API_KEY = 'from-env'
  check('环境变量优先级最高', loadConfig({}).apiKey === 'from-env')
  delete process.env.DOUBAO_SPEECH_API_KEY

  // 模板里的 `_说明` 这类注释键不能进入生效配置，否则会污染日志和状态文件
  writeFileSync(configFilePath(), JSON.stringify({ _说明: '给我自己看的说明', _apiKey: '去哪拿 Key', apiKey: 'k' }), 'utf8')
  const annotated = loadConfig({})
  check('读文件时丢掉 _ 开头的注释键', !('_说明' in annotated) && !('_apiKey' in annotated), Object.keys(annotated).join(','))
  check('注释键不影响真实字段', annotated.apiKey === 'k', annotated.apiKey)
  check('注释键也不会出现在脱敏视图里', !JSON.stringify(redacted(annotated)).includes('给我自己看的说明'))
  check('行配置里的注释键同样被丢掉', !('_note' in loadConfig({ _note: 'x' })))

  const numeric = loadConfig({ chunkMs: 'abc', timeoutMs: -5 })
  check('非法数值回落到默认值', numeric.chunkMs === 200 && numeric.timeoutMs === 60000, `${numeric.chunkMs}/${numeric.timeoutMs}`)
}

// --- 8. 提交通道（录音文件识别 2.0 标准版） ---------------------------------
// 这条通道是实测出来的：文档只写了 audio.url，但账号授权后直接试，base64 是收的。
console.log('\n提交通道（录音文件识别 2.0 标准版）')
{
  /** 假服务：/submit 直接受理，/query 先回两次"处理中"再回结果。 */
  async function startMockAuc(options = {}) {
    const settings = { text: '提交通道识别结果', processingTimes: 2, submitCode: '20000000', queryCode: '20000000', queryMessage: 'OK', ...options }
    const seen = { submit: null, queryHeaders: [], queryCount: 0, submitCount: 0 }
    const server = createServer((request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const headers = { 'content-type': 'application/json' }
        if (request.url === '/submit') {
          seen.submitCount++
          seen.submit = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          headers['X-Api-Status-Code'] = settings.submitCode
          headers['X-Api-Message'] = settings.submitCode === '20000000' ? 'OK' : 'requested resource not granted'
          response.writeHead(settings.submitCode === '20000000' ? 200 : 403, headers)
          response.end(JSON.stringify(settings.submitCode === '20000000' ? {} : { header: { code: 45000030, message: 'requested resource not granted' } }))
          return
        }
        seen.queryCount++
        seen.queryHeaders.push(request.headers)
        if (seen.queryCount <= settings.processingTimes) {
          headers['X-Api-Status-Code'] = '20000001'
          response.writeHead(200, headers)
          response.end('{}')
          return
        }
        headers['X-Api-Status-Code'] = settings.queryCode
        headers['X-Api-Message'] = settings.queryMessage
        response.writeHead(200, headers)
        response.end(JSON.stringify({ result: { text: settings.text } }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    return { seen, close: () => new Promise((resolve) => server.close(resolve)), base }
  }

  const mock = await startMockAuc()
  mount({
    transport: 'submit',
    submitEndpoint: `${mock.base}/submit`,
    queryEndpoint: `${mock.base}/query`,
    arkApiKey: '',
    pollIntervalMs: 20,
  })
  const audio = silentWave(2)
  const out = await providers.get('doubao').transcribe({ audio, language: 'auto' })
  check('提交通道拿到结果', out.text === '提交通道识别结果', out.text)
  check('提交通道返回音频时长', Math.abs(out.audioSeconds - 2) < 1e-6, `${out.audioSeconds}`)
  check('提交带 API Key', mock.seen.submit?.headers['x-api-key'] === 'test-key')
  check('提交带资源 id', mock.seen.submit?.headers['x-api-resource-id'] === 'volc.seedasr.auc', String(mock.seen.submit?.headers['x-api-resource-id']))
  check('音频以 base64 放在 audio.data', mock.seen.submit?.body?.audio?.data === audio.toString('base64'))
  check('提交声明 wav 格式', mock.seen.submit?.body?.audio?.format === 'wav')
  check('提交带模型档', mock.seen.submit?.body?.request?.model_name === 'bigmodel')
  check('默认开启识别侧顺滑', mock.seen.submit?.body?.request?.enable_ddc === true)
  check(
    '查询复用了提交时那个任务 id',
    mock.seen.queryHeaders.length > 0 && mock.seen.queryHeaders.every((h) => h['x-api-request-id'] === mock.seen.submit.headers['x-api-request-id']),
  )
  check('处理中会继续轮询', mock.seen.queryCount === 3, `${mock.seen.queryCount}`)
  await mock.close()

  // 提交完立刻查一次，不要先白等一个间隔。用一个很大的间隔来证明：
  // 如果实现里先 sleep，这次调用就会等满 5 秒。
  const immediate = await startMockAuc({ processingTimes: 0 })
  mount({
    transport: 'submit',
    submitEndpoint: `${immediate.base}/submit`,
    queryEndpoint: `${immediate.base}/query`,
    arkApiKey: '',
    pollIntervalMs: 5000,
  })
  const startedImmediate = Date.now()
  const quick = await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  const tookImmediate = Date.now() - startedImmediate
  check('提交后立刻查询，不等第一个间隔', quick.text === '提交通道识别结果' && tookImmediate < 2000, `${tookImmediate}ms`)
  check('立刻查询只用一次请求', immediate.seen.queryCount === 1, `${immediate.seen.queryCount}`)
  await immediate.close()

  // 提交阶段就被拒（没授权）：要说清是"没授权"而不是"Key 不对"
  const denied = await startMockAuc({ submitCode: '45000030' })
  mount({
    transport: 'submit',
    submitEndpoint: `${denied.base}/submit`,
    queryEndpoint: `${denied.base}/query`,
    arkApiKey: '',
    pollIntervalMs: 20,
  })
  let deniedMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  } catch (error) {
    deniedMessage = error instanceof Error ? error.message : String(error)
  }
  check('提交被拒会说清是没授权', deniedMessage.includes('没有被授权'), deniedMessage)
  check('提交被拒会带上服务端原话', deniedMessage.includes('not granted'), deniedMessage)
  check('提交被拒不会误报成 Key 无效', !deniedMessage.includes('API Key 无效'), deniedMessage)
  check('被拒时没有进入轮询', denied.seen.queryCount === 0, `${denied.seen.queryCount}`)
  await denied.close()

  // 非法音频：提交通道同样要在联网前拒绝
  const untouched = await startMockAuc()
  mount({
    transport: 'submit',
    submitEndpoint: `${untouched.base}/submit`,
    queryEndpoint: `${untouched.base}/query`,
    arkApiKey: '',
    pollIntervalMs: 20,
  })
  await rejects(
    '提交通道也会在联网前拒绝非法音频',
    async () => await providers.get('doubao').transcribe({ audio: silentWave(1, 44100), language: 'auto' }),
    '16 kHz',
  )
  check('非法音频不会发出提交请求', untouched.seen.submitCount === 0, `${untouched.seen.submitCount}`)
  await untouched.close()

  // 同一条静音错误走提交通道，也要给出同一种解释
  const silentAuc = await startMockAuc({
    queryCode: '20000003',
    queryMessage: '[Normal silence audio] Handle response: no valid speech in audio',
    processingTimes: 0,
  })
  mount({
    transport: 'submit',
    submitEndpoint: `${silentAuc.base}/submit`,
    queryEndpoint: `${silentAuc.base}/query`,
    arkApiKey: '',
    pollIntervalMs: 20,
  })
  let silentAucMessage = ''
  try {
    await providers.get('doubao').transcribe({ audio: silentWave(1), language: 'auto' })
  } catch (error) {
    silentAucMessage = error instanceof Error ? error.message : String(error)
  }
  check('提交通道的静音也说是没检测到人声', silentAucMessage.includes('没有检测到人声'), silentAucMessage)
  check('提交通道的静音不误报成没开通', !silentAucMessage.includes('是否已开通'), silentAucMessage)
  await silentAuc.close()
}

// --- 8. 通道选择 ------------------------------------------------------------
// auto 不是拍脑袋定的：两条通道都在真实服务上量过（test/bench.mjs，每档 3 轮）。
console.log('\n通道选择')
{
  const { chooseTransport } = await import('../lib/engine.js')
  const defaults = loadConfig({})
  check('默认就是 auto', defaults.transport === 'auto', String(defaults.transport))
  check('auto：短录音走流式', chooseTransport(defaults, 5) === 'stream')
  check('auto：长录音走提交', chooseTransport(defaults, 30) === 'submit')
  check(
    'auto：阈值是闭区间，15 秒走流式、15.1 秒走提交',
    chooseTransport(defaults, 15) === 'stream' && chooseTransport(defaults, 15.1) === 'submit',
  )
  check('显式 stream 覆盖 auto', chooseTransport({ ...defaults, transport: 'stream' }, 60) === 'stream')
  check('显式 submit 覆盖 auto', chooseTransport({ ...defaults, transport: 'submit' }, 3) === 'submit')
  check('阈值可调', chooseTransport({ ...defaults, autoStreamMaxSeconds: 5 }, 8) === 'submit')
  const bogus = loadConfig({ transport: 'telepathy' })
  check('非法 transport 回落到 auto', bogus.transport === 'auto', String(bogus.transport))
}

// --- 9. 状态文件必须是实时的 -------------------------------------------------
// 这一条是被真实误判逼出来的：插件只在启动时写一次状态文件，用户在界面里切换识别器
// 之后文件就过期了，于是出现"看到 sensevoice-local、其实已经在用豆包"这种误判。
console.log('\n状态文件实时性')
{
  const { readFileSync } = await import('node:fs')
  const statusPath = join(home, 'voice-doubao.status.json')
  selectionNow = { providerId: 'doubao-polished', language: 'auto' }
  mount({ arkApiKey: 'ark-test-key' })
  await new Promise((resolve) => setImmediate(resolve))

  const first = JSON.parse(readFileSync(statusPath, 'utf8'))
  check('加载时写入了当前选中的识别器', first.selection?.providerId === 'doubao-polished', JSON.stringify(first.selection))
  check('状态文件记录了注册出的识别器', Array.isArray(first.providers) && first.providers.includes('doubao'), JSON.stringify(first.providers))

  // 模拟用户在「插件管理 → 语音输入 → 配置」里切换识别器
  check('测试桩已挂上 follow 观察者', typeof pushSelection === 'function')
  const push = pushSelection
  pushSelection = null
  push({ providers: [], selection: { providerId: 'sensevoice-local', language: 'auto' } })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const second = JSON.parse(readFileSync(statusPath, 'utf8'))
  check('切换识别器后状态文件跟着更新', second.selection?.providerId === 'sensevoice-local', JSON.stringify(second.selection))
  check('更新时不会丢掉插件信息', second.loaded === true && second.plugin === 'dsh-voice-doubao')
  selectionNow = { providerId: 'doubao', language: 'auto' }
}

// --- 10. 最近一次识别要留痕 --------------------------------------------------
// "刚才那句到底走没走豆包、顺稿有没有生效"——不能靠感觉，得能从文件读出来。
console.log('\n最近一次识别的留痕')
{
  const { readFileSync } = await import('node:fs')
  const statusPath = join(home, 'voice-doubao.status.json')
  const ark = createServer((request, response) => {
    request.on('data', () => void 0)
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '我想说一下，我们明天10点开会。' } }] }))
    })
  })
  await new Promise((resolve) => ark.listen(0, '127.0.0.1', resolve))
  const asr = await startMockSauc({ text: '嗯，那个，我想说一下，我们明天十点开会。' })
  mount({ endpoint: asr.url, arkEndpoint: `http://127.0.0.1:${ark.address().port}/chat` })

  const before = JSON.parse(readFileSync(statusPath, 'utf8'))
  check('还没识别过时没有 lastRun', before.lastRun === undefined, JSON.stringify(before.lastRun))

  const out = await providers.get('doubao-polished').transcribe({ audio: silentWave(2), language: 'auto' })
  await new Promise((resolve) => setImmediate(resolve))

  const after = JSON.parse(readFileSync(statusPath, 'utf8'))
  check('识别后写入了 lastRun', Boolean(after.lastRun?.at), JSON.stringify(after.lastRun))
  check('lastRun 记了是哪个识别器处理的', after.lastRun?.providerId === 'doubao-polished', String(after.lastRun?.providerId))
  check('lastRun 记了通道', after.lastRun?.transport === 'stream', String(after.lastRun?.transport))
  check('lastRun 记了顺稿是否生效', after.lastRun?.polished === true, String(after.lastRun?.polished))
  check('lastRun 记了音频时长', Math.abs(Number(after.lastRun?.audioSeconds) - 2) < 1e-6, String(after.lastRun?.audioSeconds))
  check('lastRun 记了字数', after.lastRun?.chars === out.text.length, `${after.lastRun?.chars} vs ${out.text.length}`)
  check('默认不把识别原文写进文件（保护隐私）', after.lastRun?.text === undefined, JSON.stringify(after.lastRun?.text))
  check('写入 lastRun 不会丢掉插件信息', after.loaded === true && after.plugin === 'dsh-voice-doubao')

  // 打开 logTranscripts 才记原文
  mount({ endpoint: asr.url, arkEndpoint: `http://127.0.0.1:${ark.address().port}/chat`, logTranscripts: true })
  await providers.get('doubao-polished').transcribe({ audio: silentWave(1), language: 'auto' })
  await new Promise((resolve) => setImmediate(resolve))
  const logged = JSON.parse(readFileSync(statusPath, 'utf8'))
  check('打开 logTranscripts 后才记原文', typeof logged.lastRun?.text === 'string' && logged.lastRun.text.length > 0, JSON.stringify(logged.lastRun?.text))

  await new Promise((resolve) => ark.close(resolve))
  await asr.close()
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`)
  process.exitCode = 1
}
process.exit(process.exitCode ?? 0)
