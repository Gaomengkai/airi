<script setup lang="ts">
import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { Alert } from '@proj-airi/stage-ui/components'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { Button, FieldCheckbox, FieldInput, FieldRange, FieldSelect, Textarea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const visionStore = useVisionStore()

const {
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
} = storeToRefs(visionStore)

const isDesktop = computed(() => isStageTamagotchi())
const operationError = ref('')
const operationMessage = ref('')
const capturePrompt = ref('')
const captureInterruptMode = ref(1)

const isSaving = ref(false)
const isStarting = ref(false)
const isStopping = ref(false)
const isStartingShare = ref(false)
const isStoppingShare = ref(false)
const isCapturing = ref(false)

const detailOptions = computed(() => [
  { label: t('settings.pages.modules.vision.sections.parameters.detail-auto'), value: 'auto' },
  { label: t('settings.pages.modules.vision.sections.parameters.detail-high'), value: 'high' },
  { label: t('settings.pages.modules.vision.sections.parameters.detail-low'), value: 'low' },
])
const backendOptions = computed(() => [
  { label: t('settings.pages.modules.vision.sections.backend.doubao-rtc'), value: 'doubao-rtc' },
  { label: t('settings.pages.modules.vision.sections.backend.gpt-http'), value: 'gpt-http' },
])
const isDoubaoBackend = computed(() => backend.value === 'doubao-rtc')
const isGptBackend = computed(() => backend.value === 'gpt-http')

function toErrorMessage(error: unknown) {
  if (error instanceof Error)
    return error.message
  return String(error)
}

function setOperationError(error: unknown) {
  operationMessage.value = ''
  operationError.value = toErrorMessage(error)
}

function setOperationMessage(message: string) {
  operationError.value = ''
  operationMessage.value = message
}

async function saveConfig() {
  if (!isDesktop.value)
    return

  isSaving.value = true
  try {
    await visionStore.pushConfigToMain()
    setOperationMessage(t('settings.pages.modules.vision.sections.session.saved-config'))
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isSaving.value = false
  }
}

async function startSession() {
  if (!isDesktop.value)
    return

  isStarting.value = true
  try {
    await visionStore.startSession()
    setOperationMessage(t('settings.pages.modules.vision.sections.session.started'))
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isStarting.value = false
  }
}

async function stopSession() {
  if (!isDesktop.value)
    return

  isStopping.value = true
  try {
    await visionStore.stopSession()
    setOperationMessage(t('settings.pages.modules.vision.sections.session.stopped'))
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isStopping.value = false
  }
}

async function startScreenShare() {
  if (!isDesktop.value)
    return

  isStartingShare.value = true
  try {
    await visionStore.startScreenShare()
    setOperationMessage(t('settings.pages.modules.vision.sections.session.started-share'))
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isStartingShare.value = false
  }
}

async function stopScreenShare() {
  if (!isDesktop.value)
    return

  isStoppingShare.value = true
  try {
    await visionStore.stopScreenShare()
    setOperationMessage(t('settings.pages.modules.vision.sections.session.stopped-share'))
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isStoppingShare.value = false
  }
}

async function captureCurrentScreenBase64(maxHeight?: number) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('getDisplayMedia is not available in current environment')
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  })

  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.playsInline = true

  try {
    await new Promise<void>((resolve, reject) => {
      function onLoaded() {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
        resolve()
      }
      function onError() {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
        reject(new Error('Failed to read screen stream metadata'))
      }

      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onError)
    })

    await video.play()
    await new Promise(resolve => setTimeout(resolve, 100))

    const rawWidth = video.videoWidth || 1280
    const rawHeight = video.videoHeight || 720
    const normalizedMaxHeight = maxHeight && Number.isFinite(maxHeight)
      ? Math.min(720, Math.max(1, Math.floor(maxHeight)))
      : undefined
    const shouldResize = normalizedMaxHeight !== undefined && rawHeight > normalizedMaxHeight
    const width = shouldResize ? Math.max(1, Math.floor(rawWidth * (normalizedMaxHeight / rawHeight))) : rawWidth
    const height = shouldResize ? normalizedMaxHeight! : rawHeight
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Failed to create canvas context for screen capture')
    }

    context.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.9)
  }
  finally {
    video.pause()
    video.srcObject = null
    stream.getTracks().forEach(track => track.stop())
  }
}

async function captureAndAsk() {
  if (!isDesktop.value)
    return

  isCapturing.value = true
  try {
    const imageBase64 = await captureCurrentScreenBase64(
      isGptBackend.value ? gptImageHeight.value : undefined,
    )
    const result = await visionStore.captureAndAsk({
      imageBase64,
      prompt: capturePrompt.value.trim() || defaultAskPrompt.value,
      interruptMode: captureInterruptMode.value,
    })

    if (result.success) {
      setOperationMessage(t('settings.pages.modules.vision.sections.capture.result-success', {
        groupId: result.groupId ?? '-',
      }))
    }
    else {
      setOperationError(t('settings.pages.modules.vision.sections.capture.result-failed'))
    }
  }
  catch (error) {
    setOperationError(error)
  }
  finally {
    isCapturing.value = false
  }
}

onMounted(async () => {
  if (!isDesktop.value)
    return

  try {
    await visionStore.initializeEventListeners()
    await visionStore.syncStateFromMain()
  }
  catch (error) {
    setOperationError(error)
  }
})

onUnmounted(() => {
  visionStore.disposeEventListeners()
})
</script>

<template>
  <div v-if="!isDesktop">
    <Alert type="warning">
      <template #title>
        {{ t('settings.pages.modules.vision.unsupported.title') }}
      </template>
      <template #content>
        {{ t('settings.pages.modules.vision.unsupported.description') }}
      </template>
    </Alert>
  </div>

  <div v-else :class="['flex', 'flex-col', 'gap-6', 'md:flex-row']">
    <div :class="['h-fit', 'w-full', 'rounded-xl', 'bg-neutral-100', 'p-4', 'dark:bg-black/30', 'md:w-[42%]']">
      <div :class="['flex', 'flex-col', 'gap-6']">
        <div :class="['flex', 'flex-col', 'gap-4']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.vision.sections.backend.title') }}
            </h2>
            <div :class="['text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.vision.sections.backend.description') }}
            </div>
          </div>
          <FieldSelect v-model="backend" :label="t('settings.pages.modules.vision.sections.backend.label')" :options="backendOptions" layout="vertical" />
        </div>

        <div v-if="isDoubaoBackend" :class="['flex', 'flex-col', 'gap-4']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.vision.sections.credentials.title') }}
            </h2>
            <div :class="['text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.vision.sections.credentials.description') }}
            </div>
          </div>

          <FieldInput v-model="appId" :label="t('settings.pages.modules.vision.sections.credentials.app-id')" />
          <FieldInput v-model="appKey" :label="t('settings.pages.modules.vision.sections.credentials.app-key')" type="password" />
          <FieldInput v-model="accessKeyId" :label="t('settings.pages.modules.vision.sections.credentials.access-key-id')" />
          <FieldInput v-model="secretAccessKey" :label="t('settings.pages.modules.vision.sections.credentials.secret-access-key')" type="password" />
          <FieldInput v-model="baseUrl" :label="t('settings.pages.modules.vision.sections.credentials.base-url')" />
          <FieldInput v-model="region" :label="t('settings.pages.modules.vision.sections.credentials.region')" />
          <FieldInput v-model="modelName" :label="t('settings.pages.modules.vision.sections.credentials.model-name')" />
        </div>

        <div v-if="isDoubaoBackend" :class="['flex', 'flex-col', 'gap-4', 'border-t', 'border-neutral-200/70', 'pt-4', 'dark:border-neutral-700/40']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.vision.sections.parameters.title') }}
            </h2>
            <div :class="['text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.vision.sections.parameters.description') }}
            </div>
          </div>

          <FieldInput v-model="maxTokens" type="number" :label="t('settings.pages.modules.vision.sections.parameters.max-tokens')" />
          <FieldRange v-model="temperature" :label="t('settings.pages.modules.vision.sections.parameters.temperature')" :min="0" :max="2" :step="0.01" :format-value="value => value.toFixed(2)" />
          <FieldRange v-model="topP" :label="t('settings.pages.modules.vision.sections.parameters.top-p')" :min="0" :max="1" :step="0.01" :format-value="value => value.toFixed(2)" />
          <FieldInput v-model="historyLength" type="number" :label="t('settings.pages.modules.vision.sections.parameters.history-length')" />
          <FieldCheckbox v-model="enableVision" :label="t('settings.pages.modules.vision.sections.parameters.enable-vision')" />
          <FieldInput v-model="visionStreamType" type="number" :label="t('settings.pages.modules.vision.sections.parameters.stream-type')" />
          <FieldSelect v-model="visionImageDetail" :label="t('settings.pages.modules.vision.sections.parameters.image-detail')" :options="detailOptions" layout="vertical" />
          <FieldInput v-model="visionHeight" type="number" :label="t('settings.pages.modules.vision.sections.parameters.height')" />
          <FieldInput v-model="visionInterval" type="number" :label="t('settings.pages.modules.vision.sections.parameters.interval')" />
          <FieldInput v-model="visionImagesLimit" type="number" :label="t('settings.pages.modules.vision.sections.parameters.images-limit')" />
        </div>

        <div v-if="isGptBackend" :class="['flex', 'flex-col', 'gap-4', 'border-t', 'border-neutral-200/70', 'pt-4', 'dark:border-neutral-700/40']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.vision.sections.gpt.title') }}
            </h2>
            <div :class="['text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.vision.sections.gpt.description') }}
            </div>
          </div>

          <FieldInput v-model="gptBaseUrl" :label="t('settings.pages.modules.vision.sections.gpt.base-url')" />
          <FieldInput v-model="gptApiKey" type="password" :label="t('settings.pages.modules.vision.sections.gpt.api-key')" />
          <FieldInput v-model="gptModel" :label="t('settings.pages.modules.vision.sections.gpt.model')" />
          <FieldInput v-model="gptMaxTokens" type="number" :label="t('settings.pages.modules.vision.sections.gpt.max-tokens')" />
          <FieldRange v-model="gptTemperature" :label="t('settings.pages.modules.vision.sections.gpt.temperature')" :min="0" :max="2" :step="0.01" :format-value="value => value.toFixed(2)" />
          <FieldRange v-model="gptTopP" :label="t('settings.pages.modules.vision.sections.gpt.top-p')" :min="0" :max="1" :step="0.01" :format-value="value => value.toFixed(2)" />
          <FieldInput v-model="gptHistoryLength" type="number" :label="t('settings.pages.modules.vision.sections.gpt.history-length')" />
          <FieldInput v-model="gptImageHeight" type="number" :label="t('settings.pages.modules.vision.sections.gpt.image-height')" />
        </div>

        <div :class="['flex', 'flex-col', 'gap-4', 'border-t', 'border-neutral-200/70', 'pt-4', 'dark:border-neutral-700/40']">
          <FieldInput v-model="defaultAskPrompt" :label="t('settings.pages.modules.vision.sections.capture.default-prompt')" :single-line="false" />
          <FieldCheckbox v-if="isDoubaoBackend" v-model="useRemoteTTS" :label="t('settings.pages.modules.vision.sections.behavior.use-remote-tts')" />
          <FieldCheckbox v-model="autoSpeakSubtitle" :label="t('settings.pages.modules.vision.sections.behavior.auto-speak-subtitle')" />
          <FieldCheckbox v-model="idleEnabled" :label="t('settings.pages.modules.vision.sections.behavior.idle-enabled')" />
          <FieldInput v-model="idleTimeoutMs" type="number" :label="t('settings.pages.modules.vision.sections.behavior.idle-timeout-ms')" />
          <FieldInput v-model="idleInterruptMode" type="number" :label="t('settings.pages.modules.vision.sections.behavior.idle-interrupt-mode')" />
          <FieldInput v-model="idlePrompt" :label="t('settings.pages.modules.vision.sections.behavior.idle-prompt')" :single-line="false" />
        </div>
      </div>
    </div>

    <div :class="['flex', 'w-full', 'flex-col', 'gap-6', 'md:w-[58%]']">
      <div :class="['rounded-xl', 'bg-neutral-100/70', 'p-4', 'dark:bg-black/20']">
        <div :class="['mb-4', 'flex', 'items-start', 'justify-between', 'gap-3', 'flex-wrap']">
          <div>
            <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
              {{ t('settings.pages.modules.vision.sections.session.title') }}
            </h2>
            <div :class="['text-neutral-400', 'dark:text-neutral-500']">
              {{ t('settings.pages.modules.vision.sections.session.description') }}
            </div>
            <div v-if="isGptBackend" :class="['text-xs', 'text-amber-600', 'dark:text-amber-400', 'mt-1']">
              {{ t('settings.pages.modules.vision.sections.session.gpt-no-screen-share') }}
            </div>
          </div>
          <div :class="['text-sm', configured ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400']">
            {{ configured ? t('settings.pages.modules.vision.sections.session.configured') : t('settings.pages.modules.vision.sections.session.not-configured') }}
          </div>
        </div>

        <div :class="['flex', 'flex-wrap', 'gap-2']">
          <Button :loading="isSaving" variant="secondary" @click="saveConfig">
            {{ t('settings.pages.modules.vision.sections.session.save-config') }}
          </Button>
          <Button :disabled="!configured || isConnected" :loading="isStarting" @click="startSession">
            {{ t('settings.pages.modules.vision.sections.session.start') }}
          </Button>
          <Button :disabled="!isConnected" :loading="isStopping" variant="secondary" @click="stopSession">
            {{ t('settings.pages.modules.vision.sections.session.stop') }}
          </Button>
          <Button :disabled="!isConnected || isScreenSharing || isGptBackend" :loading="isStartingShare" variant="secondary" @click="startScreenShare">
            {{ t('settings.pages.modules.vision.sections.session.start-share') }}
          </Button>
          <Button :disabled="!isConnected || !isScreenSharing || isGptBackend" :loading="isStoppingShare" variant="secondary" @click="stopScreenShare">
            {{ t('settings.pages.modules.vision.sections.session.stop-share') }}
          </Button>
        </div>
      </div>

      <div :class="['rounded-xl', 'bg-neutral-100/70', 'p-4', 'dark:bg-black/20']">
        <div :class="['mb-4']">
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.vision.sections.capture.title') }}
          </h2>
          <div :class="['text-neutral-400', 'dark:text-neutral-500']">
            {{ t('settings.pages.modules.vision.sections.capture.description') }}
          </div>
        </div>

        <div :class="['flex', 'flex-col', 'gap-4']">
          <div>
            <label :class="['mb-1', 'block', 'text-sm', 'font-medium']">
              {{ t('settings.pages.modules.vision.sections.capture.prompt') }}
            </label>
            <Textarea v-model="capturePrompt" :placeholder="defaultAskPrompt" />
          </div>
          <FieldInput v-model="captureInterruptMode" type="number" :label="t('settings.pages.modules.vision.sections.capture.interrupt-mode')" />
          <Button :disabled="!isConnected" :loading="isCapturing" @click="captureAndAsk">
            {{ t('settings.pages.modules.vision.sections.capture.ask') }}
          </Button>
        </div>
      </div>

      <div v-if="operationMessage">
        <Alert type="success">
          <template #title>
            {{ operationMessage }}
          </template>
        </Alert>
      </div>

      <div v-if="operationError || lastError">
        <Alert type="error">
          <template #title>
            {{ operationError || lastError }}
          </template>
        </Alert>
      </div>

      <div :class="['rounded-xl', 'bg-neutral-100/70', 'p-4', 'dark:bg-black/20']">
        <div :class="['mb-4']">
          <h2 :class="['text-lg', 'text-neutral-500', 'md:text-2xl', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.vision.sections.runtime.title') }}
          </h2>
        </div>

        <div :class="['grid', 'grid-cols-1', 'gap-3', 'text-sm', 'md:grid-cols-2']">
          <div>{{ t('settings.pages.modules.vision.sections.runtime.connected') }}: {{ isConnected }}</div>
          <div>{{ t('settings.pages.modules.vision.sections.runtime.sharing') }}: {{ isScreenSharing }}</div>
          <div>{{ t('settings.pages.modules.vision.sections.runtime.room-id') }}: {{ roomId || '-' }}</div>
          <div>{{ t('settings.pages.modules.vision.sections.runtime.user-id') }}: {{ userId || '-' }}</div>
          <div>{{ t('settings.pages.modules.vision.sections.runtime.task-id') }}: {{ taskId || '-' }}</div>
          <div>{{ t('settings.pages.modules.vision.sections.runtime.bot-user-id') }}: {{ botUserId || '-' }}</div>
        </div>

        <div :class="['mt-4', 'rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-900/60']">
          <div :class="['mb-1', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            {{ t('settings.pages.modules.vision.sections.runtime.last-subtitle') }}
          </div>
          <div>{{ lastSubtitle || '-' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.vision.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
