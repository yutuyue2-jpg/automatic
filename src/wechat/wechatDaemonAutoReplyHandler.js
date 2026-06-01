import { normalizeWechatDaemonThreadMeta } from './wechatDaemonStore.js'

const DEFAULT_MAIN_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MAIN_MODEL = 'gpt-3.5-turbo'
const BACKGROUND_DEVICE_INDEX_KEY = 'devices:index'
const BACKGROUND_SNAPSHOT_PREFIX = 'snapshot:'
const BACKGROUND_KEY_PREFIX = 'background-ai:'

const normalizeText = (value = '') => String(value || '').trim()
const REMOTE_DEBUG_EVENT_URL = 'https://ai-phone-background.yutuyue2.workers.dev/debug/event'

const clone = (value) => JSON.parse(JSON.stringify(value))

const THREAD_CONTEXT_LOADER_KEYS = [
  'wechatDaemonThreadContextLoader',
  '__WECHAT_DAEMON_THREAD_CONTEXT_LOADER__'
]

let sharedModulesPromise = null

const dynamicImport = (specifier) => new Function('specifier', 'return import(specifier)')(specifier)

function isAutoBrainSsrEnabled(env = process.env) {
  return normalizeText(env.WECHAT_DAEMON_ENABLE_AUTOBRAIN_SSR) === '1'
}

function safeId(value = '') {
  return normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160)
}

function resolveKvNamespace(env = process.env) {
  const candidates = [
    env.WECHAT_DAEMON_KV,
    env.AI_PHONE_WECHAT_DAEMON_KV,
    env.PROACTIVE_KV
  ]
  return candidates.find((item) => (
    item
    && typeof item.get === 'function'
    && typeof item.put === 'function'
  )) || null
}

async function getKvJson(env = process.env, key = '', fallback = null) {
  const kv = resolveKvNamespace(env)
  const safeKey = normalizeText(key)
  if (!kv || !safeKey) return fallback
  const raw = await kv.get(safeKey)
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function base64UrlToUint8Array(value = '') {
  const text = normalizeText(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function sha256Bytes(value = '') {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')))
}

async function getAesKey(env = process.env) {
  const secret = normalizeText(env.KEY_ENCRYPTION_SECRET || env.BACKGROUND_KEY_ENCRYPTION_SECRET)
  if (!secret) throw new Error('missing_KEY_ENCRYPTION_SECRET')
  const digest = await sha256Bytes(secret)
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt'])
}

async function decryptBackgroundAiSecret(env = process.env, encrypted = null) {
  if (!encrypted?.ciphertext || !encrypted?.iv) return null
  const key = await getAesKey(env)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToUint8Array(encrypted.iv) },
    key,
    base64UrlToUint8Array(encrypted.ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

function snapshotMatchesWechatThread(snapshot = null, {
  binding = null,
  contact = null
} = {}) {
  const threadKey = normalizeText(binding?.threadKey || binding?.chatId)
  const inferredRoleId = threadKey.match(/role_\d+_[A-Za-z0-9]+/)?.[0] || ''
  const roleId = normalizeText(contact?.id || binding?.roleId || inferredRoleId)
  const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : []
  if (!roleId && !threadKey) return false
  return roles.some((role) => {
    if (roleId && normalizeText(role?.id) === roleId) return true
    const threads = Array.isArray(role?.wechatThreads) ? role.wechatThreads : []
    return threads.some((thread) => {
      const candidate = normalizeText(thread?.chatId || thread?.threadKey)
      return threadKey && candidate === threadKey
    })
  })
}

async function resolveBackgroundDeviceId(env = process.env, {
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  const explicitId = safeId(
    threadContext?.backgroundDeviceId
    || threadContext?.deviceId
    || env.WECHAT_DAEMON_BACKGROUND_DEVICE_ID
  )
  if (explicitId) return explicitId

  const deviceIds = await getKvJson(env, BACKGROUND_DEVICE_INDEX_KEY, [])
  const safeDeviceIds = (Array.isArray(deviceIds) ? deviceIds : [])
    .map((item) => safeId(item))
    .filter(Boolean)
  if (safeDeviceIds.length === 1) return safeDeviceIds[0]

  for (const deviceId of safeDeviceIds.slice(-80).reverse()) {
    const snapshot = await getKvJson(env, `${BACKGROUND_SNAPSHOT_PREFIX}${deviceId}`)
    if (snapshotMatchesWechatThread(snapshot, { binding, contact })) return deviceId
  }
  return ''
}

async function loadBackgroundAiSettings(env = process.env, {
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  const deviceId = await resolveBackgroundDeviceId(env, { threadContext, binding, contact })
  if (!deviceId) {
    return {
      ok: false,
      error: 'wechat_daemon_background_device_missing'
    }
  }
  const encrypted = await getKvJson(env, `${BACKGROUND_KEY_PREFIX}${deviceId}`)
  if (!encrypted) {
    return {
      ok: false,
      error: 'wechat_daemon_background_ai_key_missing',
      backgroundDeviceId: deviceId
    }
  }
  let decrypted = null
  try {
    decrypted = await decryptBackgroundAiSecret(env, encrypted)
  } catch (error) {
    return {
      ok: false,
      error: normalizeText(error?.message) === 'missing_KEY_ENCRYPTION_SECRET'
        ? 'wechat_daemon_background_ai_secret_missing'
        : 'wechat_daemon_background_ai_decrypt_failed',
      backgroundDeviceId: deviceId
    }
  }
  if (!decrypted?.apiKey || !decrypted?.baseUrl || !decrypted?.model) {
    return {
      ok: false,
      error: 'wechat_daemon_background_ai_key_invalid',
      backgroundDeviceId: deviceId
    }
  }
  return {
    ok: true,
    apiKey: normalizeText(decrypted.apiKey),
    baseUrl: normalizeText(decrypted.baseUrl),
    model: normalizeText(decrypted.model),
    source: 'background_ai_key',
    backgroundDeviceId: deviceId
  }
}

async function hydrateAiSettingsFromBackgroundKey({
  env = process.env,
  settingsStore = null,
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  if (settingsStore?.apiKey && settingsStore?.model) return settingsStore
  try {
    const backgroundSettings = await loadBackgroundAiSettings(env, { threadContext, binding, contact })
    if (!backgroundSettings?.ok) {
      return {
        ...settingsStore,
        backgroundAiResolutionError: normalizeText(backgroundSettings?.error),
        backgroundDeviceId: normalizeText(backgroundSettings?.backgroundDeviceId || settingsStore?.backgroundDeviceId)
      }
    }
    return {
      ...settingsStore,
      ...backgroundSettings,
      baseUrl: backgroundSettings.baseUrl || settingsStore?.baseUrl || DEFAULT_MAIN_BASE_URL,
      model: backgroundSettings.model || settingsStore?.model || DEFAULT_MAIN_MODEL
    }
  } catch (error) {
    console.warn('[wechat-daemon] load background ai key failed', error)
    return settingsStore
  }
}

function canUseDirectAiSettings(settingsStore = null) {
  return Boolean(
    settingsStore?.apiKey
    && settingsStore?.model
  )
}

export function getWechatDaemonAiResolutionUserMessage(code = '') {
  const raw = normalizeText(code)
  if (raw === 'wechat_daemon_background_device_missing') {
    return '这条微信线程还没有关联到后台设备 ID。请先打开一次对应聊天页，让线程快照同步到后台。'
  }
  if (raw === 'wechat_daemon_background_ai_key_missing') {
    return '后台设备已经识别到了，但这个设备下还没有保存后台 AI Key。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_secret_missing') {
    return '后台解密密钥缺失，当前无法读取已保存的后台 AI Key。请检查部署环境里的 KEY_ENCRYPTION_SECRET。'
  }
  if (raw === 'wechat_daemon_background_ai_decrypt_failed') {
    return '后台 AI Key 解密失败。通常是更换过加密密钥后，旧 Key 还没重新保存。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_key_invalid') {
    return '后台 AI Key 已读取到，但内容不完整，缺少 API Key、Base URL 或模型。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_ai_settings_missing') {
    return '后台 AI 配置没有读到。请重新保存一次“后台消息专用 API Key”，并打开一次对应聊天页同步线程快照。'
  }
  return raw || '后台 AI 配置暂未就绪'
}

function normalizeInboundUpdate(update = {}, index = 0) {
  const safe = update && typeof update === 'object' ? update : {}
  return {
    id: normalizeText(safe.id || safe.messageId || `wechat_daemon_inbound_${index}`),
    type: normalizeText(safe.type || 'text') || 'text',
    content: normalizeText(safe.content || safe.text || safe.message),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now())),
    from: normalizeText(safe.from),
    contextToken: normalizeText(safe.contextToken || safe.context_token)
  }
}

function buildMessageKey(message = {}) {
  return [
    normalizeText(message?.id),
    normalizeText(message?.role),
    normalizeText(message?.type),
    normalizeText(message?.text || message?.originalText || message?.content),
    Number(message?.timestamp || 0)
  ].join('|')
}

function buildInboundWechatMessage(update = {}, index = 0) {
  const safeUpdate = normalizeInboundUpdate(update, index)
  return {
    id: safeUpdate.id || `wechat_daemon_msg_${safeUpdate.createdAt || Date.now()}_${index}`,
    role: 'user',
    type: safeUpdate.type || 'text',
    text: safeUpdate.content,
    originalText: safeUpdate.content,
    timestamp: safeUpdate.createdAt || Date.now()
  }
}

function buildOutboundWechatMessage(message = {}, index = 0, baseTimestamp = Date.now()) {
  const safe = message && typeof message === 'object' ? message : {}
  const originalText = normalizeText(safe.originalText || safe.text)
  const translatedText = normalizeText(safe.translatedText)
  const transcript = normalizeText(safe.transcript)
  const description = normalizeText(safe.description || safe.desc)
  const timestamp = Math.max(0, Number(safe.timestamp || 0)) || (baseTimestamp + index)
  return {
    id: normalizeText(safe.id) || `wechat_daemon_reply_${timestamp}_${index}`,
    role: 'assistant',
    type: normalizeText(safe.type || 'text') || 'text',
    text: originalText || transcript || description,
    originalText,
    translatedText,
    transcript,
    description,
    timestamp,
    amount: normalizeText(safe.amount),
    status: normalizeText(safe.status || 'queued')
  }
}

function mergeConversationMessages(baseMessages = [], inboundUpdates = []) {
  const nextMessages = Array.isArray(baseMessages)
    ? baseMessages.map((item) => clone(item))
    : []
  const existingKeys = new Set(nextMessages.map((item) => buildMessageKey(item)))
  inboundUpdates
    .map((item, index) => buildInboundWechatMessage(item, index))
    .forEach((message) => {
      const key = buildMessageKey(message)
      if (existingKeys.has(key)) return
      existingKeys.add(key)
      nextMessages.push(message)
    })
  return nextMessages.sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0))
}

function resolveThreadContextLoader(env = process.env) {
  for (const key of THREAD_CONTEXT_LOADER_KEYS) {
    if (typeof env?.[key] === 'function') return env[key]
  }
  return null
}

async function loadThreadContext({
  env = process.env,
  binding = null,
  inboundUpdates = [],
  store = null,
  outboxStore = null
} = {}) {
  const bindingSnapshot = binding?.threadContextSnapshot && typeof binding.threadContextSnapshot === 'object'
    ? clone(binding.threadContextSnapshot)
    : {}
  const loader = resolveThreadContextLoader(env)
  if (typeof loader !== 'function') return bindingSnapshot
  const loaded = await loader({
    env,
    binding,
    inboundUpdates,
    store,
    outboxStore
  })
  return {
    ...bindingSnapshot,
    ...(loaded && typeof loaded === 'object' ? loaded : {})
  }
}

async function loadSharedModules(env = process.env) {
  if (!isAutoBrainSsrEnabled(env)) {
    throw new Error('wechat_daemon_autobrain_ssr_disabled')
  }
  if (!sharedModulesPromise) {
    sharedModulesPromise = Promise.all([
      dynamicImport(new URL('./autoBrainServerRuntimeProviders.js', import.meta.url).href),
      dynamicImport(new URL('./frontendSsrModuleLoader.js', import.meta.url).href)
    ]).then(([runtimeProvidersModule, ssrLoaderModule]) => Promise.all([
      runtimeProvidersModule,
      ssrLoaderModule.loadFrontendSsrModule('/src/services/core/autoBrainService.js', env),
      ssrLoaderModule.loadFrontendSsrModule('/src/services/memory/roleMemoryService.js', env)
    ])).then(([runtimeProvidersModule, autoBrainService, roleMemoryService]) => ({
      createAutoBrainServerRuntimeProviders: runtimeProvidersModule.createAutoBrainServerRuntimeProviders,
      autoBrainService,
      roleMemoryService
    })).catch((error) => {
      sharedModulesPromise = null
      throw error
    })
  }
  return sharedModulesPromise
}

function resolveAiSettings(env = process.env, threadContext = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const seed = safeThreadContext.settingsStore && typeof safeThreadContext.settingsStore === 'object'
    ? clone(safeThreadContext.settingsStore)
    : {}
  return {
    ...seed,
    apiKey: normalizeText(
      seed.apiKey
      || env.WECHAT_DAEMON_AI_API_KEY
      || env.AI_PHONE_AI_API_KEY
      || env.OPENAI_API_KEY
    ),
    baseUrl: normalizeText(
      seed.baseUrl
      || env.WECHAT_DAEMON_AI_BASE_URL
      || env.AI_PHONE_AI_BASE_URL
      || env.OPENAI_BASE_URL
      || DEFAULT_MAIN_BASE_URL
    ) || DEFAULT_MAIN_BASE_URL,
    model: normalizeText(
      seed.model
      || env.WECHAT_DAEMON_AI_MODEL
      || env.AI_PHONE_AI_MODEL
      || env.OPENAI_MODEL
      || DEFAULT_MAIN_MODEL
    ) || DEFAULT_MAIN_MODEL,
    modelTemperatureSettings: seed.modelTemperatureSettings || {}
  }
}

function buildRoleContact(binding = null, threadContext = null, mergedMessages = []) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const seededContact = safeThreadContext.contact && typeof safeThreadContext.contact === 'object'
    ? clone(safeThreadContext.contact)
    : {}
  const roleId = normalizeText(seededContact.id || safeBinding.roleId)
  return {
    ...seededContact,
    id: roleId,
    name: normalizeText(
      seededContact.name
      || seededContact.wechatIdentityDisplayName
      || safeBinding.externalAccountName
      || roleId
      || '对方'
    ) || '对方',
    sessionAccountId: normalizeText(seededContact.sessionAccountId || safeBinding.accountId),
    sessionChatId: normalizeText(seededContact.sessionChatId || safeBinding.chatId || safeBinding.threadKey),
    wechatIdentityId: normalizeText(seededContact.wechatIdentityId || safeBinding.identity || 'main') || 'main',
    messages: Array.isArray(mergedMessages) && mergedMessages.length
      ? mergedMessages
      : (Array.isArray(seededContact.messages) ? seededContact.messages : []),
    recentEvents: Array.isArray(seededContact.recentEvents) ? seededContact.recentEvents : [],
    memory: seededContact.memory && typeof seededContact.memory === 'object' ? seededContact.memory : {}
  }
}

function buildRoleStore(binding = null, threadContext = null, contact = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.roleStore && typeof safeThreadContext.roleStore === 'object') {
    return safeThreadContext.roleStore
  }
  const roleSeed = safeThreadContext.role && typeof safeThreadContext.role === 'object'
    ? clone(safeThreadContext.role)
    : {}
  const roleRecord = {
    ...roleSeed,
    ...(contact && typeof contact === 'object' ? clone(contact) : {})
  }
  const roles = Array.isArray(safeThreadContext.roles)
    ? safeThreadContext.roles.map((item) => clone(item))
    : (roleRecord.id ? [clone(roleRecord)] : [])
  return {
    roles,
    getWechatIdentityRole(roleId = '', options = {}) {
      const safeRoleId = normalizeText(roleId)
      const explicitAccountId = normalizeText(options?.accountId)
      const explicitIdentity = normalizeText(options?.identity || 'main') || 'main'
      if (roleRecord.id && roleRecord.id === safeRoleId) {
        return {
          ...clone(roleRecord),
          sessionAccountId: explicitAccountId || roleRecord.sessionAccountId || normalizeText(binding?.accountId),
          sessionChatId: normalizeText(roleRecord.sessionChatId || binding?.chatId || binding?.threadKey),
          wechatIdentityId: explicitIdentity || roleRecord.wechatIdentityId || normalizeText(binding?.identity || 'main')
        }
      }
      return roles.find((item) => normalizeText(item?.id) === safeRoleId) || null
    },
    resolveWechatSessionAccountId(roleId = '') {
      return normalizeText(roleId) === normalizeText(roleRecord.id)
        ? normalizeText(roleRecord.sessionAccountId || binding?.accountId)
        : ''
    }
  }
}

function buildMomentsStore(threadContext = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.momentsStore && typeof safeThreadContext.momentsStore === 'object') {
    return safeThreadContext.momentsStore
  }
  return {
    posts: Array.isArray(safeThreadContext.momentPosts) ? safeThreadContext.momentPosts.map((item) => clone(item)) : []
  }
}

function buildUserStore(threadContext = null, runtimeProviders = null, contact = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.userStore && typeof safeThreadContext.userStore === 'object') {
    return safeThreadContext.userStore
  }
  return {
    userInfo: runtimeProviders?.resolveCurrentWechatUserInfo?.(contact, safeThreadContext.userInfo || null) || safeThreadContext.userInfo || {}
  }
}

function buildScheduleContext(threadContext = null, inboundUpdates = []) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const lastInbound = [...inboundUpdates].reverse().find((item) => Number(item?.createdAt || 0) > 0) || null
  const deliveredAt = Number(
    safeThreadContext.scheduleContext?.deliveredAt
    || lastInbound?.createdAt
    || Date.now()
  )
  return {
    ...(safeThreadContext.scheduleContext && typeof safeThreadContext.scheduleContext === 'object'
      ? clone(safeThreadContext.scheduleContext)
      : {}),
    deliveredAt
  }
}

function isDirectiveOnlyLine(text = '') {
  const value = normalizeText(text)
  if (!value) return false
  return /^\[[^\]]+\]$/.test(value) || /^【[^】]+】$/.test(value)
}

function normalizeRenderableReplyText(text = '') {
  return normalizeText(text)
    .replace(/^\s*\[(?:语音|voice)\]\s*/i, '')
    .replace(/^\s*\[(?:assistant|ai|助手|角色)\]\s*[:：]\s*/i, '')
    .trim()
}

function extractRenderableReplyTexts(replyAction = null) {
  if (!replyAction || typeof replyAction !== 'object') return []
  const replyMessages = Array.isArray(replyAction.replyMessages) ? replyAction.replyMessages : []
  const textsFromMessages = replyMessages
    .map((message) => normalizeRenderableReplyText(message?.originalText || message?.translatedText || message?.text))
    .filter((item) => item && !isDirectiveOnlyLine(item))
  if (textsFromMessages.length) return textsFromMessages
  return String(replyAction.replyText || replyAction.text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => normalizeRenderableReplyText(line))
    .filter((line) => line && !isDirectiveOnlyLine(line))
}

function buildOutboxMessages({
  binding = null,
  inboundUpdates = [],
  replyAction = null
} = {}) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const texts = extractRenderableReplyTexts(replyAction)
  const latestInbound = [...inboundUpdates]
    .map((item, index) => normalizeInboundUpdate(item, index))
    .reverse()
    .find((item) => item.from || item.contextToken)
  return texts.map((content, index) => ({
    threadMeta: normalizeWechatDaemonThreadMeta(safeBinding),
    to: normalizeText(latestInbound?.from || safeBinding.lastInboundFrom),
    contextToken: normalizeText(latestInbound?.contextToken || safeBinding.lastInboundContextToken),
    content,
    source: 'daemon_auto_reply',
    idempotencyKey: [
      'wechat_daemon_auto_reply',
      normalizeText(safeBinding.threadKey || safeBinding.chatId),
      normalizeText(latestInbound?.id || latestInbound?.createdAt || Date.now()),
      index
    ].filter(Boolean).join(':')
  }))
}

function buildReplyThreadContextMessages(replyAction = null) {
  const baseTimestamp = Date.now()
  const replyMessages = Array.isArray(replyAction?.replyMessages) ? replyAction.replyMessages : []
  if (replyMessages.length) {
    return replyMessages
      .map((message, index) => buildOutboundWechatMessage(message, index, baseTimestamp))
      .filter((message) => (
        message.id
        || message.originalText
        || message.text
        || message.transcript
        || message.description
      ))
  }
  return extractRenderableReplyTexts(replyAction)
    .map((text, index) => buildOutboundWechatMessage({
      type: 'text',
      originalText: text
    }, index, baseTimestamp))
}

function findReplyAction(plan = null) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : []
  return actions.find((action) => {
    if (normalizeText(action?.type) !== 'wechat_reply') return false
    return extractRenderableReplyTexts(action).length > 0
  }) || null
}

function normalizeChatCompletionEndpoint(baseUrl = '') {
  const clean = normalizeText(baseUrl || DEFAULT_MAIN_BASE_URL).replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(clean)) return clean
  if (/\/v\d+$/i.test(clean)) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
}

function buildDirectReplyMessages({ contact = null, mergedMessages = [], inboundUpdates = [] } = {}) {
  const roleName = normalizeText(contact?.remarkName || contact?.name) || '对方'
  const persona = normalizeText(contact?.persona || contact?.intro)
  const latestInbound = [...inboundUpdates]
    .map((item, index) => normalizeInboundUpdate(item, index))
    .reverse()
    .find((item) => item.content)
  const history = (Array.isArray(mergedMessages) ? mergedMessages : [])
    .slice(-18)
    .map((message) => ({
      role: normalizeText(message?.role) === 'user' ? 'user' : 'assistant',
      content: normalizeText(message?.originalText || message?.text || message?.content)
    }))
    .filter((message) => message.content)
  return [
    {
      role: 'system',
      content: [
        `你正在扮演微信聊天对象「${roleName}」。`,
        persona ? `角色设定：${persona}` : '',
        '请只输出要发给用户的微信文本，不要解释，不要加 JSON，不要加舞台说明。',
        '不要加说话人标签或角色名前缀，例如不要输出「[Assistant]:」「Assistant:」「AI:」「角色:」。',
        '回复要自然、简短、像真实聊天。',
        '如果需要分成多条微信气泡，请每条气泡单独占一行，最多 3 行。'
      ].filter(Boolean).join('\n')
    },
    ...history,
    ...(latestInbound?.content ? [{
      role: 'user',
      content: latestInbound.content
    }] : [])
  ]
}

async function callDirectReplyModel({ settingsStore = null, contact = null, mergedMessages = [], inboundUpdates = [] } = {}) {
  const endpoint = normalizeChatCompletionEndpoint(settingsStore?.baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settingsStore.apiKey}`
    },
    body: JSON.stringify({
      model: settingsStore.model,
      messages: buildDirectReplyMessages({ contact, mergedMessages, inboundUpdates }),
      temperature: 0.8
    })
  })
  if (!response.ok) {
    throw new Error(`wechat_daemon_ai_request_failed:${response.status}`)
  }
  const payload = await response.json()
  const content = normalizeText(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text)
  if (!content) throw new Error('wechat_daemon_ai_empty_reply')
  return {
    type: 'wechat_reply',
    replyText: content
  }
}

export async function probeWechatDaemonAiSettings(env = process.env, {
  binding = null,
  threadContext = null
} = {}) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : (safeBinding.threadContextSnapshot && typeof safeBinding.threadContextSnapshot === 'object'
      ? safeBinding.threadContextSnapshot
      : {})
  const baseMessages = Array.isArray(safeThreadContext.messages) ? safeThreadContext.messages : []
  const contact = buildRoleContact(safeBinding, safeThreadContext, baseMessages)
  const settingsStore = await hydrateAiSettingsFromBackgroundKey({
    env,
    settingsStore: resolveAiSettings(env, safeThreadContext),
    threadContext: safeThreadContext,
    binding: safeBinding,
    contact
  })
  const error = canUseDirectAiSettings(settingsStore)
    ? ''
    : (normalizeText(settingsStore?.backgroundAiResolutionError) || 'wechat_daemon_ai_settings_missing')
  return {
    ok: !error,
    error,
    userMessage: error ? getWechatDaemonAiResolutionUserMessage(error) : '后台 AI 配置已就绪',
    backgroundDeviceId: normalizeText(
      settingsStore?.backgroundDeviceId
      || safeThreadContext.backgroundDeviceId
      || safeThreadContext.deviceId
    )
  }
}

export function createWechatDaemonAutoReplyHandler(env = process.env) {
  return async function wechatDaemonAutoReplyHandler({
    binding = null,
    inboundUpdates = [],
    outboxStore = null,
    store = null
  } = {}) {
    const safeBinding = binding && typeof binding === 'object' ? binding : {}
    const normalizedInbound = Array.isArray(inboundUpdates)
      ? inboundUpdates.map((item, index) => normalizeInboundUpdate(item, index))
      : []
    if (!safeBinding.threadKey) {
      throw new Error('wechat_daemon_binding_missing')
    }
    if (!normalizedInbound.length) {
      throw new Error('wechat_daemon_inbound_updates_missing')
    }

    const threadContext = await loadThreadContext({
      env,
      binding: safeBinding,
      inboundUpdates: normalizedInbound,
      store,
      outboxStore
    })
    const baseMessages = Array.isArray(threadContext.messages) ? threadContext.messages : []
    const mergedMessages = mergeConversationMessages(baseMessages, normalizedInbound)
    // #region debug-point C:auto-reply-context
    fetch(REMOTE_DEBUG_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wechat-sync-lag',
        runId: 'pre-fix',
        hypothesisId: 'H4',
        location: 'server/wechatDaemonAutoReplyHandler.js:context',
        msg: '[DEBUG] auto reply loaded thread context',
        data: {
          threadKey: safeBinding.threadKey,
          inboundCount: normalizedInbound.length,
          baseMessageCount: baseMessages.length,
          mergedMessageCount: mergedMessages.length,
          snapshotUpdatedAt: Number(threadContext?.updatedAt || safeBinding?.threadContextUpdatedAt || 0),
          latestInboundId: normalizeText(normalizedInbound[normalizedInbound.length - 1]?.id),
          latestInboundText: normalizeText(normalizedInbound[normalizedInbound.length - 1]?.content).slice(0, 80),
          latestMergedText: normalizeText(mergedMessages[mergedMessages.length - 1]?.text || mergedMessages[mergedMessages.length - 1]?.originalText || mergedMessages[mergedMessages.length - 1]?.content).slice(0, 80)
        },
        ts: Date.now()
      })
    }).catch(() => {})
    // #endregion
    const contact = buildRoleContact(safeBinding, threadContext, mergedMessages)
    const settingsStore = await hydrateAiSettingsFromBackgroundKey({
      env,
      settingsStore: resolveAiSettings(env, threadContext),
      threadContext,
      binding: safeBinding,
      contact
    })
    const canUseDirectProvider = canUseDirectAiSettings(settingsStore)
    if (!canUseDirectProvider) {
      throw new Error(normalizeText(settingsStore?.backgroundAiResolutionError) || 'wechat_daemon_ai_settings_missing')
    }

    let plan = null
    let replyAction = null
    if (canUseDirectProvider) {
      try {
        const sharedModules = await loadSharedModules(env)
        const runtimeProviders = sharedModules.createAutoBrainServerRuntimeProviders({
          env,
          threadContext,
          sharedModules
        })
        const roleStore = buildRoleStore(safeBinding, threadContext, contact)
        const userStore = buildUserStore(threadContext, runtimeProviders, contact)
        plan = await sharedModules.autoBrainService.decideAutoActions({
          settingsStore,
          userStore,
          roleStore,
          momentsStore: buildMomentsStore(threadContext),
          contact,
          messages: { value: mergedMessages },
          customStickers: Array.isArray(threadContext.customStickers) ? threadContext.customStickers : [],
          avatarPresets: Array.isArray(threadContext.avatarPresets) ? threadContext.avatarPresets : [],
          worldBookEntries: Array.isArray(threadContext.worldBookEntries) ? threadContext.worldBookEntries : [],
          scheduleContext: buildScheduleContext(threadContext, normalizedInbound),
          replyStrategyContext: threadContext.replyStrategyContext && typeof threadContext.replyStrategyContext === 'object'
            ? clone(threadContext.replyStrategyContext)
            : null,
          directVisionMessage: threadContext.directVisionMessage && typeof threadContext.directVisionMessage === 'object'
            ? clone(threadContext.directVisionMessage)
            : null,
          debugSource: 'wechat_daemon_auto_reply',
          runtimeProviders
        })
        replyAction = findReplyAction(plan)
      } catch (error) {
        if (normalizeText(env.WECHAT_DAEMON_DISABLE_DIRECT_AI_FALLBACK) === '1') {
          throw error
        }
      }
    }

    if (!replyAction) {
      replyAction = await callDirectReplyModel({
        settingsStore,
        contact,
        mergedMessages,
        inboundUpdates: normalizedInbound
      })
    }

    if (!replyAction) {
      throw new Error('wechat_daemon_auto_reply_missing_renderable_reply')
    }
    // #region debug-point C:auto-reply-result
    fetch(REMOTE_DEBUG_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wechat-sync-lag',
        runId: 'pre-fix',
        hypothesisId: 'H4',
        location: 'server/wechatDaemonAutoReplyHandler.js:reply',
        msg: '[DEBUG] auto reply generated reply action',
        data: {
          threadKey: safeBinding.threadKey,
          replyText: extractRenderableReplyTexts(replyAction).join(' | ').slice(0, 160),
          actionType: normalizeText(replyAction?.type),
          hasPlan: !!plan
        },
        ts: Date.now()
      })
    }).catch(() => {})
    // #endregion

    const outboxMessages = buildOutboxMessages({
      binding: safeBinding,
      inboundUpdates: normalizedInbound,
      replyAction
    })
    if (!outboxMessages.length) {
      throw new Error('wechat_daemon_auto_reply_empty_outbox')
    }
    const queuedMessages = []
    for (const message of outboxMessages) {
      const queued = await outboxStore.enqueueMessage(message)
      if (queued?.id) queuedMessages.push(queued)
    }
    if (!queuedMessages.length) {
      throw new Error('wechat_daemon_auto_reply_not_queued')
    }

    if (store && typeof store.appendThreadContextMessages === 'function') {
      const nextThreadMessages = [
        ...normalizedInbound.map((item, index) => buildInboundWechatMessage(item, index)),
        ...buildReplyThreadContextMessages(replyAction)
      ]
      if (nextThreadMessages.length) {
        await store.appendThreadContextMessages(safeBinding.threadKey, nextThreadMessages, {
          updatedAt: Date.now()
        }).catch((error) => {
          console.warn('[wechat-daemon] append thread context messages failed', {
            threadKey: safeBinding.threadKey,
            error
          })
        })
      }
    }

    return {
      queued: true,
      outboxMessages: queuedMessages,
      actions: Array.isArray(plan?.actions) ? plan.actions : []
    }
  }
}
