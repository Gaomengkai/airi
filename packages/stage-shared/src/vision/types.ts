export interface VisionRTCConfig {
  backend: 'doubao-rtc' | 'gpt-http'
  appId: string
  appKey: string
  accessKeyId: string
  secretAccessKey: string
  baseUrl: string
  region: string
  modelName: string
  maxTokens: number
  temperature: number
  topP: number
  historyLength: number
  enableVision: boolean
  visionStreamType: number
  visionImageDetail: 'low' | 'high' | 'auto'
  visionHeight: number
  visionInterval: number
  visionImagesLimit: number
  useRemoteTTS: boolean
  idleEnabled: boolean
  idleTimeoutMs: number
  idlePrompt: string
  idleInterruptMode: number
  gptBaseUrl: string
  gptApiKey: string
  gptModel: string
  gptMaxTokens: number
  gptTemperature: number
  gptTopP: number
  gptHistoryLength: number
  gptImageHeight: number
}

export interface VisionCaptureAndAskRequest {
  imageBase64: string
  prompt?: string
  interruptMode?: number
}

export interface VisionCaptureResult {
  success: boolean
  groupId?: number
}

export interface VisionSessionState {
  isConnected: boolean
  isScreenSharing: boolean
  roomId?: string
  userId?: string
  taskId?: string
  botUserId?: string
  lastError?: string
}

export interface VisionSubtitlePayload {
  text: string
  isUser: boolean
}

export interface VisionErrorPayload {
  message: string
  code?: string | number
}

export interface VisionLocalTtsStatePayload {
  isSpeaking: boolean
  reason?: string
}
