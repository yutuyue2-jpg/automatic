import fs from 'node:fs/promises'
import path from 'node:path'

const STORE_VERSION = 1
const DEFAULT_STORE_RELATIVE_PATH = path.join('data', 'wechat-daemon-store.json')
const KV_STORE_KEY = 'wechat-daemon-store:v1'
const THREAD_CONTEXT_MESSAGE_LIMIT = 80
const THREAD_CONTEXT_MOMENT_LIMIT = 12
const THREAD_CONTEXT_EVENT_LIMIT = 20
const THREAD_CONTEXT_STICKER_LIMIT = 24
const THREAD_CONTEXT_AVATAR_LIMIT = 24
const THREAD_CONTEXT_WORLD_BOOK_LIMIT = 48
const RECENT_INBOUND_UPDATE_LIMIT = 40

const normalizeText = (value = '') => String(value || '').trim()
const REMOTE_DEBUG_EVENT_URL = 'https://ai-phone-background.yutuyue2.workers.dev/debug/event'

const normalizeIdentity = (value = '') => normalizeText(value) === 'sub' ? 'sub' : 'main'

const normalizeBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback
  return value === true
}

const normalizeInteger = (value, fallback = 0, min = 0, max = 86400) => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const normalizeAutoReplyState = (value = '') => {
  const state = normalizeText(value)
  return ['idle', 'waiting_quiet', 'ready', 'processing'].includes(state)
    ? state
    : 'idle'
}

const normalizeTimestamp = (value = 0) => {
  const parsed = Number(value || 0)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed < 100000000000 ? parsed * 1000 : parsed
}

const normalizeInboundUpdate = (update = {}) => {
  const safe = update && typeof update === 'object' ? update : {}
  return {
    id: normalizeText(safe.id || safe.messageId || safe.msgId),
    type: normalizeText(safe.type || 'text') || 'text',
    content: normalizeText(safe.content || safe.text || safe.message),
    from: normalizeText(safe.from),
    contextToken: normalizeText(safe.contextToken || safe.context_token),
    createdAt: normalizeTimestamp(safe.createdAt),
  }
}

const normalizeInboundUpdates = (updates = []) => Array.isArray(updates)
  ? updates
    .map((item) => normalizeInboundUpdate(item))
    .filter((item) => item.id || item.content)
  : []

const mergeInboundUpdates = (existing = [], incoming = []) => {
  const map = new Map()
  normalizeInboundUpdates(existing).forEach((item) => {
    const key = item.id || `${item.from}:${item.createdAt}:${item.content}`
    if (key) map.set(key, item)
  })
  normalizeInboundUpdates(incoming).forEach((item) => {
    const key = item.id || `${item.from}:${item.createdAt}:${item.content}`
    if (key) map.set(key, item)
  })
  return Array.from(map.values())
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
    .slice(-100)
}

const mergeRecentInboundUpdates = (existing = [], incoming = []) => mergeInboundUpdates(existing, incoming)
  .slice(-RECENT_INBOUND_UPDATE_LIMIT)

const resolveAutoReplyStateFromPending = ({
  pendingCount = 0,
  quietSeconds = 0,
  quietUntilAt = 0,
  now = Date.now()
} = {}) => {
  const safePendingCount = Math.max(0, Number(pendingCount || 0))
  if (safePendingCount <= 0) return 'idle'
  const safeQuietSeconds = Math.max(0, Number(quietSeconds || 0))
  if (safeQuietSeconds <= 0) return 'ready'
  return Number(quietUntilAt || 0) > now ? 'waiting_quiet' : 'ready'
}

const clone = (value) => JSON.parse(JSON.stringify(value))

const normalizeThreadContextMessage = (message = {}) => {
  const safe = message && typeof message === 'object' ? message : {}
  return {
    id: normalizeText(safe.id),
    role: normalizeText(safe.role),
    type: normalizeText(safe.type || 'text') || 'text',
    text: normalizeText(safe.text),
    originalText: normalizeText(safe.originalText),
    translatedText: normalizeText(safe.translatedText),
    transcript: normalizeText(safe.transcript),
    description: normalizeText(safe.description),
    timestamp: Math.max(0, Number(safe.timestamp || 0)),
    amount: normalizeText(safe.amount),
    status: normalizeText(safe.status)
  }
}

const buildThreadContextMessageKey = (message = {}) => [
  normalizeText(message?.id),
  normalizeText(message?.role),
  normalizeText(message?.type),
  normalizeText(
    message?.id
    || message?.originalText
    || message?.text
    || message?.translatedText
    || message?.transcript
    || message?.description
    || message?.id
  ),
  Math.max(0, Number(message?.timestamp || 0)),
  normalizeText(message?.amount),
  normalizeText(message?.status)
].join('|')

const mergeThreadContextMessages = (existing = [], incoming = []) => {
  const merged = []
  const existingKeys = new Set()
  ;[...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
    .map((item) => normalizeThreadContextMessage(item))
    .filter((item) => item.id || item.originalText || item.text || item.transcript || item.description)
    .forEach((item) => {
      const key = buildThreadContextMessageKey(item)
      if (!key || existingKeys.has(key)) return
      existingKeys.add(key)
      merged.push(item)
    })
  return merged
    .sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0))
    .slice(-THREAD_CONTEXT_MESSAGE_LIMIT)
}

const normalizeThreadContextEvent = (event = {}) => {
  const safe = event && typeof event === 'object' ? event : {}
  return {
    kind: normalizeText(safe.kind || safe.type),
    type: normalizeText(safe.type || safe.kind),
    text: normalizeText(safe.text),
    ts: Math.max(0, Number(safe.ts || safe.timestamp || 0)),
    timestamp: Math.max(0, Number(safe.timestamp || safe.ts || 0)),
    trigger: normalizeText(safe.trigger),
    commentText: normalizeText(safe.commentText),
    privateMessageText: normalizeText(safe.privateMessageText),
    replyToName: normalizeText(safe.replyToName),
    socialTargetMode: normalizeText(safe.socialTargetMode)
  }
}

const normalizeThreadContextContact = (contact = {}) => {
  const safe = contact && typeof contact === 'object' ? contact : {}
  return {
    id: normalizeText(safe.id),
    name: normalizeText(safe.name),
    remarkName: normalizeText(safe.remarkName),
    intro: normalizeText(safe.intro),
    persona: normalizeText(safe.persona),
    textLanguage: normalizeText(safe.textLanguage),
    voiceLanguage: normalizeText(safe.voiceLanguage),
    injectGroupContext: safe.injectGroupContext !== false,
    allowAiNudge: safe.allowAiNudge === true,
    allowMoments: safe.allowMoments === true,
    timeAware: safe.timeAware === true,
    chatTimeAwareness: safe.chatTimeAwareness !== false,
    timezoneAwareness: safe.timezoneAwareness === true,
    weatherAwareness: safe.weatherAwareness === true,
    roleTimeZone: normalizeText(safe.roleTimeZone),
    contextMessageCount: Math.max(0, Number(safe.contextMessageCount || 0)),
    contextEventCount: Math.max(0, Number(safe.contextEventCount || 0)),
    minReplyCount: Math.max(0, Number(safe.minReplyCount || 0)),
    maxReplyCount: Math.max(0, Number(safe.maxReplyCount || 0)),
    sessionAccountId: normalizeText(safe.sessionAccountId),
    sessionChatId: normalizeText(safe.sessionChatId),
    wechatIdentityId: normalizeText(safe.wechatIdentityId || 'main') || 'main',
    wechatIdentityDisplayName: normalizeText(safe.wechatIdentityDisplayName),
    wechatIdentityAccountDescription: normalizeText(safe.wechatIdentityAccountDescription),
    wechatIdentityInstruction: normalizeText(safe.wechatIdentityInstruction),
    lastMomentPostedAt: Math.max(0, Number(safe.lastMomentPostedAt || 0)),
    lastMomentAt: Math.max(0, Number(safe.lastMomentAt || 0)),
    aiImageSettings: safe.aiImageSettings && typeof safe.aiImageSettings === 'object'
      ? {
          enabled: safe.aiImageSettings.enabled === true,
          portraitPrompt: normalizeText(safe.aiImageSettings.portraitPrompt),
          basePrompt: normalizeText(safe.aiImageSettings.basePrompt)
        }
      : { enabled: false, portraitPrompt: '', basePrompt: '' },
    memory: safe.memory && typeof safe.memory === 'object'
      ? clone(safe.memory)
      : {},
    recentEvents: Array.isArray(safe.recentEvents)
      ? safe.recentEvents.map((item) => normalizeThreadContextEvent(item)).slice(0, THREAD_CONTEXT_EVENT_LIMIT)
      : []
  }
}

const normalizeThreadContextMomentPost = (post = {}) => {
  const safe = post && typeof post === 'object' ? post : {}
  return {
    id: normalizeText(safe.id),
    createdAt: Math.max(0, Number(safe.createdAt || 0)),
    updatedAt: Math.max(0, Number(safe.updatedAt || 0)),
    isMe: safe.isMe === true,
    postOwnerId: normalizeText(safe.postOwnerId || safe.authorId),
    authorId: normalizeText(safe.authorId || safe.postOwnerId),
    name: normalizeText(safe.name),
    text: normalizeText(safe.text),
    originalText: normalizeText(safe.originalText),
    translatedText: normalizeText(safe.translatedText),
    imageDesc: normalizeText(safe.imageDesc),
    likes: Array.isArray(safe.likes) ? safe.likes.slice(0, 12).map((item) => (
      typeof item === 'string' ? normalizeText(item) : { name: normalizeText(item?.name) }
    )) : [],
    comments: Array.isArray(safe.comments) ? safe.comments.slice(0, 12).map((item) => ({
      name: normalizeText(item?.name),
      replyTo: normalizeText(item?.replyTo),
      text: normalizeText(item?.text),
      originalText: normalizeText(item?.originalText),
      translatedText: normalizeText(item?.translatedText)
    })) : []
  }
}

const normalizeThreadContextSticker = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  return {
    id: normalizeText(safe.id),
    name: normalizeText(safe.name),
    desc: normalizeText(safe.desc),
    category: normalizeText(safe.category)
  }
}

const normalizeThreadContextAvatarPreset = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  return {
    id: normalizeText(safe.id),
    title: normalizeText(safe.title),
    desc: normalizeText(safe.desc)
  }
}

const normalizeThreadContextWorldBookEntry = (item = {}) => {
  const safe = item && typeof item === 'object' ? item : {}
  return {
    id: normalizeText(safe.id),
    title: normalizeText(safe.title),
    content: normalizeText(safe.content).slice(0, 2400),
    keys: Array.isArray(safe.keys) ? safe.keys.map((key) => normalizeText(key)).filter(Boolean).slice(0, 24) : []
  }
}

const normalizeThreadContextSettingsStore = (settings = {}) => {
  const safe = settings && typeof settings === 'object' ? settings : {}
  return {
    baseUrl: normalizeText(safe.baseUrl),
    model: normalizeText(safe.model),
    modelTemperatureSettings: safe.modelTemperatureSettings && typeof safe.modelTemperatureSettings === 'object'
      ? clone(safe.modelTemperatureSettings)
      : {}
  }
}

const normalizeThreadContextSnapshot = (snapshot = {}) => {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    backgroundDeviceId: normalizeText(safe.backgroundDeviceId || safe.deviceId),
    deviceId: normalizeText(safe.deviceId || safe.backgroundDeviceId),
    accountName: normalizeText(safe.accountName),
    wechatAccountName: normalizeText(safe.wechatAccountName || safe.accountName),
    settingsStore: normalizeThreadContextSettingsStore(safe.settingsStore),
    userTimeZone: normalizeText(safe.userTimeZone),
    userInfo: safe.userInfo && typeof safe.userInfo === 'object'
      ? clone(safe.userInfo)
      : {},
    contact: normalizeThreadContextContact(safe.contact),
    messages: Array.isArray(safe.messages)
      ? safe.messages.map((item) => normalizeThreadContextMessage(item)).slice(-THREAD_CONTEXT_MESSAGE_LIMIT)
      : [],
    momentPosts: Array.isArray(safe.momentPosts)
      ? safe.momentPosts.map((item) => normalizeThreadContextMomentPost(item)).slice(0, THREAD_CONTEXT_MOMENT_LIMIT)
      : [],
    customStickers: Array.isArray(safe.customStickers)
      ? safe.customStickers.map((item) => normalizeThreadContextSticker(item)).slice(0, THREAD_CONTEXT_STICKER_LIMIT)
      : [],
    avatarPresets: Array.isArray(safe.avatarPresets)
      ? safe.avatarPresets.map((item) => normalizeThreadContextAvatarPreset(item)).slice(0, THREAD_CONTEXT_AVATAR_LIMIT)
      : [],
    worldBookEntries: Array.isArray(safe.worldBookEntries)
      ? safe.worldBookEntries.map((item) => normalizeThreadContextWorldBookEntry(item)).slice(0, THREAD_CONTEXT_WORLD_BOOK_LIMIT)
      : [],
    replyStrategyContext: safe.replyStrategyContext && typeof safe.replyStrategyContext === 'object'
      ? clone(safe.replyStrategyContext)
      : null,
    scheduleContext: safe.scheduleContext && typeof safe.scheduleContext === 'object'
      ? clone(safe.scheduleContext)
      : null,
    directVisionMessage: safe.directVisionMessage && typeof safe.directVisionMessage === 'object'
      ? clone(safe.directVisionMessage)
      : null
  }
}

const resolveStorePath = (env = process.env) => {
  const configured = normalizeText(env.WECHAT_DAEMON_STORE_FILE)
  return path.resolve(configured || DEFAULT_STORE_RELATIVE_PATH)
}

export const buildWechatDaemonThreadKey = ({
  accountId = '',
  roleId = '',
  identity = 'main',
  chatId = ''
} = {}) => {
  const safeAccountId = normalizeText(accountId)
  const safeRoleId = normalizeText(roleId)
  const safeIdentity = normalizeIdentity(identity)
  const safeChatId = normalizeText(chatId)
  if (safeChatId) return safeChatId
  return [safeAccountId, safeRoleId, safeIdentity].filter(Boolean).join(':')
}

export const normalizeWechatDaemonThreadMeta = (threadMeta = {}) => {
  const safe = threadMeta && typeof threadMeta === 'object' ? threadMeta : {}
  const roleId = normalizeText(safe.roleId)
  const accountId = normalizeText(safe.accountId)
  const identity = normalizeIdentity(safe.identity)
  const chatId = normalizeText(safe.chatId)
  return {
    roleId,
    accountId,
    identity,
    chatId,
    threadKey: buildWechatDaemonThreadKey({ accountId, roleId, identity, chatId }),
    wechatReplyTriggersAi: normalizeBoolean(safe.wechatReplyTriggersAi, true),
    pwaChatToWechat: normalizeBoolean(safe.pwaChatToWechat, false),
    quietSeconds: normalizeInteger(safe.quietSeconds, 0, 0, 3600)
  }
}

const createEmptyStoreData = () => ({
  version: STORE_VERSION,
  updatedAt: Date.now(),
  bindings: []
})

const normalizeBindingRecord = (record = {}) => {
  const safe = record && typeof record === 'object' ? record : {}
  const threadMeta = normalizeWechatDaemonThreadMeta(safe.threadMeta || safe)
  return {
    threadKey: threadMeta.threadKey,
    roleId: threadMeta.roleId,
    accountId: threadMeta.accountId,
    identity: threadMeta.identity,
    chatId: threadMeta.chatId,
    wechatReplyTriggersAi: threadMeta.wechatReplyTriggersAi,
    pwaChatToWechat: threadMeta.pwaChatToWechat,
    quietSeconds: threadMeta.quietSeconds,
    status: normalizeText(safe.status) || 'unbound',
    bridgeType: normalizeText(safe.bridgeType) || 'ilink',
    bridgeUrl: normalizeText(safe.bridgeUrl),
    bindingId: normalizeText(safe.bindingId),
    remoteBindingId: normalizeText(safe.remoteBindingId || safe.bindingId),
    sessionId: normalizeText(safe.sessionId),
    externalAccountId: normalizeText(safe.externalAccountId),
    externalAccountName: normalizeText(safe.externalAccountName),
    lastError: normalizeText(safe.lastError),
    lastLoginStartedAt: Math.max(0, Number(safe.lastLoginStartedAt || 0)),
    lastStatusCheckedAt: Math.max(0, Number(safe.lastStatusCheckedAt || 0)),
    lastSyncedAt: Math.max(0, Number(safe.lastSyncedAt || 0)),
    lastSentAt: Math.max(0, Number(safe.lastSentAt || 0)),
    lastInboundAt: Math.max(0, Number(safe.lastInboundAt || 0)),
    lastInboundFrom: normalizeText(safe.lastInboundFrom),
    lastInboundContextToken: normalizeText(safe.lastInboundContextToken),
    quietUntilAt: Math.max(0, Number(safe.quietUntilAt || 0)),
    autoReplyState: normalizeAutoReplyState(safe.autoReplyState),
    lastAutoReplyReadyAt: Math.max(0, Number(safe.lastAutoReplyReadyAt || 0)),
    lastAutoReplyStartedAt: Math.max(0, Number(safe.lastAutoReplyStartedAt || 0)),
    lastAutoReplyQueuedAt: Math.max(0, Number(safe.lastAutoReplyQueuedAt || 0)),
    lastAutoReplyCompletedAt: Math.max(0, Number(safe.lastAutoReplyCompletedAt || 0)),
    nextAutoReplyAttemptAt: Math.max(0, Number(safe.nextAutoReplyAttemptAt || 0)),
    autoReplyAttemptCount: Math.max(0, Number(safe.autoReplyAttemptCount || 0)),
    autoReplyLastError: normalizeText(safe.autoReplyLastError),
    threadContextSnapshot: normalizeThreadContextSnapshot(safe.threadContextSnapshot),
    threadContextUpdatedAt: Math.max(
      0,
      Number(safe.threadContextUpdatedAt || safe.threadContextSnapshot?.updatedAt || 0)
    ),
    recentInboundUpdates: mergeRecentInboundUpdates(safe.recentInboundUpdates),
    pendingInboundUpdates: normalizeInboundUpdates(safe.pendingInboundUpdates),
    pendingInboundCount: normalizeInboundUpdates(safe.pendingInboundUpdates).length,
    processingInboundUpdates: normalizeInboundUpdates(safe.processingInboundUpdates),
    processingInboundCount: normalizeInboundUpdates(safe.processingInboundUpdates).length,
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now()))
  }
}

async function ensureParentDir(filePath = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

function hasKvStore(env = process.env) {
  return Boolean(
    env?.PROACTIVE_KV
    && typeof env.PROACTIVE_KV.get === 'function'
    && typeof env.PROACTIVE_KV.put === 'function'
  )
}

async function readStoreFile(filePath = '') {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    const bindings = Array.isArray(parsed?.bindings)
      ? parsed.bindings.map((item) => normalizeBindingRecord(item)).filter((item) => item.threadKey)
      : []
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      bindings
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyStoreData()
    throw error
  }
}

async function writeStoreFile(filePath = '', data = {}) {
  const payload = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    bindings: Array.isArray(data?.bindings) ? data.bindings.map((item) => normalizeBindingRecord(item)) : []
  }
  await ensureParentDir(filePath)
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
  return payload
}

async function readStoreData(env = process.env, filePath = '') {
  if (hasKvStore(env)) {
    const raw = await env.PROACTIVE_KV.get(KV_STORE_KEY)
    if (!raw) return createEmptyStoreData()
    const parsed = JSON.parse(raw)
    const bindings = Array.isArray(parsed?.bindings)
      ? parsed.bindings.map((item) => normalizeBindingRecord(item)).filter((item) => item.threadKey)
      : []
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      bindings
    }
  }
  return readStoreFile(filePath)
}

async function writeStoreData(env = process.env, filePath = '', data = {}) {
  if (hasKvStore(env)) {
    const payload = {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      bindings: Array.isArray(data?.bindings) ? data.bindings.map((item) => normalizeBindingRecord(item)) : []
    }
    await env.PROACTIVE_KV.put(KV_STORE_KEY, JSON.stringify(payload))
    return payload
  }
  return writeStoreFile(filePath, data)
}

export function createWechatDaemonStore(env = process.env) {
  const filePath = resolveStorePath(env)
  const storageLabel = hasKvStore(env) ? `kv:${KV_STORE_KEY}` : filePath
  let cache = null
  let pendingWrite = Promise.resolve()

  const load = async (force = false) => {
    if (!force && cache && !hasKvStore(env)) return cache
    cache = await readStoreData(env, filePath)
    return cache
  }

  const persist = async () => {
    const current = cache || await load()
    pendingWrite = pendingWrite.then(() => writeStoreData(env, filePath, current))
    cache = await pendingWrite
    return cache
  }

  const listBindings = async () => {
    const current = await load()
    return clone(current.bindings || [])
  }

  const getBindingByThreadKey = async (threadKey = '') => {
    const safeThreadKey = normalizeText(threadKey)
    if (!safeThreadKey) return null
    const bindings = await listBindings()
    return bindings.find((item) => item.threadKey === safeThreadKey) || null
  }

  const upsertBinding = async (input = {}) => {
    const nextRecord = normalizeBindingRecord(input)
    if (!nextRecord.threadKey) return null
    const current = await load()
    const index = current.bindings.findIndex((item) => item.threadKey === nextRecord.threadKey)
    if (index >= 0) {
      current.bindings[index] = normalizeBindingRecord({
        ...current.bindings[index],
        ...nextRecord,
        createdAt: current.bindings[index].createdAt || nextRecord.createdAt,
        updatedAt: Date.now()
      })
    } else {
      current.bindings.unshift(normalizeBindingRecord({
        ...nextRecord,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }))
    }
    await persist()
    return getBindingByThreadKey(nextRecord.threadKey)
  }

  const patchBinding = async (threadMeta = {}, patch = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    if (!normalizedMeta.threadKey) return null
    const existing = await getBindingByThreadKey(normalizedMeta.threadKey)
    const mergedInboundUpdates = patch?.pendingInboundUpdates !== undefined
      ? mergeInboundUpdates(existing?.pendingInboundUpdates || [], patch.pendingInboundUpdates)
      : (existing?.pendingInboundUpdates || [])
    return upsertBinding({
      ...(existing || {}),
      ...normalizedMeta,
      ...(patch && typeof patch === 'object' ? patch : {}),
      pendingInboundUpdates: mergedInboundUpdates,
      threadMeta: normalizedMeta
    })
  }

  const appendInboundUpdates = async (threadMeta = {}, updates = [], options = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    if (!normalizedMeta.threadKey) return null
    const existing = await getBindingByThreadKey(normalizedMeta.threadKey)
    const mergedUpdates = mergeInboundUpdates(existing?.pendingInboundUpdates || [], updates)
    const recentInboundUpdates = mergeRecentInboundUpdates(existing?.recentInboundUpdates || [], updates)
    const now = Date.now()
    const quietSeconds = normalizedMeta.quietSeconds
    const latestInbound = [...mergedUpdates].reverse().find((item) => item.from || item.contextToken) || null
    const quietUntilAt = mergedUpdates.length
      ? now + (Math.max(0, quietSeconds) * 1000)
      : 0
    const autoReplyState = resolveAutoReplyStateFromPending({
      pendingCount: mergedUpdates.length,
      quietSeconds,
      quietUntilAt,
      now
    })
    // #region debug-point A:store-inbound-state
    fetch(REMOTE_DEBUG_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wechat-sync-lag',
        runId: 'pre-fix',
        hypothesisId: 'H2',
        location: 'server/wechatDaemonStore.js:appendInboundUpdates',
        msg: '[DEBUG] daemon store appended inbound updates',
        data: {
          threadKey: normalizedMeta.threadKey,
          pendingInboundCount: mergedUpdates.length,
          quietSeconds,
          quietUntilAt,
          autoReplyState,
          latestInboundFrom: normalizeText(latestInbound?.from),
          latestInboundId: normalizeText(latestInbound?.id),
          hasContextToken: !!normalizeText(latestInbound?.contextToken)
        },
        ts: Date.now()
      })
    }).catch(() => {})
    // #endregion
    return upsertBinding({
      ...(existing || {}),
      ...normalizedMeta,
      ...(options && typeof options === 'object' ? options : {}),
      recentInboundUpdates,
      pendingInboundUpdates: mergedUpdates,
      lastInboundFrom: normalizeText(latestInbound?.from || existing?.lastInboundFrom),
      lastInboundContextToken: normalizeText(latestInbound?.contextToken || existing?.lastInboundContextToken),
      quietUntilAt,
      autoReplyState,
      lastAutoReplyReadyAt: autoReplyState === 'ready' ? now : Math.max(0, Number(existing?.lastAutoReplyReadyAt || 0)),
      threadMeta: normalizedMeta
    })
  }

  const appendThreadContextMessages = async (threadKey = '', messages = [], options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const currentSnapshot = normalizeThreadContextSnapshot(existing.threadContextSnapshot)
    const mergedMessages = mergeThreadContextMessages(currentSnapshot.messages, messages)
    const nextUpdatedAt = Math.max(
      0,
      Number(options?.updatedAt || Date.now())
    )
    const snapshotPatch = options?.snapshotPatch && typeof options.snapshotPatch === 'object'
      ? options.snapshotPatch
      : {}
    return upsertBinding({
      ...existing,
      ...(options?.bindingPatch && typeof options.bindingPatch === 'object' ? options.bindingPatch : {}),
      threadContextSnapshot: {
        ...currentSnapshot,
        ...snapshotPatch,
        updatedAt: nextUpdatedAt,
        messages: mergedMessages
      },
      threadContextUpdatedAt: nextUpdatedAt
    })
  }

  const markAutoReplyReady = async (threadKey = '') => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    // #region debug-point A:mark-ready
    fetch(REMOTE_DEBUG_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wechat-sync-lag',
        runId: 'pre-fix',
        hypothesisId: 'H2',
        location: 'server/wechatDaemonStore.js:markAutoReplyReady',
        msg: '[DEBUG] daemon thread marked ready',
        data: {
          threadKey: existing.threadKey,
          pendingInboundCount: Number(existing.pendingInboundCount || 0),
          quietUntilAt: Number(existing.quietUntilAt || 0),
          previousState: normalizeText(existing.autoReplyState || '')
        },
        ts: Date.now()
      })
    }).catch(() => {})
    // #endregion
    return upsertBinding({
      ...existing,
      autoReplyState: existing.pendingInboundCount > 0 ? 'ready' : 'idle',
      quietUntilAt: existing.pendingInboundCount > 0 ? existing.quietUntilAt : 0,
      lastAutoReplyReadyAt: existing.pendingInboundCount > 0 ? Date.now() : existing.lastAutoReplyReadyAt
    })
  }

  const claimAutoReplyThread = async (threadKey = '') => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    if (normalizeAutoReplyState(existing.autoReplyState) !== 'ready') return null
    const claimedUpdates = normalizeInboundUpdates(existing.pendingInboundUpdates)
    if (!claimedUpdates.length) return null
    // #region debug-point A:claim-ready-thread
    fetch(REMOTE_DEBUG_EVENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wechat-sync-lag',
        runId: 'pre-fix',
        hypothesisId: 'H2',
        location: 'server/wechatDaemonStore.js:claimAutoReplyThread',
        msg: '[DEBUG] daemon claimed ready thread',
        data: {
          threadKey: existing.threadKey,
          pendingInboundCount: claimedUpdates.length,
          lastInboundFrom: normalizeText(existing.lastInboundFrom),
          lastInboundContextToken: normalizeText(existing.lastInboundContextToken),
          firstClaimedUpdateId: normalizeText(claimedUpdates[0]?.id),
          lastClaimedUpdateId: normalizeText(claimedUpdates[claimedUpdates.length - 1]?.id),
          hasContextToken: !!normalizeText(existing.lastInboundContextToken)
        },
        ts: Date.now()
      })
    }).catch(() => {})
    // #endregion
    return upsertBinding({
      ...existing,
      pendingInboundUpdates: [],
      processingInboundUpdates: claimedUpdates,
      autoReplyState: 'processing',
      quietUntilAt: 0,
      lastAutoReplyStartedAt: Date.now(),
      autoReplyLastError: '',
      nextAutoReplyAttemptAt: 0
    })
  }

  const completeAutoReplyThread = async (threadKey = '', options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const now = Date.now()
    const remainingPendingUpdates = normalizeInboundUpdates(existing.pendingInboundUpdates)
    const nextQuietUntilAt = remainingPendingUpdates.length ? Math.max(0, Number(existing.quietUntilAt || 0)) : 0
    const nextAutoReplyState = resolveAutoReplyStateFromPending({
      pendingCount: remainingPendingUpdates.length,
      quietSeconds: existing.quietSeconds,
      quietUntilAt: nextQuietUntilAt,
      now
    })
    return upsertBinding({
      ...existing,
      ...(options && typeof options === 'object' ? options : {}),
      processingInboundUpdates: [],
      autoReplyState: nextAutoReplyState,
      quietUntilAt: nextAutoReplyState === 'waiting_quiet' ? nextQuietUntilAt : 0,
      lastAutoReplyQueuedAt: Math.max(
        0,
        Number(options?.lastAutoReplyQueuedAt || options?.queuedAt || now)
      ),
      lastAutoReplyCompletedAt: now,
      nextAutoReplyAttemptAt: 0,
      autoReplyAttemptCount: 0,
      autoReplyLastError: ''
    })
  }

  const failAutoReplyThread = async (threadKey = '', options = {}) => {
    const existing = await getBindingByThreadKey(threadKey)
    if (!existing?.threadKey) return null
    const now = Date.now()
    const mergedPendingUpdates = mergeInboundUpdates(
      existing.pendingInboundUpdates,
      existing.processingInboundUpdates
    )
    const retryDelayMs = Math.max(0, Number(options?.retryDelayMs || 0))
    const nextAttemptAt = mergedPendingUpdates.length ? now + retryDelayMs : 0
    return upsertBinding({
      ...existing,
      ...(options && typeof options === 'object' ? options : {}),
      pendingInboundUpdates: mergedPendingUpdates,
      processingInboundUpdates: [],
      autoReplyState: mergedPendingUpdates.length ? 'ready' : 'idle',
      quietUntilAt: 0,
      lastAutoReplyCompletedAt: now,
      nextAutoReplyAttemptAt: nextAttemptAt,
      autoReplyAttemptCount: mergedPendingUpdates.length
        ? Math.max(0, Number(existing.autoReplyAttemptCount || 0)) + 1
        : 0,
      autoReplyLastError: normalizeText(options?.autoReplyLastError || options?.lastError || '')
    })
  }

  const removeBinding = async (threadMeta = {}, options = {}) => {
    const normalizedMeta = normalizeWechatDaemonThreadMeta(threadMeta)
    const safeBindingId = normalizeText(options.bindingId)
    const current = await load()
    const before = current.bindings.length
    current.bindings = current.bindings.filter((item) => {
      if (normalizedMeta.threadKey && item.threadKey === normalizedMeta.threadKey) return false
      if (safeBindingId && normalizeText(item.bindingId) === safeBindingId) return false
      return true
    })
    if (current.bindings.length === before) return false
    await persist()
    return true
  }

  return {
    filePath: storageLabel,
    load,
    listBindings,
    getBindingByThreadKey,
    upsertBinding,
    patchBinding,
    appendInboundUpdates,
    appendThreadContextMessages,
    markAutoReplyReady,
    claimAutoReplyThread,
    completeAutoReplyThread,
    failAutoReplyThread,
    removeBinding,
  }
}

let defaultStore = null

export function getWechatDaemonStore(env = process.env) {
  if (!defaultStore) {
    defaultStore = createWechatDaemonStore(env)
  }
  return defaultStore
}
