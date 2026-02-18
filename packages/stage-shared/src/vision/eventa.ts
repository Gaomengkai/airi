import type {
  VisionCaptureAndAskRequest,
  VisionCaptureResult,
  VisionErrorPayload,
  VisionLocalTtsStatePayload,
  VisionRTCConfig,
  VisionSessionState,
  VisionSubtitlePayload,
} from './types'

import { defineInvokeEventa } from '@moeru/eventa'

export const visionStartSessionInvokeEventa = defineInvokeEventa<VisionSessionState, VisionRTCConfig>(
  'eventa:invoke:electron:vision:start-session',
)

export const visionStopSessionInvokeEventa = defineInvokeEventa<VisionSessionState, never>(
  'eventa:invoke:electron:vision:stop-session',
)

export const visionGetStateInvokeEventa = defineInvokeEventa<VisionSessionState, never>(
  'eventa:invoke:electron:vision:get-state',
)

export const visionUpdateConfigInvokeEventa = defineInvokeEventa<VisionSessionState, Partial<VisionRTCConfig>>(
  'eventa:invoke:electron:vision:update-config',
)

export const visionStartScreenShareInvokeEventa = defineInvokeEventa<boolean, never>(
  'eventa:invoke:electron:vision:start-screen-share',
)

export const visionStopScreenShareInvokeEventa = defineInvokeEventa<boolean, never>(
  'eventa:invoke:electron:vision:stop-screen-share',
)

export const visionCaptureAndAskInvokeEventa = defineInvokeEventa<VisionCaptureResult, VisionCaptureAndAskRequest>(
  'eventa:invoke:electron:vision:capture-and-ask',
)

export const visionLocalTtsStateInvokeEventa = defineInvokeEventa<void, VisionLocalTtsStatePayload>(
  'eventa:invoke:electron:vision:local-tts-state',
)

export const visionStateChangedInvokeEventa = defineInvokeEventa<void, VisionSessionState>(
  'eventa:event:electron:vision:state-changed',
)

export const visionSubtitleInvokeEventa = defineInvokeEventa<void, VisionSubtitlePayload>(
  'eventa:event:electron:vision:subtitle',
)

export const visionErrorInvokeEventa = defineInvokeEventa<void, VisionErrorPayload>(
  'eventa:event:electron:vision:error',
)
