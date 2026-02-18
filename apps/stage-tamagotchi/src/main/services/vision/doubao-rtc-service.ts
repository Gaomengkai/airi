import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  VisionCaptureAndAskRequest,
  VisionCaptureResult,
  VisionErrorPayload,
  VisionLocalTtsStatePayload,
  VisionRTCConfig,
  VisionSessionState,
  VisionSubtitlePayload,
} from '@proj-airi/stage-shared/vision'

import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
import {
  visionCaptureAndAskInvokeEventa,
  visionErrorInvokeEventa,
  visionGetStateInvokeEventa,
  visionLocalTtsStateInvokeEventa,
  visionStartScreenShareInvokeEventa,
  visionStartSessionInvokeEventa,
  visionStateChangedInvokeEventa,
  visionStopScreenShareInvokeEventa,
  visionStopSessionInvokeEventa,
  visionSubtitleInvokeEventa,
  visionUpdateConfigInvokeEventa,
} from '@proj-airi/stage-shared/vision'
import { desktopCapturer, screen as electronScreen } from 'electron'

import { onAppBeforeQuit, onAppWindowAllClosed } from '../../libs/bootkit/lifecycle'

interface RTCRoomLike {
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  joinRoom?: (token: string, userInfo: { uid: string }, roomConfig: Record<string, unknown>) => unknown
  leaveRoom?: () => void
  destroy?: () => void
  publishScreen?: (type: number) => unknown
  unpublishScreen?: (type: number) => unknown
  sendUserBinaryMessage?: (userId: string, length: number, message: Uint8Array, config: number) => unknown
}

interface RTCVideoLike {
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  createRTCVideo?: (appId: string, params: string) => void
  createRTCRoom?: (roomId: string) => RTCRoomLike
  destroyRTCVideo?: () => void
  startAudioCapture?: () => void
  stopAudioCapture?: () => void
  getScreenCaptureSourceList?: () => unknown[]
  startScreenVideoCapture?: (source: unknown, captureParams: Record<string, unknown>) => number
  stopScreenVideoCapture?: () => void
}

interface RTCVideoCtor {
  new (): RTCVideoLike
}

interface ScreenSourceLike {
  source_id?: number
  source_name?: string
  type?: number
  primary_monitor?: boolean
}

const RTC_TOKEN_VERSION = '001'
const RTC_TOKEN_PRIVILEGES = {
  publishStream: 0,
  subscribeStream: 4,
} as const
const RTC_TOKEN_EXPIRES_IN_SECONDS = 24 * 3600
const MAX_SUBTITLE_HISTORY = 200

function defaultVisionConfig(): VisionRTCConfig {
  return {
    backend: 'doubao-rtc',
    appId: '',
    appKey: '',
    accessKeyId: '',
    secretAccessKey: '',
    baseUrl: 'https://rtc.volcengineapi.com',
    region: 'cn-north-1',
    modelName: 'doubao-seed-1-8-251228',
    maxTokens: 1024,
    temperature: 0.5,
    topP: 0.3,
    historyLength: 50,
    enableVision: true,
    visionStreamType: 1,
    visionImageDetail: 'high',
    visionHeight: 720,
    visionInterval: 500,
    visionImagesLimit: 5,
    useRemoteTTS: false,
    idleEnabled: false,
    idleTimeoutMs: 30000,
    idlePrompt: 'Please check the current screen and share a short useful update.',
    idleInterruptMode: 1,
    gptBaseUrl: 'https://api.openai.com/v1',
    gptApiKey: '',
    gptModel: 'gpt-4.1-mini',
    gptMaxTokens: 800,
    gptTemperature: 0.2,
    gptTopP: 1,
    gptHistoryLength: 12,
    gptImageHeight: 720,
  }
}

function createRuntimeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e5)}`
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readResultObject(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== 'object')
    return {}

  const result = (response as { Result?: unknown }).Result
  if (result && typeof result === 'object')
    return result as Record<string, unknown>

  return {}
}

function readRawResult(response: unknown): unknown {
  if (!response || typeof response !== 'object')
    return undefined

  return (response as { Result?: unknown }).Result
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  return 'Unknown error'
}

function maskCredential(value: string | undefined) {
  if (!value)
    return ''
  if (value.length <= 6)
    return `${value.slice(0, 1)}***${value.slice(-1)}`
  return `${value.slice(0, 3)}***${value.slice(-3)}`
}

function trimLongText(value: string, maxLength = 1200) {
  if (value.length <= maxLength)
    return value
  return `${value.slice(0, maxLength)}...<trimmed>`
}

function pickStringRecordKeys(value: unknown) {
  if (!value || typeof value !== 'object')
    return []
  return Object.keys(value as Record<string, unknown>)
}

function readResponseMetadata(responseObject: Record<string, unknown>) {
  const metadata = responseObject.ResponseMetadata
  return metadata && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : undefined
}

function writeUint16LE(value: number) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value, 0)
  return buf
}

function writeUint32LE(value: number) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function packBytes(bytes: Buffer) {
  return Buffer.concat([writeUint16LE(bytes.length), bytes])
}

function packString(value: string) {
  return packBytes(Buffer.from(value))
}

function packPrivilegeMap(privileges: Record<number, number>) {
  const entries = Object.entries(privileges)
    .map(([key, value]) => [Number(key), value] as const)
    .sort((a, b) => a[0] - b[0])

  const chunks: Buffer[] = [writeUint16LE(entries.length)]
  for (const [key, value] of entries) {
    chunks.push(writeUint16LE(key))
    chunks.push(writeUint32LE(value))
  }
  return Buffer.concat(chunks)
}

function createRtcJoinToken(params: {
  appId: string
  appKey: string
  roomId: string
  userId: string
}) {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expireAt = issuedAt + RTC_TOKEN_EXPIRES_IN_SECONDS
  const nonce = Math.floor(Math.random() * 4_294_967_295)

  const privileges: Record<number, number> = {
    [RTC_TOKEN_PRIVILEGES.publishStream]: 0,
    [RTC_TOKEN_PRIVILEGES.subscribeStream]: 0,
  }

  const message = Buffer.concat([
    writeUint32LE(nonce),
    writeUint32LE(issuedAt),
    writeUint32LE(expireAt),
    packString(params.roomId),
    packString(params.userId),
    packPrivilegeMap(privileges),
  ])

  const signature = createHmac('sha256', params.appKey).update(message).digest()
  const content = Buffer.concat([packBytes(message), packBytes(signature)])
  return `${RTC_TOKEN_VERSION}${params.appId}${content.toString('base64')}`
}

function readResponseError(metadata: Record<string, unknown> | undefined) {
  const maybeError = metadata?.Error
  return maybeError && typeof maybeError === 'object'
    ? maybeError as Record<string, unknown>
    : undefined
}

function debugLog(message: string, payload?: Record<string, unknown>) {
  console.info(`[vision][main] ${message}`, payload ?? {})
}

function sha256Hex(input: string) {
  return createHash('sha256').update(input).digest('hex')
}

function hmacSha256Hex(input: string, key: string | Buffer) {
  return createHmac('sha256', key).update(input).digest('hex')
}

function hmacSha256Buffer(input: string, key: string | Buffer) {
  return createHmac('sha256', key).update(input).digest()
}

function createBinaryControlMessage(controlMessage: Record<string, unknown>) {
  const encoder = new TextEncoder()
  const magic = encoder.encode('ctrl')
  const jsonString = JSON.stringify(controlMessage)
  const jsonBytes = encoder.encode(jsonString)
  const length = jsonBytes.length
  const lengthBytes = new Uint8Array([
    (length >> 24) & 0xFF,
    (length >> 16) & 0xFF,
    (length >> 8) & 0xFF,
    length & 0xFF,
  ])
  const output = new Uint8Array(8 + jsonBytes.length)
  output.set(magic, 0)
  output.set(lengthBytes, 4)
  output.set(jsonBytes, 8)
  return output
}

function splitBase64Image(base64Data: string, maxChunkSize = 50 * 1024) {
  const chunks: string[] = []
  for (let index = 0; index < base64Data.length; index += maxChunkSize) {
    chunks.push(base64Data.slice(index, index + maxChunkSize))
  }
  return chunks
}

function readSubtitlePayloadFromMessage(value: unknown): VisionSubtitlePayload | undefined {
  if (!value || typeof value !== 'object')
    return undefined

  const message = value as Record<string, unknown>
  const directText = readString(message.text)
  if (directText) {
    return {
      text: directText,
      isUser: message.isUser === true,
    }
  }

  const data = message.data
  if (!data || typeof data !== 'object')
    return undefined

  const nested = data as Record<string, unknown>
  const nestedText = readString(nested.text)
  if (!nestedText)
    return undefined

  return {
    text: nestedText,
    isUser: nested.isUser === true || message.isUser === true,
  }
}

function readUidFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim())
    return value

  if (!value || typeof value !== 'object')
    return undefined

  const record = value as Record<string, unknown>
  const directUid = readString(record.uid)
  if (directUid)
    return directUid

  const nestedKey = record.key
  if (!nestedKey || typeof nestedKey !== 'object')
    return undefined

  return readString((nestedKey as Record<string, unknown>).uid)
}

function normalizeIdleTimeoutMs(value: unknown) {
  const timeoutMs = Number(value)
  if (!Number.isFinite(timeoutMs))
    return 30000
  return Math.max(1000, Math.floor(timeoutMs))
}

function normalizeInterruptMode(value: unknown) {
  const mode = Number(value)
  if (!Number.isFinite(mode))
    return 1
  return Math.max(0, Math.floor(mode))
}

function normalizeHistoryLength(value: unknown) {
  const length = Number(value)
  if (!Number.isFinite(length))
    return 12
  return Math.max(0, Math.floor(length))
}

function normalizeBackend(value: unknown): VisionRTCConfig['backend'] {
  return value === 'gpt-http' ? 'gpt-http' : 'doubao-rtc'
}

function normalizeGptImageHeight(value: unknown) {
  const height = Number(value)
  if (!Number.isFinite(height))
    return 720
  return Math.min(720, Math.max(1, Math.floor(height)))
}

function normalizeGptBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function buildGptChatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = normalizeGptBaseUrl(baseUrl)
  if (normalizedBaseUrl.endsWith('/chat/completions'))
    return normalizedBaseUrl
  return `${normalizedBaseUrl}/chat/completions`
}

function readTextFromUnknownContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim())
    return content.trim()

  if (!Array.isArray(content))
    return undefined

  const textParts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object')
      continue

    const text = readString((item as Record<string, unknown>).text)
    if (text)
      textParts.push(text)
  }

  if (textParts.length === 0)
    return undefined
  return textParts.join('\n').trim()
}

function readAssistantTextFromGptResponse(response: unknown): string | undefined {
  if (!response || typeof response !== 'object')
    return undefined

  const record = response as Record<string, unknown>
  const choices = record.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0]
    if (first && typeof first === 'object') {
      const message = (first as Record<string, unknown>).message
      if (message && typeof message === 'object') {
        const content = readTextFromUnknownContent((message as Record<string, unknown>).content)
        if (content)
          return content
      }
    }
  }

  const outputText = readString(record.output_text)
  if (outputText)
    return outputText

  return undefined
}

export function createVisionService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const require = createRequire(import.meta.url)
  const emitStateChanged = defineInvoke(params.context, visionStateChangedInvokeEventa)
  const emitSubtitleChanged = defineInvoke(params.context, visionSubtitleInvokeEventa)
  const emitErrorChanged = defineInvoke(params.context, visionErrorInvokeEventa)

  let currentConfig = defaultVisionConfig()
  let rtcVideo: RTCVideoLike | undefined
  let rtcRoom: RTCRoomLike | undefined
  let roomId = ''
  let userId = ''
  let taskId = ''
  let botUserId = ''
  let imageGroupId = 0
  const subtitleHistory: VisionSubtitlePayload[] = []
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleTriggerInFlight = false
  let idleTriggerPending = false
  let isRemoteAudioSpeaking = false
  let isLocalTtsSpeaking = false

  const state: VisionSessionState = {
    isConnected: false,
    isScreenSharing: false,
  }

  function getStateSnapshot(): VisionSessionState {
    return {
      ...state,
      roomId: roomId || undefined,
      userId: userId || undefined,
      taskId: taskId || undefined,
      botUserId: botUserId || undefined,
    }
  }

  function emitSafely<T>(emitFn: (payload: T) => Promise<unknown>, payload: T) {
    void emitFn(payload).catch(() => {
      // Ignore emit errors to avoid interrupting session lifecycle.
    })
  }

  function emitState() {
    emitSafely(emitStateChanged, getStateSnapshot())
  }

  function pushSubtitleHistory(payload: VisionSubtitlePayload) {
    subtitleHistory.push(payload)
    while (subtitleHistory.length > MAX_SUBTITLE_HISTORY) {
      subtitleHistory.shift()
    }
  }

  function clearSubtitleHistory() {
    subtitleHistory.length = 0
  }

  function getRecentSubtitleHistory(limit: number) {
    if (limit <= 0)
      return []
    return subtitleHistory.slice(-limit)
  }

  function emitSubtitle(payload: VisionSubtitlePayload) {
    pushSubtitleHistory(payload)
    emitSafely(emitSubtitleChanged, payload)
  }

  function emitError(error: unknown, code?: string | number) {
    const payload: VisionErrorPayload = {
      message: getErrorMessage(error),
      code,
    }
    state.lastError = payload.message
    emitSafely(emitErrorChanged, payload)
    emitState()
  }

  function clearIdleTimer(reason: string) {
    if (!idleTimer)
      return

    clearTimeout(idleTimer)
    idleTimer = undefined
    debugLog('Idle timer cleared', { reason })
  }

  function scheduleIdleTimer(reason: string) {
    if (!state.isConnected || !currentConfig.idleEnabled) {
      clearIdleTimer(`skip-schedule:${reason}`)
      return
    }

    clearIdleTimer(`reschedule:${reason}`)
    const timeoutMs = normalizeIdleTimeoutMs(currentConfig.idleTimeoutMs)
    idleTimer = setTimeout(() => {
      void triggerIdlePrompt('timeout')
    }, timeoutMs)

    debugLog('Idle timer scheduled', {
      reason,
      timeoutMs,
      interruptMode: normalizeInterruptMode(currentConfig.idleInterruptMode),
    })
  }

  function markUserActivity(reason: string) {
    if (!state.isConnected || !currentConfig.idleEnabled)
      return

    debugLog('Idle activity detected', { reason })
    idleTriggerPending = false
    scheduleIdleTimer(`activity:${reason}`)
  }

  function isAssistantSpeaking() {
    if (normalizeBackend(currentConfig.backend) === 'gpt-http')
      return isLocalTtsSpeaking

    return currentConfig.useRemoteTTS
      ? isRemoteAudioSpeaking
      : isLocalTtsSpeaking
  }

  function setAssistantSpeechState(params: {
    source: 'remote-rtc' | 'local-tts'
    isSpeaking: boolean
    reason: string
  }) {
    if (params.source === 'remote-rtc') {
      isRemoteAudioSpeaking = params.isSpeaking
    }
    else {
      isLocalTtsSpeaking = params.isSpeaking
    }

    debugLog('Assistant speech state updated', {
      source: params.source,
      isSpeaking: params.isSpeaking,
      reason: params.reason,
      useRemoteTTS: currentConfig.useRemoteTTS,
      isRemoteAudioSpeaking,
      isLocalTtsSpeaking,
      idleTriggerPending,
    })

    if (!params.isSpeaking && idleTriggerPending && state.isConnected && currentConfig.idleEnabled && !idleTriggerInFlight) {
      idleTriggerPending = false
      void triggerIdlePrompt(`speech-finished:${params.source}:${params.reason}`)
    }
  }

  function assertConfig(config: VisionRTCConfig) {
    if (normalizeBackend(config.backend) === 'gpt-http') {
      if (!config.gptBaseUrl)
        throw new Error('Vision config `gptBaseUrl` is required when backend is `gpt-http`')
      if (!config.gptApiKey)
        throw new Error('Vision config `gptApiKey` is required when backend is `gpt-http`')
      if (!config.gptModel)
        throw new Error('Vision config `gptModel` is required when backend is `gpt-http`')
      return
    }

    if (!config.appId)
      throw new Error('Vision config `appId` is required')
    if (!config.appKey)
      throw new Error('Vision config `appKey` is required')
    if (!config.accessKeyId)
      throw new Error('Vision config `accessKeyId` is required')
    if (!config.secretAccessKey)
      throw new Error('Vision config `secretAccessKey` is required')
    if (!config.modelName)
      throw new Error('Vision config `modelName` is required')
  }

  function loadRTCVideoCtor(): RTCVideoCtor {
    const sdkPackage = '@volcengine/vertc-electron-sdk'
    let mod: { RTCVideo?: unknown }
    try {
      mod = require(sdkPackage) as { RTCVideo?: unknown }
    }
    catch (error) {
      const message = getErrorMessage(error)
      if (message.includes('Cannot find module')) {
        throw new Error('`@volcengine/vertc-electron-sdk` is not installed. Run `pnpm -F @proj-airi/stage-tamagotchi add @volcengine/vertc-electron-sdk` and restart.')
      }

      if (message.includes('NODE_MODULE_VERSION')) {
        throw new Error('`@volcengine/vertc-electron-sdk` binary ABI mismatched with current Electron runtime. Run `pnpm -F @proj-airi/stage-tamagotchi rebuild @volcengine/vertc-electron-sdk` and restart.')
      }

      throw error
    }

    if (typeof mod.RTCVideo !== 'function') {
      throw new TypeError('`@volcengine/vertc-electron-sdk` is installed but RTCVideo export is invalid')
    }
    return mod.RTCVideo as RTCVideoCtor
  }

  function setupRTCVideoEventHandlers() {
    if (!rtcVideo?.on)
      return

    rtcVideo.on('onError', (errorCode: unknown) => {
      emitError(`RTC video error: ${String(errorCode)}`, String(errorCode))
    })
  }

  function setupRTCRoomEventHandlers() {
    if (!rtcRoom?.on)
      return

    rtcRoom.on('onConnectionStateChanged', (nextState: unknown, reason: unknown) => {
      const disconnectedByState = String(nextState) === '3'
      if (disconnectedByState) {
        clearIdleTimer('rtc-disconnected')
        idleTriggerPending = false
        isRemoteAudioSpeaking = false
        isLocalTtsSpeaking = false
        state.isConnected = false
        state.isScreenSharing = false
        state.lastError = `RTC disconnected: ${String(reason)}`
        emitState()
      }
    })

    rtcRoom.on('onError', (errorCode: unknown, errorMessage: unknown) => {
      emitError(`RTC room error: ${String(errorMessage ?? errorCode)}`, String(errorCode))
    })

    rtcRoom.on('onFirstRemoteAudioFrame', (...args: unknown[]) => {
      const uid = args
        .map(arg => readUidFromUnknown(arg))
        .find(candidate => !!candidate)

      debugLog('RTC first remote audio frame', {
        uid,
        botUserId,
        argTypes: args.map(arg => typeof arg),
      })

      if (uid && botUserId && uid !== botUserId)
        return

      setAssistantSpeechState({
        source: 'remote-rtc',
        isSpeaking: true,
        reason: 'first-remote-audio-frame',
      })
    })

    rtcRoom.on('onRemoteAudioStateChanged', (...args: unknown[]) => {
      const uid = args
        .map(arg => readUidFromUnknown(arg))
        .find(candidate => !!candidate)
      const numericArgs = args.filter((arg): arg is number => typeof arg === 'number')
      const stateCode = numericArgs[0]

      debugLog('RTC remote audio state changed', {
        uid,
        stateCode,
        numericArgs,
        argTypes: args.map(arg => typeof arg),
      })

      if (uid && botUserId && uid !== botUserId)
        return

      if (stateCode === 0) {
        setAssistantSpeechState({
          source: 'remote-rtc',
          isSpeaking: false,
          reason: 'remote-audio-state-0',
        })
      }
    })

    rtcRoom.on('onRoomMessageReceived', (...args: unknown[]) => {
      const stringCandidates = args
        .filter((arg): arg is string => typeof arg === 'string' && arg.trim().length > 0)

      debugLog('RTC room message received', {
        argCount: args.length,
        argTypes: args.map(arg => typeof arg),
        stringCandidateCount: stringCandidates.length,
        stringCandidatesPreview: stringCandidates.map(candidate => trimLongText(candidate, 160)),
      })

      for (const candidate of stringCandidates) {
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>
          const subtitle = readSubtitlePayloadFromMessage(parsed)
          if (!subtitle)
            continue

          debugLog('RTC subtitle payload parsed', {
            isUser: subtitle.isUser,
            textPreview: trimLongText(subtitle.text, 200),
          })

          if (subtitle.isUser) {
            markUserActivity('user-subtitle')
          }

          emitSubtitle(subtitle)
          return
        }
        catch {
          debugLog('RTC room message candidate is not JSON', {
            candidatePreview: trimLongText(candidate, 160),
          })
        }
      }

      debugLog('RTC room message contained no subtitle payload', {})
    })
  }

  function pickScreenSource(sourceList: unknown[]) {
    const typedSources = sourceList as ScreenSourceLike[]
    return typedSources.find(source => source.type === 2 && source.primary_monitor)
      || typedSources.find(source => source.type === 2 && source.source_id !== -1)
      || typedSources.find(source => source.type === 2)
      || typedSources[0]
  }

  async function callVolcengineAPI(action: string, body: Record<string, unknown>) {
    const method = 'POST'
    const baseUrl = new URL(currentConfig.baseUrl)
    const host = baseUrl.host
    const path = baseUrl.pathname && baseUrl.pathname !== '/'
      ? baseUrl.pathname.replace(/\/+$/, '')
      : '/'
    const query = `Action=${action}&Version=2025-06-01`
    const bodyString = JSON.stringify(body)

    const now = new Date()
    const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const shortDate = xDate.slice(0, 8)

    const contentSha256 = sha256Hex(bodyString)
    const signedHeaders = 'content-type;host;x-content-sha256;x-date'
    const credentialScope = `${shortDate}/${currentConfig.region}/rtc/request`

    const canonicalHeaders = [
      'content-type:application/json',
      `host:${host}`,
      `x-content-sha256:${contentSha256}`,
      `x-date:${xDate}`,
      '',
    ].join('\n')

    const canonicalRequest = [
      method,
      path,
      query,
      canonicalHeaders,
      signedHeaders,
      contentSha256,
    ].join('\n')

    const canonicalRequestHash = sha256Hex(canonicalRequest)
    const stringToSign = [
      'HMAC-SHA256',
      xDate,
      credentialScope,
      canonicalRequestHash,
    ].join('\n')

    const kDate = hmacSha256Buffer(shortDate, currentConfig.secretAccessKey)
    const kRegion = hmacSha256Buffer(currentConfig.region, kDate)
    const kService = hmacSha256Buffer('rtc', kRegion)
    const kSigning = hmacSha256Buffer('request', kService)
    const signature = hmacSha256Hex(stringToSign, kSigning)

    const authorization = `HMAC-SHA256 Credential=${currentConfig.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    const requestUrl = new URL(path, baseUrl.origin)
    requestUrl.search = query
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    debugLog('Calling Volcengine API', {
      action,
      url: requestUrl.toString(),
      region: currentConfig.region,
      appId: maskCredential(currentConfig.appId),
      accessKeyId: maskCredential(currentConfig.accessKeyId),
      bodyKeys: pickStringRecordKeys(body),
    })

    try {
      const response = await fetch(requestUrl.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Host': host,
          'X-Date': xDate,
          'X-Content-Sha256': contentSha256,
          'Authorization': authorization,
        },
        body: bodyString,
        signal: controller.signal,
      })

      const responseText = await response.text()
      let data: unknown = {}
      if (responseText) {
        try {
          data = JSON.parse(responseText)
        }
        catch {
          throw new Error(`Volcengine API returned non-JSON response (${response.status})`)
        }
      }

      const responseObject = (data && typeof data === 'object') ? data as Record<string, unknown> : {}
      const metadata = readResponseMetadata(responseObject)
      const responseError = readResponseError(metadata)

      debugLog('Volcengine API response received', {
        action,
        status: response.status,
        ok: response.ok,
        responseKeys: pickStringRecordKeys(responseObject),
        metadataKeys: pickStringRecordKeys(metadata),
        hasErrorField: !!responseError,
      })

      if (!response.ok) {
        const defaultMessage = `Volcengine API request failed with status ${response.status}`
        debugLog('Volcengine API non-OK response', {
          action,
          status: response.status,
          metadata,
          responseText: trimLongText(responseText),
        })

        if (responseError) {
          const msg = readString((responseError as { Message?: unknown }).Message)
          throw new Error(msg || defaultMessage)
        }
        throw new Error(defaultMessage)
      }

      if (responseError) {
        debugLog('Volcengine API logical error in metadata', {
          action,
          metadata,
          responseText: trimLongText(responseText),
        })
        const msg = readString((responseError as { Message?: unknown }).Message) || 'Unknown Volcengine API error'
        throw new Error(msg)
      }

      return responseObject
    }
    finally {
      clearTimeout(timeout)
    }
  }

  async function callGptChatCompletionsAPI(payload: Record<string, unknown>) {
    const requestUrl = buildGptChatCompletionsUrl(currentConfig.gptBaseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    debugLog('Calling GPT chat completions API', {
      url: requestUrl,
      model: currentConfig.gptModel,
      backend: normalizeBackend(currentConfig.backend),
      historyLength: normalizeHistoryLength(currentConfig.gptHistoryLength),
      payloadKeys: pickStringRecordKeys(payload),
    })

    try {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentConfig.gptApiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })

      const responseText = await response.text()
      let data: unknown = {}
      if (responseText) {
        try {
          data = JSON.parse(responseText)
        }
        catch {
          throw new Error(`GPT API returned non-JSON response (${response.status})`)
        }
      }

      debugLog('GPT chat completions response received', {
        status: response.status,
        ok: response.ok,
        responseKeys: pickStringRecordKeys(data),
      })

      if (!response.ok) {
        const responseObject = data as Record<string, unknown>
        const errorObject = responseObject?.error as Record<string, unknown> | undefined
        const errorMessage = readString(errorObject?.message)
          || `GPT API request failed with status ${response.status}`
        throw new Error(errorMessage)
      }

      return data
    }
    finally {
      clearTimeout(timeout)
    }
  }

  async function capturePrimaryDisplayBase64() {
    const targetHeight = normalizeGptImageHeight(currentConfig.gptImageHeight)
    const primarySize = electronScreen.getPrimaryDisplay().size
    const targetWidth = Math.max(1, Math.floor((primarySize.width * targetHeight) / Math.max(1, primarySize.height)))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight,
      },
    })

    if (!sources.length) {
      throw new Error('No desktop capture source is available for GPT idle vision request')
    }

    const source = sources[0]
    const imageBase64 = source.thumbnail?.toDataURL()
    if (!imageBase64 || imageBase64 === 'data:image/png;base64,') {
      throw new Error('Failed to capture desktop thumbnail for GPT idle vision request')
    }

    return imageBase64
  }

  async function requestGptVision(imageBase64: string, prompt: string) {
    const promptText = prompt.trim() || 'Please describe what you see on this screen.'
    const historyLimit = normalizeHistoryLength(currentConfig.gptHistoryLength)
    const historyMessages = getRecentSubtitleHistory(historyLimit)
      .filter(item => item.text.trim().length > 0)
      .map(item => ({
        role: item.isUser ? 'user' : 'assistant',
        content: item.text,
      }))

    const payload = {
      model: currentConfig.gptModel,
      temperature: currentConfig.gptTemperature,
      top_p: currentConfig.gptTopP,
      max_tokens: currentConfig.gptMaxTokens,
      messages: [
        {
          role: 'system',
          content: 'You are a desktop visual assistant. Analyze the screenshot and provide concise, practical guidance.',
        },
        ...historyMessages,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText,
            },
            {
              type: 'image_url',
              image_url: {
                url: imageBase64,
              },
            },
          ],
        },
      ],
    } satisfies Record<string, unknown>

    const response = await callGptChatCompletionsAPI(payload)
    const assistantText = readAssistantTextFromGptResponse(response)
    if (!assistantText) {
      throw new Error('GPT vision request succeeded but no assistant text was returned')
    }

    return {
      promptText,
      assistantText,
    }
  }

  async function sendBinaryMessageToAI(message: Uint8Array) {
    if (!rtcRoom?.sendUserBinaryMessage || !botUserId) {
      throw new Error('RTC room is not ready for binary message sending')
    }

    const sendResult = rtcRoom.sendUserBinaryMessage(botUserId, message.byteLength, message, 0)
    if (sendResult instanceof Promise) {
      const resolved = await sendResult
      if (typeof resolved === 'number')
        return resolved >= 0
      if (typeof resolved === 'boolean')
        return resolved
      return true
    }

    if (typeof sendResult === 'number')
      return sendResult >= 0
    if (typeof sendResult === 'boolean')
      return sendResult

    return true
  }

  function getNextImageGroupId() {
    imageGroupId += 1
    return imageGroupId
  }

  async function sendTextToAI(message: string, interruptMode = 1) {
    if (!state.isConnected)
      throw new Error('Vision session is not connected')

    const trimmedMessage = message.trim()
    if (!trimmedMessage)
      throw new Error('Message is empty')

    const controlMessage = {
      Command: 'ExternalTextToLLM',
      Message: trimmedMessage,
      InterruptMode: interruptMode,
    }

    const binary = createBinaryControlMessage(controlMessage)
    return sendBinaryMessageToAI(binary)
  }

  async function triggerIdlePrompt(reason: string) {
    if (!state.isConnected || !currentConfig.idleEnabled) {
      clearIdleTimer(`skip-trigger:${reason}`)
      idleTriggerPending = false
      return
    }

    if (idleTriggerInFlight) {
      debugLog('Idle trigger skipped (already in flight)', { reason })
      scheduleIdleTimer('skip-inflight')
      return
    }

    if (isAssistantSpeaking()) {
      idleTriggerPending = true
      debugLog('Idle trigger deferred while assistant is speaking', {
        reason,
        useRemoteTTS: currentConfig.useRemoteTTS,
        isRemoteAudioSpeaking,
        isLocalTtsSpeaking,
      })
      return
    }

    idleTriggerPending = false

    const prompt = currentConfig.idlePrompt.trim()
    if (!prompt) {
      debugLog('Idle trigger skipped (empty idle prompt)', {})
      scheduleIdleTimer('skip-empty-prompt')
      return
    }

    idleTriggerInFlight = true
    const interruptMode = normalizeInterruptMode(currentConfig.idleInterruptMode)
    debugLog('Idle trigger fired', {
      reason,
      interruptMode,
      promptPreview: trimLongText(prompt, 200),
    })

    try {
      if (normalizeBackend(currentConfig.backend) === 'gpt-http') {
        const imageBase64 = await capturePrimaryDisplayBase64()
        const completion = await requestGptVision(imageBase64, prompt)
        emitSubtitle({
          text: completion.promptText,
          isUser: true,
        })
        emitSubtitle({
          text: completion.assistantText,
          isUser: false,
        })
        debugLog('Idle trigger GPT request completed', {
          assistantTextPreview: trimLongText(completion.assistantText, 240),
        })
      }
      else {
        const sent = await sendTextToAI(prompt, interruptMode)
        debugLog('Idle trigger send result', { sent })
      }
    }
    catch (error) {
      debugLog('Idle trigger failed', { reason, error: getErrorMessage(error) })
      emitError(error)
    }
    finally {
      idleTriggerInFlight = false
      scheduleIdleTimer('trigger-finished')
    }
  }

  async function sendImageToAI(base64Data: string, prompt: string, interruptMode = 1): Promise<VisionCaptureResult> {
    if (!state.isConnected)
      throw new Error('Vision session is not connected')

    markUserActivity('manual-capture')
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '')
    const chunks = splitBase64Image(cleanBase64)
    const groupId = getNextImageGroupId()

    for (let index = 0; index < chunks.length; index += 1) {
      const isLastChunk = index === chunks.length - 1
      const controlMessage = {
        Command: 'ExternalTextToLLM',
        Message: isLastChunk ? prompt : '',
        InterruptMode: interruptMode,
        ImageConfig: {
          Action: 'insert',
          GroupID: groupId,
          ImageType: 'base64',
          Images: [chunks[index]],
          Total: chunks.length,
          ImageID: 1,
          IsPartial: !isLastChunk,
          FragmentID: index + 1,
        },
      }

      const binary = createBinaryControlMessage(controlMessage)
      const sent = await sendBinaryMessageToAI(binary)
      if (!sent) {
        return {
          success: false,
          groupId,
        }
      }

      if (!isLastChunk) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }

    return {
      success: true,
      groupId,
    }
  }

  async function sendImageToGpt(base64Data: string, prompt: string): Promise<VisionCaptureResult> {
    if (!state.isConnected) {
      throw new Error('Vision session is not connected')
    }

    markUserActivity('manual-capture')
    const completion = await requestGptVision(base64Data, prompt)
    const groupId = getNextImageGroupId()

    emitSubtitle({
      text: completion.promptText,
      isUser: true,
    })
    emitSubtitle({
      text: completion.assistantText,
      isUser: false,
    })

    return {
      success: true,
      groupId,
    }
  }

  async function startScreenShareInternal() {
    if (normalizeBackend(currentConfig.backend) === 'gpt-http') {
      throw new Error('GPT HTTP backend does not support RTC screen sharing')
    }

    if (!rtcVideo || !rtcRoom)
      throw new Error('RTC is not initialized')

    if (state.isScreenSharing)
      return true

    const sourceList = rtcVideo.getScreenCaptureSourceList?.() ?? []
    if (!Array.isArray(sourceList) || sourceList.length === 0)
      throw new Error('No available screen capture source from RTC SDK')

    const source = pickScreenSource(sourceList)
    if (!source)
      throw new Error('No usable screen source was found')

    const ret = rtcVideo.startScreenVideoCapture?.(source, {
      region_rect: { x: 0, y: 0, width: 0, height: 0 },
      capture_mouse_cursor: 1,
      filter_config: [],
      highlight_config: {
        enable_highlight: false,
        border_color: 0,
        border_width: 0,
      },
    })

    if (typeof ret === 'number' && ret !== 0)
      throw new Error(`startScreenVideoCapture failed with code ${ret}`)

    rtcRoom.publishScreen?.(2)
    state.isScreenSharing = true
    emitState()
    return true
  }

  async function stopScreenShareInternal() {
    if (normalizeBackend(currentConfig.backend) === 'gpt-http') {
      throw new Error('GPT HTTP backend does not support RTC screen sharing')
    }

    if (!rtcVideo || !rtcRoom) {
      state.isScreenSharing = false
      emitState()
      return true
    }

    rtcRoom.unpublishScreen?.(2)
    rtcVideo.stopScreenVideoCapture?.()
    state.isScreenSharing = false
    emitState()
    return true
  }

  async function startSessionInternal() {
    assertConfig(currentConfig)
    if (state.isConnected)
      return getStateSnapshot()

    idleTriggerPending = false
    isRemoteAudioSpeaking = false
    isLocalTtsSpeaking = false
    clearSubtitleHistory()

    if (normalizeBackend(currentConfig.backend) === 'gpt-http') {
      roomId = ''
      userId = ''
      taskId = ''
      botUserId = ''
      state.isConnected = true
      state.isScreenSharing = false
      state.lastError = undefined
      emitState()
      scheduleIdleTimer('session-started-gpt-http')
      debugLog('Started GPT HTTP vision session', {
        backend: normalizeBackend(currentConfig.backend),
        model: currentConfig.gptModel,
        baseUrl: currentConfig.gptBaseUrl,
        historyLength: normalizeHistoryLength(currentConfig.gptHistoryLength),
        imageHeight: normalizeGptImageHeight(currentConfig.gptImageHeight),
      })
      return getStateSnapshot()
    }

    debugLog('Starting vision session', {
      backend: normalizeBackend(currentConfig.backend),
      appId: maskCredential(currentConfig.appId),
      accessKeyId: maskCredential(currentConfig.accessKeyId),
      region: currentConfig.region,
      baseUrl: currentConfig.baseUrl,
      modelName: currentConfig.modelName,
      enableVision: currentConfig.enableVision,
      visionStreamType: currentConfig.visionStreamType,
      visionImageDetail: currentConfig.visionImageDetail,
      visionHeight: currentConfig.visionHeight,
      visionInterval: currentConfig.visionInterval,
      visionImagesLimit: currentConfig.visionImagesLimit,
      useRemoteTTS: currentConfig.useRemoteTTS,
      idleEnabled: currentConfig.idleEnabled,
      idleTimeoutMs: normalizeIdleTimeoutMs(currentConfig.idleTimeoutMs),
      idleInterruptMode: normalizeInterruptMode(currentConfig.idleInterruptMode),
      rtsSubtitleEnabled: true,
    })

    const RTCVideoClass = loadRTCVideoCtor()
    const nextRoomId = createRuntimeId('room')
    const nextUserId = createRuntimeId('user')
    const nextTaskId = createRuntimeId('task')
    const nextBotUserId = createRuntimeId('bot')

    rtcVideo = new RTCVideoClass()
    rtcVideo.createRTCVideo?.(currentConfig.appId, JSON.stringify(''))
    setupRTCVideoEventHandlers()

    const startPayload: Record<string, unknown> = {
      AppId: currentConfig.appId,
      RoomId: nextRoomId,
      TaskId: nextTaskId,
      Config: {
        ASRConfig: {
          Provider: 'volcano',
          ProviderParams: {
            Mode: 'bigmodel',
            StreamMode: 2,
            VolcanoASRParameters: '{"request":{"enable_nonstream":true}}',
            Credential: { ApiResourceId: 'volc.seedasr.sauc.duration' },
          },
          VADConfig: {},
          InterruptConfig: {},
        },
        LLMConfig: {
          Mode: 'ArkV3',
          EndPointId: '',
          ModelName: currentConfig.modelName,
          MaxTokens: currentConfig.maxTokens,
          Temperature: currentConfig.temperature,
          TopP: currentConfig.topP,
          SystemMessages: [],
          HistoryLength: currentConfig.historyLength,
          ThinkingType: 'disabled',
          VisionConfig: {
            Enable: currentConfig.enableVision,
            SnapshotConfig: currentConfig.enableVision
              ? {
                  StreamType: currentConfig.visionStreamType,
                  ImageDetail: currentConfig.visionImageDetail,
                  Height: currentConfig.visionHeight,
                  Interval: currentConfig.visionInterval,
                  ImagesLimit: currentConfig.visionImagesLimit,
                }
              : undefined,
          },
        },
        TTSConfig: {
          Provider: 'volcano_bidirection',
          ProviderParams: {
            Credential: { ResourceId: 'seed-tts-1.0' },
            VolcanoTTSParameters: JSON.stringify({
              req_params: {
                speaker: 'ICL_zh_female_keainvsheng_tob',
                audio_params: { speech_rate: 0 },
              },
            }),
          },
          IgnoreBracketText: [1, 2, 3, 4],
        },
        SubtitleConfig: { DisableRTSSubtitle: false },
        InterruptMode: 0,
      },
      AgentConfig: {
        TargetUserId: [nextUserId],
        UserId: nextBotUserId,
        WelcomeMessage: '',
        Burst: { Enable: false, BufferSize: 0, Interval: 0 },
      },
    }

    const response = await callVolcengineAPI('StartVoiceChat', startPayload)
    const result = readResultObject(response)
    const rawResult = readRawResult(response)
    let token = readString(result.Token)
    let tokenSource: 'server' | 'local-generated' = 'server'

    taskId = readString(result.TaskId) ?? nextTaskId
    botUserId = readString(result.BotUserId) ?? nextBotUserId

    debugLog('StartVoiceChat response parsed', {
      rawResultType: typeof rawResult,
      rawResult,
      resultKeys: pickStringRecordKeys(result),
      hasToken: !!token,
      taskId,
      botUserId,
      responseMetadata: readResponseMetadata(response),
    })

    if (!token) {
      debugLog('StartVoiceChat missing join token, generating local RTC token fallback', {
        response,
        roomId: nextRoomId,
        userId: nextUserId,
      })

      token = createRtcJoinToken({
        appId: currentConfig.appId,
        appKey: currentConfig.appKey,
        roomId: nextRoomId,
        userId: nextUserId,
      })
      tokenSource = 'local-generated'
    }

    roomId = nextRoomId
    userId = nextUserId

    debugLog('Using RTC join token', {
      tokenSource,
      tokenLength: token.length,
      roomId,
      userId,
      taskId,
      botUserId,
    })

    rtcRoom = rtcVideo.createRTCRoom?.(roomId)
    if (!rtcRoom?.joinRoom) {
      throw new Error('RTC room initialization failed')
    }

    setupRTCRoomEventHandlers()

    const joinResult = rtcRoom.joinRoom(token, { uid: userId }, {
      room_profile_type: 1,
      is_auto_publish: true,
      is_auto_subscribe_audio: currentConfig.useRemoteTTS,
      is_auto_subscribe_video: false,
    })
    if (typeof joinResult === 'number' && joinResult < 0) {
      throw new Error(`joinRoom failed with code ${joinResult}`)
    }

    debugLog('RTC room joined', {
      roomId,
      userId,
      autoSubscribeAudio: currentConfig.useRemoteTTS,
    })

    rtcVideo.startAudioCapture?.()

    state.isConnected = true
    state.lastError = undefined
    emitState()
    scheduleIdleTimer('session-started')

    if (currentConfig.enableVision) {
      await startScreenShareInternal()
    }

    return getStateSnapshot()
  }

  async function stopSessionInternal() {
    clearIdleTimer('session-stop-requested')
    idleTriggerInFlight = false
    idleTriggerPending = false
    isRemoteAudioSpeaking = false
    isLocalTtsSpeaking = false
    clearSubtitleHistory()

    if (!state.isConnected && !rtcVideo) {
      return getStateSnapshot()
    }

    try {
      await stopScreenShareInternal()
    }
    catch {
      // Continue cleanup even if screen share stopping failed.
    }

    try {
      rtcVideo?.stopAudioCapture?.()
    }
    catch {
      // Ignore and continue cleanup.
    }

    if (taskId && roomId) {
      try {
        await callVolcengineAPI('StopVoiceChat', {
          AppId: currentConfig.appId,
          RoomId: roomId,
          TaskId: taskId,
        })
      }
      catch {
        // Ignore API stop errors, local cleanup still proceeds.
      }
    }

    try {
      rtcRoom?.leaveRoom?.()
      rtcRoom?.destroy?.()
    }
    catch {
      // Ignore and continue cleanup.
    }

    try {
      rtcVideo?.destroyRTCVideo?.()
    }
    catch {
      // Ignore and continue cleanup.
    }

    rtcRoom = undefined
    rtcVideo = undefined
    roomId = ''
    userId = ''
    taskId = ''
    botUserId = ''
    state.isConnected = false
    state.isScreenSharing = false
    emitState()
    return getStateSnapshot()
  }

  defineInvokeHandler(params.context, visionGetStateInvokeEventa, async () => getStateSnapshot())

  defineInvokeHandler(params.context, visionLocalTtsStateInvokeEventa, async (payload: VisionLocalTtsStatePayload) => {
    setAssistantSpeechState({
      source: 'local-tts',
      isSpeaking: payload.isSpeaking === true,
      reason: payload.reason ?? 'renderer-notify',
    })
  })

  defineInvokeHandler(params.context, visionUpdateConfigInvokeEventa, async (partialConfig) => {
    const prevBackend = normalizeBackend(currentConfig.backend)
    const prevUseRemoteTTS = currentConfig.useRemoteTTS
    currentConfig = {
      ...currentConfig,
      ...partialConfig,
      backend: normalizeBackend(partialConfig?.backend ?? currentConfig.backend),
    }

    const nextBackend = normalizeBackend(currentConfig.backend)
    if (state.isConnected && prevBackend !== nextBackend) {
      debugLog('Vision backend changed during active session; reconnect is required to apply backend switch', {
        previous: prevBackend,
        next: nextBackend,
      })
    }

    if (state.isConnected && prevUseRemoteTTS !== currentConfig.useRemoteTTS) {
      debugLog('useRemoteTTS changed during active session; reconnect is required to apply audio subscription', {
        previous: prevUseRemoteTTS,
        next: currentConfig.useRemoteTTS,
      })
    }

    if (state.isConnected) {
      if (currentConfig.idleEnabled) {
        scheduleIdleTimer('config-updated')
        if (idleTriggerPending && !isAssistantSpeaking() && !idleTriggerInFlight) {
          idleTriggerPending = false
          void triggerIdlePrompt('config-updated-pending-drain')
        }
      }
      else {
        idleTriggerPending = false
        clearIdleTimer('idle-disabled-via-config')
      }
    }

    return getStateSnapshot()
  })

  defineInvokeHandler(params.context, visionStartSessionInvokeEventa, async (config) => {
    currentConfig = {
      ...currentConfig,
      ...config,
      backend: normalizeBackend(config?.backend ?? currentConfig.backend),
    }

    try {
      return await startSessionInternal()
    }
    catch (error) {
      emitError(error)
      throw error
    }
  })

  defineInvokeHandler(params.context, visionStopSessionInvokeEventa, async () => {
    try {
      return await stopSessionInternal()
    }
    catch (error) {
      emitError(error)
      throw error
    }
  })

  defineInvokeHandler(params.context, visionStartScreenShareInvokeEventa, async () => {
    try {
      return await startScreenShareInternal()
    }
    catch (error) {
      emitError(error)
      throw error
    }
  })

  defineInvokeHandler(params.context, visionStopScreenShareInvokeEventa, async () => {
    try {
      return await stopScreenShareInternal()
    }
    catch (error) {
      emitError(error)
      throw error
    }
  })

  defineInvokeHandler(params.context, visionCaptureAndAskInvokeEventa, async (request: VisionCaptureAndAskRequest) => {
    try {
      if (normalizeBackend(currentConfig.backend) === 'gpt-http') {
        return await sendImageToGpt(
          request.imageBase64,
          request.prompt ?? 'Please describe what you see on this screen.',
        )
      }

      return await sendImageToAI(
        request.imageBase64,
        request.prompt ?? 'Please describe what you see on this screen.',
        request.interruptMode ?? 1,
      )
    }
    catch (error) {
      emitError(error)
      return {
        success: false,
      } satisfies VisionCaptureResult
    }
  })

  onAppWindowAllClosed(() => {
    void stopSessionInternal()
  })

  onAppBeforeQuit(() => {
    void stopSessionInternal()
  })
}
