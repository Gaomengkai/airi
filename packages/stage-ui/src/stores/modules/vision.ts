import type { createContext as createElectronContext } from '@moeru/eventa/adapters/electron/renderer'
import type {
  VisionCaptureAndAskRequest,
  VisionCaptureResult,
  VisionErrorPayload,
  VisionLocalTtsStatePayload,
  VisionRTCConfig,
  VisionSessionState,
  VisionSubtitlePayload,
} from '@proj-airi/stage-shared/vision'
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
import { isElectronWindow, isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
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
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useProvidersStore } from '../providers'
import { useSpeechStore } from './speech'

const DEFAULT_PROMPT = 'Please describe what you see on this screen.'

export const useVisionStore = defineStore('vision-store', () => {
  const providersStore = useProvidersStore()
  const speechStore = useSpeechStore()

  const backend = useLocalStorageManualReset<'doubao-rtc' | 'gpt-http'>('settings/vision/backend', 'doubao-rtc')
  const appId = useLocalStorageManualReset<string>('settings/vision/app-id', '')
  const appKey = useLocalStorageManualReset<string>('settings/vision/app-key', '')
  const accessKeyId = useLocalStorageManualReset<string>('settings/vision/access-key-id', '')
  const secretAccessKey = useLocalStorageManualReset<string>('settings/vision/secret-access-key', '')
  const baseUrl = useLocalStorageManualReset<string>('settings/vision/base-url', 'https://rtc.volcengineapi.com')
  const region = useLocalStorageManualReset<string>('settings/vision/region', 'cn-north-1')
  const modelName = useLocalStorageManualReset<string>('settings/vision/model-name', 'doubao-seed-1-8-251228')
  const maxTokens = useLocalStorageManualReset<number>('settings/vision/max-tokens', 1024)
  const temperature = useLocalStorageManualReset<number>('settings/vision/temperature', 0.5)
  const topP = useLocalStorageManualReset<number>('settings/vision/top-p', 0.3)
  const historyLength = useLocalStorageManualReset<number>('settings/vision/history-length', 50)
  const enableVision = useLocalStorageManualReset<boolean>('settings/vision/enable-vision', true)
  const visionStreamType = useLocalStorageManualReset<number>('settings/vision/stream-type', 1)
  const visionImageDetail = useLocalStorageManualReset<'low' | 'high' | 'auto'>('settings/vision/image-detail', 'high')
  const visionHeight = useLocalStorageManualReset<number>('settings/vision/height', 720)
  const visionInterval = useLocalStorageManualReset<number>('settings/vision/interval', 500)
  const visionImagesLimit = useLocalStorageManualReset<number>('settings/vision/images-limit', 5)
  const useRemoteTTS = useLocalStorageManualReset<boolean>('settings/vision/use-remote-tts', false)
  const idleEnabled = useLocalStorageManualReset<boolean>('settings/vision/idle-enabled', false)
  const idleTimeoutMs = useLocalStorageManualReset<number>('settings/vision/idle-timeout-ms', 30000)
  const idlePrompt = useLocalStorageManualReset<string>('settings/vision/idle-prompt', 'Please check the current screen and share a short useful update.')
  const idleInterruptMode = useLocalStorageManualReset<number>('settings/vision/idle-interrupt-mode', 1)
  const gptBaseUrl = useLocalStorageManualReset<string>('settings/vision/gpt-base-url', 'https://api.openai.com/v1')
  const gptApiKey = useLocalStorageManualReset<string>('settings/vision/gpt-api-key', '')
  const gptModel = useLocalStorageManualReset<string>('settings/vision/gpt-model', 'gpt-4.1-mini')
  const gptMaxTokens = useLocalStorageManualReset<number>('settings/vision/gpt-max-tokens', 800)
  const gptTemperature = useLocalStorageManualReset<number>('settings/vision/gpt-temperature', 0.2)
  const gptTopP = useLocalStorageManualReset<number>('settings/vision/gpt-top-p', 1)
  const gptHistoryLength = useLocalStorageManualReset<number>('settings/vision/gpt-history-length', 12)
  const gptImageHeight = useLocalStorageManualReset<number>('settings/vision/gpt-image-height', 720)

  const defaultAskPrompt = useLocalStorageManualReset<string>('settings/vision/default-ask-prompt', DEFAULT_PROMPT)
  const autoSpeakSubtitle = useLocalStorageManualReset<boolean>('settings/vision/auto-speak-subtitle', true)

  const isConnected = ref(false)
  const isScreenSharing = ref(false)
  const roomId = ref('')
  const userId = ref('')
  const taskId = ref('')
  const botUserId = ref('')
  const lastSubtitle = ref('')
  const lastError = ref('')

  const listenersInitialized = ref(false)
  let removeStateChangedListener: (() => void) | undefined
  let removeSubtitleListener: (() => void) | undefined
  let removeErrorListener: (() => void) | undefined
  let cachedContext: ReturnType<typeof createElectronContext>['context'] | undefined
  let currentAudioElement: HTMLAudioElement | undefined
  let currentAudioUrl: string | undefined
  let speakRequestId = 0

  const configured = computed(() => {
    if (backend.value === 'gpt-http') {
      return !!gptBaseUrl.value
        && !!gptApiKey.value
        && !!gptModel.value
    }

    return !!appId.value
      && !!appKey.value
      && !!accessKeyId.value
      && !!secretAccessKey.value
      && !!modelName.value
  })

  const rtcConfig = computed<VisionRTCConfig>(() => ({
    backend: backend.value,
    appId: appId.value,
    appKey: appKey.value,
    accessKeyId: accessKeyId.value,
    secretAccessKey: secretAccessKey.value,
    baseUrl: baseUrl.value,
    region: region.value,
    modelName: modelName.value,
    maxTokens: maxTokens.value,
    temperature: temperature.value,
    topP: topP.value,
    historyLength: historyLength.value,
    enableVision: enableVision.value,
    visionStreamType: visionStreamType.value,
    visionImageDetail: visionImageDetail.value,
    visionHeight: visionHeight.value,
    visionInterval: visionInterval.value,
    visionImagesLimit: visionImagesLimit.value,
    useRemoteTTS: useRemoteTTS.value,
    idleEnabled: idleEnabled.value,
    idleTimeoutMs: idleTimeoutMs.value,
    idlePrompt: idlePrompt.value,
    idleInterruptMode: idleInterruptMode.value,
    gptBaseUrl: gptBaseUrl.value,
    gptApiKey: gptApiKey.value,
    gptModel: gptModel.value,
    gptMaxTokens: gptMaxTokens.value,
    gptTemperature: gptTemperature.value,
    gptTopP: gptTopP.value,
    gptHistoryLength: gptHistoryLength.value,
    gptImageHeight: gptImageHeight.value,
  }))

  function updateRuntimeState(state: VisionSessionState) {
    isConnected.value = state.isConnected
    isScreenSharing.value = state.isScreenSharing
    roomId.value = state.roomId ?? ''
    userId.value = state.userId ?? ''
    taskId.value = state.taskId ?? ''
    botUserId.value = state.botUserId ?? ''
    if (state.lastError) {
      lastError.value = state.lastError
    }
  }

  function stopSpeechPlayback(reason: string) {
    if (currentAudioElement) {
      try {
        currentAudioElement.onended = null
        currentAudioElement.onerror = null
        currentAudioElement.pause()
        currentAudioElement.currentTime = 0
      }
      catch {
        // Ignore playback cleanup errors.
      }
      currentAudioElement = undefined
    }

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl)
      currentAudioUrl = undefined
    }

    void notifyLocalTtsState({
      isSpeaking: false,
      reason,
    })
  }

  function resolveSpeechModelAndVoice() {
    const activeProvider = speechStore.activeSpeechProvider
    const providerConfig = providersStore.getProviderConfig(activeProvider)
    let model = speechStore.activeSpeechModel
    let voice = speechStore.activeSpeechVoice

    if (activeProvider === 'openai-compatible-audio-speech') {
      model = String(providerConfig?.model || model || 'tts-1')
      const voiceId = String(providerConfig?.voice || voice?.id || 'alloy')
      voice = {
        id: voiceId,
        name: voiceId,
        description: voiceId,
        previewURL: '',
        languages: [{ code: 'en', title: 'English' }],
        provider: activeProvider,
        gender: 'neutral',
      }
    }

    if (!model || !voice) {
      return undefined
    }

    return {
      activeProvider,
      providerConfig,
      model,
      voice,
    }
  }

  async function speak(text: string) {
    if (typeof window === 'undefined')
      return

    const trimmed = text.trim()
    if (!trimmed)
      return

    const activeProvider = speechStore.activeSpeechProvider
    if (!activeProvider) {
      console.warn('[vision] speech provider is not configured, skip subtitle speaking')
      return
    }

    const provider = await providersStore.getProviderInstance(activeProvider) as SpeechProviderWithExtraOptions<string, any> | undefined
    if (!provider) {
      console.warn('[vision] failed to initialize speech provider, skip subtitle speaking')
      return
    }

    const resolved = resolveSpeechModelAndVoice()
    if (!resolved) {
      console.warn('[vision] speech model or voice is missing, skip subtitle speaking')
      return
    }

    const requestId = ++speakRequestId
    stopSpeechPlayback('cancel-before-new')
    void notifyLocalTtsState({ isSpeaking: true, reason: 'start' })

    try {
      const input = speechStore.ssmlEnabled
        ? speechStore.generateSSML(trimmed, resolved.voice, {
            ...resolved.providerConfig,
            pitch: speechStore.pitch,
          })
        : trimmed

      const audioArrayBuffer = await speechStore.speech(
        provider,
        resolved.model,
        input,
        resolved.voice.id,
        resolved.providerConfig,
      )

      if (requestId !== speakRequestId) {
        return
      }

      if (!audioArrayBuffer || audioArrayBuffer.byteLength === 0) {
        throw new Error('Speech output is empty')
      }

      const audioUrl = URL.createObjectURL(new Blob([audioArrayBuffer]))
      const audio = new Audio(audioUrl)
      audio.onended = () => {
        if (currentAudioElement === audio) {
          currentAudioElement = undefined
          if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl)
            currentAudioUrl = undefined
          }
          void notifyLocalTtsState({
            isSpeaking: false,
            reason: 'end',
          })
        }
      }
      audio.onerror = () => {
        if (currentAudioElement === audio) {
          currentAudioElement = undefined
          if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl)
            currentAudioUrl = undefined
          }
          void notifyLocalTtsState({
            isSpeaking: false,
            reason: 'error',
          })
        }
      }

      currentAudioElement = audio
      currentAudioUrl = audioUrl
      await audio.play()
    }
    catch (error) {
      console.error('[vision] failed to speak subtitle with speech module', error)
      stopSpeechPlayback('error')
    }
  }

  async function getElectronContext(): Promise<ReturnType<typeof createElectronContext>['context']> {
    if (!isStageTamagotchi() || typeof window === 'undefined' || !isElectronWindow(window)) {
      throw new Error('Vision module invoke is only available in stage-tamagotchi environment')
    }

    if (cachedContext)
      return cachedContext

    const { createContext } = await import('@moeru/eventa/adapters/electron/renderer')
    const nextContext = createContext(window.electron.ipcRenderer).context
    cachedContext = nextContext
    return nextContext
  }

  async function initializeEventListeners() {
    if (!isStageTamagotchi() || listenersInitialized.value)
      return

    const context = await getElectronContext()

    removeStateChangedListener = defineInvokeHandler(context, visionStateChangedInvokeEventa, (state) => {
      updateRuntimeState(state)
    })

    removeSubtitleListener = defineInvokeHandler(context, visionSubtitleInvokeEventa, (payload: VisionSubtitlePayload) => {
      lastSubtitle.value = payload.text
      // eslint-disable-next-line no-console
      console.log(`[vision] ${payload.isUser ? 'user' : 'assistant'}: ${payload.text}`)
      if (autoSpeakSubtitle.value && !payload.isUser && !useRemoteTTS.value) {
        void speak(payload.text)
      }
    })

    removeErrorListener = defineInvokeHandler(context, visionErrorInvokeEventa, (payload: VisionErrorPayload) => {
      lastError.value = payload.message

      console.error('[vision]', payload)
    })

    listenersInitialized.value = true
  }

  function disposeEventListeners() {
    stopSpeechPlayback('dispose')

    removeStateChangedListener?.()
    removeStateChangedListener = undefined
    removeSubtitleListener?.()
    removeSubtitleListener = undefined
    removeErrorListener?.()
    removeErrorListener = undefined
    listenersInitialized.value = false
  }

  async function invokeVision(eventa: unknown, payload?: unknown) {
    const context = await getElectronContext()
    const invoke = defineInvoke(context, eventa as never) as (request?: unknown) => Promise<unknown>
    return invoke(payload)
  }

  async function notifyLocalTtsState(payload: VisionLocalTtsStatePayload) {
    if (!isStageTamagotchi())
      return

    try {
      await invokeVision(visionLocalTtsStateInvokeEventa, payload)
    }
    catch {
      // Ignore local TTS state notify errors, they should not break subtitle playback.
    }
  }

  async function syncStateFromMain() {
    if (!isStageTamagotchi())
      return

    const state = await invokeVision(visionGetStateInvokeEventa) as VisionSessionState
    updateRuntimeState(state)
  }

  async function startSession() {
    const state = await invokeVision(visionStartSessionInvokeEventa, rtcConfig.value) as VisionSessionState
    updateRuntimeState(state)
    return state
  }

  async function stopSession() {
    const state = await invokeVision(visionStopSessionInvokeEventa) as VisionSessionState
    updateRuntimeState(state)
    return state
  }

  async function startScreenShare() {
    const started = await invokeVision(visionStartScreenShareInvokeEventa) as boolean
    if (started) {
      isScreenSharing.value = true
    }
    return started
  }

  async function stopScreenShare() {
    const stopped = await invokeVision(visionStopScreenShareInvokeEventa) as boolean
    if (stopped) {
      isScreenSharing.value = false
    }
    return stopped
  }

  async function captureAndAsk(request: VisionCaptureAndAskRequest) {
    return invokeVision(visionCaptureAndAskInvokeEventa, request) as Promise<VisionCaptureResult>
  }

  async function pushConfigToMain() {
    const state = await invokeVision(visionUpdateConfigInvokeEventa, rtcConfig.value) as VisionSessionState
    updateRuntimeState(state)
  }

  function resetState() {
    backend.reset()
    appId.reset()
    appKey.reset()
    accessKeyId.reset()
    secretAccessKey.reset()
    baseUrl.reset()
    region.reset()
    modelName.reset()
    maxTokens.reset()
    temperature.reset()
    topP.reset()
    historyLength.reset()
    enableVision.reset()
    visionStreamType.reset()
    visionImageDetail.reset()
    visionHeight.reset()
    visionInterval.reset()
    visionImagesLimit.reset()
    useRemoteTTS.reset()
    idleEnabled.reset()
    idleTimeoutMs.reset()
    idlePrompt.reset()
    idleInterruptMode.reset()
    gptBaseUrl.reset()
    gptApiKey.reset()
    gptModel.reset()
    gptMaxTokens.reset()
    gptTemperature.reset()
    gptTopP.reset()
    gptHistoryLength.reset()
    gptImageHeight.reset()
    defaultAskPrompt.reset()
    autoSpeakSubtitle.reset()
  }

  return {
    backend,
    appId,
    appKey,
    accessKeyId,
    secretAccessKey,
    baseUrl,
    region,
    modelName,
    maxTokens,
    temperature,
    topP,
    historyLength,
    enableVision,
    visionStreamType,
    visionImageDetail,
    visionHeight,
    visionInterval,
    visionImagesLimit,
    useRemoteTTS,
    idleEnabled,
    idleTimeoutMs,
    idlePrompt,
    idleInterruptMode,
    gptBaseUrl,
    gptApiKey,
    gptModel,
    gptMaxTokens,
    gptTemperature,
    gptTopP,
    gptHistoryLength,
    gptImageHeight,
    defaultAskPrompt,
    autoSpeakSubtitle,
    isConnected,
    isScreenSharing,
    roomId,
    userId,
    taskId,
    botUserId,
    lastSubtitle,
    lastError,
    configured,
    rtcConfig,
    speak,
    initializeEventListeners,
    disposeEventListeners,
    syncStateFromMain,
    startSession,
    stopSession,
    startScreenShare,
    stopScreenShare,
    captureAndAsk,
    pushConfigToMain,
    resetState,
  }
})
