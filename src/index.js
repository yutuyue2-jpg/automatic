import webpush from 'web-push'
import { handleWechatBridgeProxy } from './wechat/wechatBridgeProxy.js'
import { createWechatDaemonAutoReplyHandler } from './wechat/wechatDaemonAutoReplyHandler.js'
import { createWechatDaemonRuntime } from './wechat/wechatDaemonRuntime.js'
import {
  PROACTIVE_PENDING_LIMIT as SHARED_PROACTIVE_PENDING_LIMIT,
  buildProactiveRequestMessages,
  calculateProactiveDelay as sharedCalculateProactiveDelay,
  chooseProactiveRole as sharedChooseProactiveRole,
  findLatestProactiveUserMessage,
  getLocalHourInTimeZone,
  formatProactiveLocalTimeText,
  formatProactiveMessagesForLLM,
  shouldRunProactiveForRole as sharedShouldRunProactiveForRole,
} from './proactive/proactiveRules.js'

const OWNER_USER_ID = 'owner'
const TEXT_CONTENT_TYPE = 'text'
const RUNTIME_VERSION = '0.1.0'
const MAX_SNAPSHOT_BYTES = 120 * 1024
const MAX_DEVICES_PER_CRON = 80
const DEFAULT_MAX_GENERATIONS_PER_CRON = 8
const PROACTIVE_PENDING_LIMIT = SHARED_PROACTIVE_PENDING_LIMIT
const MAX_INTERNAL_CHAT_MESSAGES = 64
const DEVICE_INDEX_KEY = 'devices:index'
const VAPID_KEYPAIR_KEY = 'vapid:keypair'
const SNAPSHOT_PREFIX = 'snapshot:'
const SUBSCRIPTION_PREFIX = 'subscription:'
const KEY_PREFIX = 'background-ai:'
const PENDING_PREFIX = 'pending:'
const STATE_PREFIX = 'state:'
const ACTIVITY_PREFIX = 'activity:'
const ENCRYPTED_PAYLOAD_VERSION = 1

const json = (payload = {}, init = {}) => new Response(JSON.stringify(payload), {
  status: init.status || 200,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    ...(init.headers || {})
  }
})

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type'
}

const trimText = (value, limit = 20000) => String(value || '').trim().slice(0, limit)
const safeId = (value) => String(value || '').trim().replace(/[^\w:-]/g, '').slice(0, 160)
const nowMs = () => Date.now()

const randomToken = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `aprt_${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const sha256Hex = async (value = '') => {
  const input = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const toBase64Url = (value) => Buffer.from(value).toString('base64url')
const fromBase64Url = (value = '') => new Uint8Array(Buffer.from(String(value || ''), 'base64url'))

const getRuntimeDataSecret = (env = {}) => trimText(env.PERSONAL_RUNTIME_DATA_SECRET)

const importRuntimeDataKey = async (env = {}) => {
  const secret = getRuntimeDataSecret(env)
  if (!secret) throw Object.assign(new Error('missing_runtime_data_secret'), { status: 500 })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const encryptRuntimeJson = async (env = {}, payload = {}) => {
  const key = await importRuntimeDataKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data))
  return {
    encrypted: true,
    version: ENCRYPTED_PAYLOAD_VERSION,
    alg: 'aes-gcm',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(encrypted)
  }
}

const decryptRuntimeJson = async (env = {}, payload = null) => {
  if (!payload?.encrypted || !payload?.iv || !payload?.ciphertext) return payload
  const key = await importRuntimeDataKey(env)
  const decrypted = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: fromBase64Url(payload.iv)
  }, key, fromBase64Url(payload.ciphertext))
  return JSON.parse(new TextDecoder().decode(decrypted))
}

const normalizeBackgroundAiConfig = (value = {}) => ({
  apiKey: trimText(value?.apiKey, 4000),
  baseUrl: trimText(value?.baseUrl, 500),
  model: trimText(value?.model, 200),
  updatedAt: Number(value?.updatedAt || nowMs()) || nowMs()
})

const readBackgroundAiConfig = async (env = {}, storedValue = null) => {
  if (!storedValue || typeof storedValue !== 'object') return null
  const decrypted = await decryptRuntimeJson(env, storedValue)
  const config = normalizeBackgroundAiConfig(decrypted)
  return config.apiKey && config.baseUrl && config.model ? config : null
}

const readJson = async (request) => {
  const text = await request.text().catch(() => '')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 })
  }
}

const errorJson = (error, fallbackStatus = 500) => json({
  ok: false,
  error: trimText(error?.message || error || 'runtime_error', 500)
}, { status: error?.status || fallbackStatus })

const assertDb = (env) => {
  if (!env.DB) throw Object.assign(new Error('missing_d1_binding'), { status: 500 })
}

const getOwnerUser = async (env) => env.DB
  .prepare('SELECT * FROM users WHERE id = ?')
  .bind(OWNER_USER_ID)
  .first()

const upsertOwnerUser = async (env, patch = {}) => {
  const now = nowMs()
  const existing = await getOwnerUser(env)
  await env.DB
    .prepare(`
      INSERT INTO users (id, owner_token_hash, setup_claimed_at, last_ack_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner_token_hash = excluded.owner_token_hash,
        setup_claimed_at = excluded.setup_claimed_at,
        last_ack_at = excluded.last_ack_at,
        updated_at = excluded.updated_at
    `)
    .bind(
      OWNER_USER_ID,
      patch.owner_token_hash ?? existing?.owner_token_hash ?? null,
      Number(patch.setup_claimed_at ?? existing?.setup_claimed_at ?? 0) || null,
      Number(patch.last_ack_at ?? existing?.last_ack_at ?? 0) || null,
      Number(existing?.created_at || now),
      now
    )
    .run()
}

const requireOwner = async (request, env) => {
  const auth = trimText(request.headers.get('authorization'))
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw Object.assign(new Error('missing_owner_token'), { status: 401 })
  const owner = await getOwnerUser(env)
  if (!owner?.owner_token_hash) throw Object.assign(new Error('runtime_not_claimed'), { status: 401 })
  const tokenHash = await sha256Hex(token)
  if (tokenHash !== owner.owner_token_hash) {
    throw Object.assign(new Error('invalid_owner_token'), { status: 403 })
  }
  return owner
}

const normalizeMessage = (input = {}, fallback = {}) => {
  const now = nowMs()
  const id = trimText(input.id) || crypto.randomUUID()
  const roleId = trimText(input.roleId || fallback.roleId || 'default_role')
  const userId = trimText(input.userId || fallback.userId || OWNER_USER_ID)
  const conversationId = trimText(input.conversationId || fallback.conversationId || `${userId}:${roleId}:default`)
  return {
    id,
    userId,
    roleId,
    conversationId,
    sender: ['user', 'assistant', 'system'].includes(trimText(input.sender)) ? trimText(input.sender) : 'user',
    content: trimText(input.content, 20000),
    contentType: trimText(input.contentType || TEXT_CONTENT_TYPE) || TEXT_CONTENT_TYPE,
    source: trimText(input.source || fallback.source || 'pwa') || 'pwa',
    externalWechatMessageId: trimText(input.externalWechatMessageId),
    delivery: input.delivery && typeof input.delivery === 'object' ? input.delivery : {},
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
    createdAt: Number(input.createdAt || now) || now,
    updatedAt: Number(input.updatedAt || now) || now
  }
}

const saveMessage = async (env, message) => {
  await env.DB
    .prepare(`
      INSERT INTO messages (
        id, user_id, role_id, conversation_id, sender, content, content_type, source,
        external_wechat_message_id, delivery_json, meta_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        delivery_json = excluded.delivery_json,
        meta_json = excluded.meta_json,
        updated_at = excluded.updated_at
    `)
    .bind(
      message.id,
      message.userId,
      message.roleId,
      message.conversationId,
      message.sender,
      message.content,
      message.contentType,
      message.source,
      message.externalWechatMessageId || null,
      JSON.stringify(message.delivery || {}),
      JSON.stringify(message.meta || {}),
      message.createdAt,
      message.updatedAt
    )
    .run()

  await env.DB
    .prepare(`
      INSERT INTO conversations (id, user_id, role_id, channel_scope, last_message_id, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, 'unified', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_message_id = excluded.last_message_id,
        last_message_at = excluded.last_message_at,
        updated_at = excluded.updated_at
    `)
    .bind(message.conversationId, message.userId, message.roleId, message.id, message.createdAt, message.createdAt, message.updatedAt)
    .run()

  return message
}

const mapDbMessage = (row = {}) => ({
  id: row.id,
  userId: row.user_id,
  roleId: row.role_id,
  conversationId: row.conversation_id,
  sender: row.sender,
  content: row.content,
  contentType: row.content_type || TEXT_CONTENT_TYPE,
  source: row.source,
  cloudSynced: true,
  delivery: safeJson(row.delivery_json, {}),
  externalIds: row.external_wechat_message_id ? { wechatMessageId: row.external_wechat_message_id } : {},
  meta: safeJson(row.meta_json, {}),
  createdAt: Number(row.created_at || 0),
  updatedAt: Number(row.updated_at || 0)
})

const safeJson = (value, fallback) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const getRuntimeValue = async (env, key, fallback = null) => {
  const safeKey = String(key || '').trim()
  if (!safeKey) return fallback
  const row = await env.DB
    .prepare('SELECT value_json FROM runtime_kv WHERE key = ?')
    .bind(safeKey)
    .first()
  return safeJson(row?.value_json, fallback)
}

const putRuntimeValue = async (env, key, value) => {
  const safeKey = String(key || '').trim()
  if (!safeKey) return null
  const now = nowMs()
  await env.DB
    .prepare(`
      INSERT INTO runtime_kv (key, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `)
    .bind(safeKey, JSON.stringify(value), now, now)
    .run()
  return value
}

const deleteRuntimeValue = async (env, key) => {
  const safeKey = String(key || '').trim()
  if (!safeKey) return
  await env.DB.prepare('DELETE FROM runtime_kv WHERE key = ?').bind(safeKey).run()
}

const D1_KV_PREFIX = 'compat-kv:'

const createD1KvAdapter = (env) => ({
  async get(key) {
    const value = await getRuntimeValue(env, `${D1_KV_PREFIX}${key}`, null)
    if (value == null) return null
    return typeof value === 'string' ? value : JSON.stringify(value)
  },
  async put(key, value) {
    const text = String(value ?? '')
    let parsed = text
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    await putRuntimeValue(env, `${D1_KV_PREFIX}${key}`, parsed)
  },
  async delete(key) {
    await deleteRuntimeValue(env, `${D1_KV_PREFIX}${key}`)
  }
})

const createWechatRuntimeEnv = (env) => ({
  ...env,
  PROACTIVE_KV: createD1KvAdapter(env)
})

const registerDevice = async (env, deviceId) => {
  const id = safeId(deviceId)
  if (!id) return
  const current = await getRuntimeValue(env, DEVICE_INDEX_KEY, [])
  const next = Array.from(new Set([...(Array.isArray(current) ? current : []), id])).slice(-2000)
  await putRuntimeValue(env, DEVICE_INDEX_KEY, next)
}

const arrayBufferToBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const exportVapidKeyPair = async (keyPair) => {
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey)
  return {
    publicKey: `B${publicJwk.x}${publicJwk.y}`,
    privateKey: privateJwk.d,
    createdAt: nowMs()
  }
}

const getOrCreateVapidKeyPair = async (env) => {
  const existing = await getRuntimeValue(env, VAPID_KEYPAIR_KEY, null)
  if (existing?.publicKey && existing?.privateKey) return existing
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )
  const exported = await exportVapidKeyPair(keyPair)
  await putRuntimeValue(env, VAPID_KEYPAIR_KEY, exported)
  return exported
}

const normalizeEndpoint = (baseUrl) => {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!clean) return ''
  try {
    const url = new URL(clean)
    const host = url.hostname.toLowerCase()
    const shouldUseV1 = ['www.aladingapi.cc', 'aladingapi.cc'].includes(host)
      && ['', '/'].includes(url.pathname.replace(/\/+$/, ''))
    if (shouldUseV1) {
      url.pathname = '/v1'
      url.search = ''
      url.hash = ''
      return `${url.toString().replace(/\/$/, '')}/chat/completions`
    }
  } catch {
    // Keep legacy custom strings.
  }
  if (/\/chat\/completions$/i.test(clean)) return clean
  return `${clean}/chat/completions`
}

const cleanModelText = (value) => {
  let textValue = String(value || '').trim()
  textValue = textValue.replace(/^```(?:json|text)?/i, '').replace(/```$/i, '').trim()
  textValue = textValue.replace(/^\{[\s\S]*?"content"\s*:\s*"([\s\S]*?)"[\s\S]*\}$/m, '$1')
  return textValue
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')
    .trim()
}

const previewText = (rawText) => String(rawText || '')
  .replace(/\[[^\]]+:[^\]]*\]/g, '')
  .replace(/\[[^\]]+\]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80)

const normalizeChatMessages = (messages) => (Array.isArray(messages) ? messages : [])
  .slice(-MAX_INTERNAL_CHAT_MESSAGES)
  .map((message) => ({
    role: ['system', 'user', 'assistant'].includes(String(message?.role || '').trim())
      ? String(message.role).trim()
      : 'user',
    content: String(message?.content || '').trim().slice(0, 8000)
  }))
  .filter((message) => message.content)

const callBackgroundModel = async ({ keyConfig, messages, temperature = 0.9 }) => {
  const endpoint = normalizeEndpoint(keyConfig?.baseUrl)
  if (!endpoint || !keyConfig?.apiKey || !keyConfig?.model) throw new Error('missing background model config')
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${keyConfig.apiKey}`
    },
    body: JSON.stringify({
      model: keyConfig.model,
      messages: normalizeChatMessages(messages),
      temperature: Math.max(0, Math.min(2, Number(temperature || 0.9)))
    })
  })
  if (!res.ok) throw new Error(`model request failed: ${res.status}`)
  const data = await res.json()
  return cleanModelText(data?.choices?.[0]?.message?.content || '')
}

const roleHasBoundWechatBridge = (role = null) => (
  Array.isArray(role?.wechatThreads)
  && role.wechatThreads.some((thread) => (
    thread?.wechatBridgeBound === true
    || String(thread?.wechatBridgeStatus || '').trim() === 'bound'
  ))
)

const getBoundWechatThreadForRole = (role = null) => {
  if (!Array.isArray(role?.wechatThreads)) return null
  return role.wechatThreads.find((thread) => (
    thread?.wechatBridgeBound === true
    || String(thread?.wechatBridgeStatus || '').trim() === 'bound'
  )) || null
}

const buildWechatOutboxThreadMeta = (role = null, thread = null) => {
  const safeThread = thread && typeof thread === 'object' ? thread : {}
  return {
    roleId: String(role?.id || '').trim(),
    accountId: String(safeThread.accountId || '').trim(),
    identity: String(safeThread.identity || 'main').trim() || 'main',
    chatId: String(safeThread.chatId || '').trim(),
    wechatReplyTriggersAi: safeThread.wechatReplyTriggersAi !== false,
    pwaChatToWechat: safeThread.pwaChatToWechat === true,
    quietSeconds: Math.max(0, Number(safeThread.quietSeconds || 0))
  }
}

const splitRenderableWechatTexts = (rawText = '') => String(rawText || '')
  .replace(/\r/g, '')
  .split('\n')
  .map((line) => line.trim())
  .map((line) => line.replace(/^\s*\[(?:语音|voice)\]\s*/i, '').trim())
  .filter((line) => line && !/^\[[^\]]+\]$/.test(line) && !/^【[^】]+】$/.test(line))
  .filter((line) => !/^\[(?:表情|sticker|image|图片)\s*[:：][^\]]*\]$/i.test(line))
  .slice(0, 8)

const formatPendingRelativeTime = (timestamp = 0, now = Date.now()) => {
  const ts = Number(timestamp || 0)
  if (!ts) return '时间未知'
  const diff = Math.max(0, Number(now || Date.now()) - ts)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  return `${Math.floor(diff / day)}天前`
}

const formatPendingPromptText = (value = '', limit = 160) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit)

const buildPendingPromptBlock = (messages = [], role = null, now = Date.now()) => {
  const safeMessages = (Array.isArray(messages) ? messages : [])
    .filter((item) => String(item?.roleId || '') === String(role?.id || ''))
    .slice(-3)
  if (!safeMessages.length) return ''
  return safeMessages.map((item, index) => {
    const text = formatPendingPromptText(item?.rawText || item?.body || '')
    return `- 第 ${index + 1} 条：${formatPendingRelativeTime(item?.createdAt, now)}，你主动发过：${text || '（无正文）'}`
  }).join('\n')
}

const buildRequestMessagesForRole = (snapshot, role, pendingMessages = []) => {
  const recentMessages = Array.isArray(role?.recentMessages) ? role.recentMessages : []
  const latestUserMessage = findLatestProactiveUserMessage(recentMessages)
  const latestVisibleMessage = recentMessages.length ? recentMessages[recentMessages.length - 1] : null
  const proactiveMode = String(latestVisibleMessage?.role || '') === 'user'
    ? 'delayed_reply_recovery'
    : 'proactive_nudge'
  const latestUserFocusText = proactiveMode === 'delayed_reply_recovery' && latestUserMessage
    ? String(latestUserMessage.text || latestUserMessage.transcript || latestUserMessage.description || '').trim()
    : ''
  const recentChatText = formatProactiveMessagesForLLM(recentMessages)
  const now = new Date()
  const timeZone = String(snapshot?.timeZone || '').trim()
  const localHour = getLocalHourInTimeZone(now, timeZone)
  const backgroundPendingText = buildPendingPromptBlock(pendingMessages, role, now.getTime())
  const timeText = `当前用户本地时间：${formatProactiveLocalTimeText(now, timeZone)}；localHour=${localHour}。请按这个本地时间理解早晚和作息，不要按 UTC 时间判断。只有 localHour 在 23、0、1、2、3、4 时，才可以主动提睡觉、晚安、还没睡。`
  return buildProactiveRequestMessages({
    role,
    userPersona: snapshot.userPersona || '',
    proactiveMode,
    proactiveTimeContext: timeText,
    recentChatText,
    backgroundPendingText,
    latestUserFocusText,
    stickers: Array.isArray(role?.stickers) ? role.stickers : (snapshot.stickers || [])
  })
}

const buildMessageForRole = ({ role, rawText }) => {
  const messageId = `bg_${Date.now()}_${crypto.randomUUID()}`
  return {
    messageId,
    roleId: String(role?.id || ''),
    roleName: String(role?.name || '微信'),
    title: String(role?.name || '微信'),
    body: previewText(rawText) || '给你发了一条消息',
    icon: String(role?.avatar || ''),
    rawText,
    createdAt: nowMs(),
    data: {
      action: 'open_chat',
      roleId: String(role?.id || ''),
      messageId,
      source: 'background_proactive'
    }
  }
}

const appendPending = async (env, deviceId, message) => {
  const key = `${PENDING_PREFIX}${deviceId}`
  const current = await getRuntimeValue(env, key, [])
  const next = [...(Array.isArray(current) ? current : []), message].slice(-PROACTIVE_PENDING_LIMIT)
  await putRuntimeValue(env, key, next)
}

const getPushPayloadForMessage = (message = {}) => ({
  title: String(message?.title || '微信'),
  body: String(message?.body || '你收到了新的主动消息'),
  icon: String(message?.icon || '').trim(),
  data: message?.data && typeof message.data === 'object'
    ? message.data
    : {
        action: 'open_wechat',
        source: 'background_proactive'
      }
})

const sendPush = async (env, subscription, payload = null) => {
  if (!subscription?.endpoint) return { ok: false, reason: 'missing_subscription_endpoint' }
  const vapid = await getOrCreateVapidKeyPair(env)
  webpush.setVapidDetails('mailto:ai-phone-personal-runtime@example.com', vapid.publicKey, vapid.privateKey)
  try {
    const response = await webpush.sendNotification(
      subscription,
      payload ? JSON.stringify(payload) : undefined,
      { TTL: 60 }
    )
    return {
      ok: response?.statusCode >= 200 && response?.statusCode < 300,
      status: Number(response?.statusCode || 0)
    }
  } catch (error) {
    return {
      ok: false,
      status: Number(error?.statusCode || 0),
      reason: String(error?.body || error?.message || 'push_send_failed')
    }
  }
}

const isExpiredSubscriptionStatus = (status = 0) => [404, 410].includes(Number(status || 0))

const normalizeHeaderObject = (headers = new Headers()) => {
  const result = {}
  headers.forEach((value, key) => {
    result[String(key || '').toLowerCase()] = String(value || '')
  })
  return result
}

const createNodeLikeResponse = () => {
  const headers = new Map()
  let statusCode = 200
  let body = ''
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(value) {
      statusCode = Number(value || 200)
    },
    setHeader(name, value) {
      headers.set(String(name || '').toLowerCase(), value)
    },
    end(value = '') {
      body = value == null ? '' : String(value)
    },
    toResponse() {
      const responseHeaders = new Headers(corsHeaders)
      for (const [name, value] of headers.entries()) {
        if (Array.isArray(value)) {
          value.forEach((item) => responseHeaders.append(name, String(item || '')))
        } else if (value != null) {
          responseHeaders.set(name, String(value))
        }
      }
      return new Response(body, {
        status: statusCode,
        headers: responseHeaders
      })
    }
  }
}

const runNodeStyleHandler = async (request, handler) => {
  let body = undefined
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const contentType = String(request.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('application/json')) {
      try {
        body = await request.clone().json()
      } catch {
        body = undefined
      }
    }
  }
  const req = {
    method: request.method,
    url: request.url,
    headers: normalizeHeaderObject(request.headers),
    body
  }
  const res = createNodeLikeResponse()
  await handler(req, res)
  return res.toResponse()
}

const createWechatDaemonRuntimeForWorker = (env) => {
  const runtimeEnv = createWechatRuntimeEnv(env)
  return createWechatDaemonRuntime({
    ...runtimeEnv,
    __WECHAT_DAEMON_AUTO_REPLY_HANDLER__: createWechatDaemonAutoReplyHandler(runtimeEnv)
  })
}

const getWechatRoutePath = (pathname = '') => {
  const clean = String(pathname || '').replace(/^\/api(?=\/wechat(?:\/|$))/, '')
  return clean || '/'
}

const handleWechatDaemonRequest = async (request, env, routePath) => {
  const runtime = createWechatDaemonRuntimeForWorker(env)
  if (routePath === '/wechat/daemon/health') return json(await runtime.getStatus())
  if (routePath === '/wechat/daemon/threads') return json({ ok: true, bindings: await runtime.store.listBindings() })
  if (routePath === '/wechat/daemon/outbox') return json({ ok: true, messages: await runtime.outboxStore.listMessages() })
  if (routePath === '/wechat/daemon/tick') {
    await runtime.tick()
    return json(await runtime.getStatus())
  }
  return json({ ok: false, error: 'wechat_daemon_route_not_found', path: routePath }, { status: 404 })
}

const handleWechatRequest = async (request, env, ctx = null) => {
  const routePath = getWechatRoutePath(new URL(request.url).pathname)
  if (routePath.startsWith('/wechat/daemon/')) {
    return handleWechatDaemonRequest(request, env, routePath)
  }
  const runtimeEnv = createWechatRuntimeEnv(env)
  const response = await runNodeStyleHandler(request, (req, res) =>
    handleWechatBridgeProxy(req, res, runtimeEnv, routePath)
  )
  if (
    ['/wechat/sync-now', '/wechat/outbox/enqueue', '/wechat/thread-context', '/wechat/config'].includes(routePath)
  ) {
    const tickPromise = createWechatDaemonRuntimeForWorker(env).tick().catch((error) => {
      console.warn('[personal-runtime] post-route wechat daemon tick failed', {
        routePath,
        error
      })
    })
    if (ctx?.waitUntil) {
      ctx.waitUntil(tickPromise)
    } else if (routePath === '/wechat/outbox/enqueue') {
      void tickPromise
    } else {
      await tickPromise
    }
  }
  return response
}

const enqueueWechatOutboxForProactiveMessage = async (env, role = null, pendingMessage = {}) => {
  const thread = getBoundWechatThreadForRole(role)
  if (!thread) return { enqueued: false, reason: 'missing_bound_wechat_thread' }
  const threadMeta = buildWechatOutboxThreadMeta(role, thread)
  if (!threadMeta.roleId || !threadMeta.chatId) {
    return { enqueued: false, reason: 'missing_wechat_thread_meta' }
  }
  const content = String(pendingMessage.rawText || pendingMessage.body || '').trim()
  if (!content) return { enqueued: false, reason: 'empty_content' }
  const runtime = createWechatDaemonRuntimeForWorker(env)
  const messageId = String(pendingMessage.messageId || '').trim()
  const idempotencyKey = `background_proactive:${threadMeta.accountId}:${threadMeta.identity}:${threadMeta.chatId}:${messageId}`
  const renderableTexts = splitRenderableWechatTexts(content)
  const outboxTexts = renderableTexts.length ? renderableTexts : [previewText(content) || content.slice(0, 160)]
  const queuedMessages = []
  for (let index = 0; index < outboxTexts.length; index += 1) {
    const itemContent = String(outboxTexts[index] || '').trim()
    if (!itemContent) continue
    const queued = await runtime.outboxStore.enqueueMessage({
      threadMeta,
      source: 'background_proactive',
      content: itemContent,
      messageId,
      idempotencyKey: `${idempotencyKey}:${index}`
    })
    if (queued?.id) queuedMessages.push(queued)
  }
  await runtime.store.appendThreadContextMessages(queuedMessages[0]?.threadKey || threadMeta.threadKey, [{
    id: messageId,
    role: 'assistant',
    type: 'text',
    text: outboxTexts.join('\n'),
    originalText: content,
    timestamp: Number(pendingMessage.createdAt || Date.now()),
    source: 'background_proactive'
  }], {
    updatedAt: Number(pendingMessage.createdAt || Date.now())
  }).catch((error) => {
    console.warn('[personal-runtime] append proactive wechat thread context failed', {
      messageId,
      error
    })
  })
  const tickResult = await runtime.tick().catch((error) => ({
    ok: false,
    error: String(error?.message || error || '')
  }))
  return {
    enqueued: queuedMessages.length > 0,
    outboxMessageId: queuedMessages[0]?.id || '',
    outboxMessageIds: queuedMessages.map((item) => item.id).filter(Boolean),
    tickResult
  }
}

const getRecentMessages = async (env, conversationId, limit = 24) => {
  const result = await env.DB
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(conversationId, Math.max(1, Math.min(80, Number(limit) || 24)))
    .all()
  return (result.results || []).reverse().map(mapDbMessage)
}

const resolveAiConfig = (env, body = {}) => {
  const fromBody = body.aiConfig && typeof body.aiConfig === 'object' ? body.aiConfig : {}
  return {
    apiKey: trimText(fromBody.apiKey || env.AI_API_KEY),
    baseUrl: trimText(fromBody.baseUrl || env.AI_BASE_URL || 'https://api.openai.com/v1'),
    model: trimText(fromBody.model || env.AI_MODEL)
  }
}

const callOpenAiCompatible = async (env, body, userMessage) => {
  const aiConfig = resolveAiConfig(env, body)
  if (!aiConfig.apiKey || !aiConfig.model) {
    return null
  }
  const recent = await getRecentMessages(env, userMessage.conversationId, 24)
  const messages = [
    {
      role: 'system',
      content: trimText(body.roleProfile?.systemPrompt || body.roleProfile?.profile || '你是用户的小手机角色，请自然、简短地回复。', 8000)
    },
    ...recent.map((message) => ({
      role: message.sender === 'assistant' ? 'assistant' : (message.sender === 'system' ? 'system' : 'user'),
      content: message.content
    }))
  ]
  const endpoint = `${aiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${aiConfig.apiKey}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages,
      temperature: Number(body.aiConfig?.temperature ?? 0.9)
    })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || payload?.message || 'ai_provider_failed'), { status: 502 })
  }
  return trimText(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '', 20000)
}

const handleHealth = async (env) => {
  assertDb(env)
  let d1Ok = false
  let messageCount = 0
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM messages').first()
    d1Ok = true
    messageCount = Number(row?.count || 0)
  } catch {
    d1Ok = false
  }
  const owner = d1Ok ? await getOwnerUser(env).catch(() => null) : null
  return json({
    ok: true,
    runtime: 'ai-phone-personal-runtime',
    version: env.RUNTIME_VERSION || RUNTIME_VERSION,
    d1Ok,
    claimed: Boolean(owner?.owner_token_hash),
    messageCount,
    now: new Date().toISOString()
  })
}

const handleClaim = async (request, env) => {
  assertDb(env)
  const body = await readJson(request)
  const expected = trimText(env.SETUP_SECRET)
  if (!expected) throw Object.assign(new Error('missing_setup_secret'), { status: 500 })
  const owner = await getOwnerUser(env)
  if (trimText(body.setupSecret) !== expected) throw Object.assign(new Error('invalid_setup_secret'), { status: 403 })
  const token = randomToken()
  await upsertOwnerUser(env, {
    owner_token_hash: await sha256Hex(token),
    setup_claimed_at: Number(owner?.setup_claimed_at || 0) || nowMs()
  })
  return json({
    ok: true,
    token,
    userId: OWNER_USER_ID,
    runtimeMode: 'cloud',
    reclaimed: Boolean(owner?.owner_token_hash)
  })
}

const handleChatSend = async (request, env) => {
  await requireOwner(request, env)
  const body = await readJson(request)
  const userMessage = await saveMessage(env, normalizeMessage(body.message || body, {
    userId: OWNER_USER_ID,
    source: 'pwa'
  }))
  const replyText = await callOpenAiCompatible(env, body, userMessage)
  if (!replyText) {
    return json({
      ok: true,
      messages: [mapDbMessage({
        id: userMessage.id,
        user_id: userMessage.userId,
        role_id: userMessage.roleId,
        conversation_id: userMessage.conversationId,
        sender: userMessage.sender,
        content: userMessage.content,
        content_type: userMessage.contentType,
        source: userMessage.source,
        delivery_json: JSON.stringify(userMessage.delivery || {}),
        meta_json: JSON.stringify(userMessage.meta || {}),
        created_at: userMessage.createdAt,
        updated_at: userMessage.updatedAt
      })],
      aiSkipped: true,
      reason: 'missing_ai_config'
    })
  }
  const assistantMessage = await saveMessage(env, normalizeMessage({
    conversationId: userMessage.conversationId,
    roleId: userMessage.roleId,
    userId: userMessage.userId,
    sender: 'assistant',
    content: replyText,
    source: 'cloud',
    delivery: {
      pwa: 'synced',
      wechat: 'pending'
    }
  }))
  return json({
    ok: true,
    messages: [
      ...(await getRecentMessages(env, userMessage.conversationId, 2)).filter((message) => [userMessage.id, assistantMessage.id].includes(message.id))
    ]
  })
}

const handleSync = async (request, env) => {
  await requireOwner(request, env)
  const url = new URL(request.url)
  const since = Math.max(0, Number(url.searchParams.get('since') || 0))
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)))
  const result = await env.DB
    .prepare('SELECT * FROM messages WHERE user_id = ? AND updated_at > ? ORDER BY created_at ASC LIMIT ?')
    .bind(OWNER_USER_ID, since, limit)
    .all()
  return json({
    ok: true,
    messages: (result.results || []).map(mapDbMessage),
    cursor: nowMs()
  })
}

const handleMessagesAck = async (request, env) => {
  await requireOwner(request, env)
  const body = await readJson(request)
  await upsertOwnerUser(env, { last_ack_at: Math.max(0, Number(body.syncedAt || nowMs())) })
  return json({ ok: true })
}

const handleDisconnect = async (request, env) => {
  await requireOwner(request, env)
  return json({
    ok: true,
    disconnected: true,
    note: '本接口只确认当前 token 有效；真正解绑由小手机本地删除 endpoint/token 完成。'
  })
}

const buildDeviceStatus = async (env, deviceId) => {
  const snapshot = await getRuntimeValue(env, `${SNAPSHOT_PREFIX}${deviceId}`)
  const subscription = await getRuntimeValue(env, `${SUBSCRIPTION_PREFIX}${deviceId}`)
  const storedKeyConfig = await getRuntimeValue(env, `${KEY_PREFIX}${deviceId}`)
  const keyConfig = await readBackgroundAiConfig(env, storedKeyConfig).catch(() => null)
  const pending = await getRuntimeValue(env, `${PENDING_PREFIX}${deviceId}`, [])
  const state = await getRuntimeValue(env, `${STATE_PREFIX}${deviceId}`, {})
  const activity = await getRuntimeValue(env, `${ACTIVITY_PREFIX}${deviceId}`, {})
  const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : []
  return {
    ok: true,
    deviceId,
    storage: 'd1',
    hasSnapshot: Boolean(snapshot),
    snapshotUpdatedAt: Number(snapshot?.updatedAt || snapshot?.updatedAtMs || 0),
    backgroundEnabled: snapshot?.backgroundAi?.enabled === true,
    roleCount: roles.length,
    hasSubscription: Boolean(subscription?.endpoint),
    hasBackgroundKey: Boolean(keyConfig?.apiKey),
    backgroundKeyEncrypted: storedKeyConfig?.encrypted === true,
    pendingCount: Array.isArray(pending) ? pending.length : 0,
    foregroundUntil: Number(activity?.foregroundUntil || 0),
    foregroundActive: Number(activity?.foregroundUntil || 0) > nowMs(),
    appVisibility: String(activity?.state || ''),
    state: {
      nextCheckAt: Number(state?.nextCheckAt || 0),
      lastCheckedAt: Number(state?.lastCheckedAt || 0),
      lastGeneratedAt: Number(state?.lastGeneratedAt || 0),
      lastPushAcceptedAt: Number(state?.lastPushAcceptedAt || 0),
      lastGeneratedMessageId: String(state?.lastGeneratedMessageId || ''),
      lastPushStatus: Number(state?.lastPushStatus || 0),
      lastPushReceiptAt: Number(state?.lastPushReceiptAt || 0),
      lastPushReceiptStage: String(state?.lastPushReceiptStage || ''),
      lastPushReceiptMessageId: String(state?.lastPushReceiptMessageId || ''),
      lastSkipReason: String(state?.lastSkipReason || '')
    }
  }
}

const runDevice = async (env, deviceId, { force = false } = {}) => {
  const snapshot = await getRuntimeValue(env, `${SNAPSHOT_PREFIX}${deviceId}`)
  if (!snapshot?.backgroundAi?.enabled) return { generated: false, reason: 'missing_or_disabled_snapshot' }
  const subscription = await getRuntimeValue(env, `${SUBSCRIPTION_PREFIX}${deviceId}`)
  if (!subscription) return { generated: false, reason: 'missing_subscription' }
  const keyConfig = await readBackgroundAiConfig(env, await getRuntimeValue(env, `${KEY_PREFIX}${deviceId}`))
  if (!keyConfig?.apiKey) return { generated: false, reason: 'missing_background_key' }
  const pendingMessages = await getRuntimeValue(env, `${PENDING_PREFIX}${deviceId}`, [])

  const stateKey = `${STATE_PREFIX}${deviceId}`
  const state = await getRuntimeValue(env, stateKey, {})
  const now = nowMs()
  const activity = await getRuntimeValue(env, `${ACTIVITY_PREFIX}${deviceId}`, {})
  const appIsForeground = !force && Number(activity?.foregroundUntil || 0) > now
  if (!force && Number(state.nextCheckAt || 0) > now) {
    return { generated: false, reason: 'next_check_not_due' }
  }

  const eligibleSnapshot = appIsForeground
    ? {
        ...snapshot,
        roles: (Array.isArray(snapshot?.roles) ? snapshot.roles : []).filter(roleHasBoundWechatBridge)
      }
    : snapshot
  const role = sharedChooseProactiveRole(eligibleSnapshot)
  if (appIsForeground && !role) {
    return {
      generated: false,
      reason: 'app_foreground_no_bound_wechat_role',
      foregroundUntil: Number(activity.foregroundUntil || 0)
    }
  }
  const decision = sharedShouldRunProactiveForRole({ snapshot, role, now, force })
  const nextCheckAt = now + sharedCalculateProactiveDelay(snapshot?.autoMessage || {})
  await putRuntimeValue(env, stateKey, {
    ...state,
    nextCheckAt,
    lastCheckedAt: now,
    lastSkipReason: decision.ok ? '' : decision.reason
  })
  if (!decision.ok) return { generated: false, reason: decision.reason }

  const messages = buildRequestMessagesForRole(snapshot, role, pendingMessages)
  const rawText = await callBackgroundModel({ keyConfig, messages })
  if (!rawText) return { generated: false, reason: 'empty_model_reply' }

  const pendingMessage = buildMessageForRole({ role, rawText })
  const wechatOutboxResult = await enqueueWechatOutboxForProactiveMessage(env, role, pendingMessage).catch((error) => ({
    enqueued: false,
    reason: 'wechat_outbox_enqueue_failed',
    error: String(error?.message || error || '')
  }))
  if (wechatOutboxResult?.enqueued) {
    pendingMessage.wechatOutboxEnqueued = true
    pendingMessage.wechatOutboxMessageId = String(wechatOutboxResult.outboxMessageId || '')
    pendingMessage.data = {
      ...(pendingMessage.data || {}),
      wechatOutboxEnqueued: true,
      wechatOutboxMessageId: String(wechatOutboxResult.outboxMessageId || '')
    }
  }
  await appendPending(env, deviceId, pendingMessage)
  const pushResult = await sendPush(env, subscription, getPushPayloadForMessage(pendingMessage))
  if (isExpiredSubscriptionStatus(pushResult.status)) {
    await deleteRuntimeValue(env, `${SUBSCRIPTION_PREFIX}${deviceId}`)
  }
  await putRuntimeValue(env, stateKey, {
    ...state,
    nextCheckAt,
    lastCheckedAt: now,
    lastGeneratedAt: now,
    lastPushAcceptedAt: pushResult.ok ? now : 0,
    lastGeneratedMessageId: pendingMessage.messageId,
    lastPushStatus: pushResult.status || 0,
    lastSkipReason: isExpiredSubscriptionStatus(pushResult.status) ? 'subscription_expired' : ''
  })
  return { generated: true, messageId: pendingMessage.messageId, pushResult, wechatOutboxResult }
}

const handleBackgroundAiKey = async (request, env) => {
  const body = await readJson(request)
  const deviceId = safeId(body.deviceId)
  if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
  if (body.enabled !== true) {
    await deleteRuntimeValue(env, `${KEY_PREFIX}${deviceId}`)
    return json({ ok: true, deleted: true })
  }
  if (!body.apiKey || !body.baseUrl || !body.model) {
    return json({ ok: false, error: 'missing_key_config' }, { status: 400 })
  }
  await putRuntimeValue(
    env,
    `${KEY_PREFIX}${deviceId}`,
    await encryptRuntimeJson(env, normalizeBackgroundAiConfig(body))
  )
  await registerDevice(env, deviceId)
  return json({ ok: true })
}

const handleSnapshot = async (request, env) => {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES) {
    return json({ ok: false, error: 'snapshot_too_large' }, { status: 413 })
  }
  const body = raw ? JSON.parse(raw) : {}
  const deviceId = safeId(body.deviceId)
  if (!deviceId || !body.snapshot) return json({ ok: false, error: 'missing_device_or_snapshot' }, { status: 400 })
  const snapshotKey = `${SNAPSHOT_PREFIX}${deviceId}`
  const currentSnapshot = await getRuntimeValue(env, snapshotKey)
  const comparable = (value = {}) => {
    const next = value && typeof value === 'object' ? { ...value } : {}
    delete next.updatedAt
    delete next.updatedAtMs
    return JSON.stringify(next)
  }
  if (currentSnapshot && comparable(currentSnapshot) === comparable(body.snapshot)) {
    await registerDevice(env, deviceId)
    return json({ ok: true, skipped: true, reason: 'snapshot_unchanged' })
  }
  await putRuntimeValue(env, snapshotKey, {
    ...body.snapshot,
    updatedAt: nowMs()
  })
  await registerDevice(env, deviceId)
  return json({ ok: true })
}

const handleActivity = async (request, env) => {
  const body = await readJson(request)
  const deviceId = safeId(body.deviceId)
  if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
  await putRuntimeValue(env, `${ACTIVITY_PREFIX}${deviceId}`, {
    state: String(body.state || '').trim(),
    foregroundUntil: Math.max(0, Number(body.foregroundUntil || 0)),
    updatedAt: nowMs()
  })
  await registerDevice(env, deviceId)
  return json({ ok: true })
}

const handleSubscribe = async (request, env) => {
  const body = await readJson(request)
  const deviceId = safeId(body.deviceId)
  if (!deviceId || !body.subscription) return json({ ok: false, error: 'missing_device_or_subscription' }, { status: 400 })
  await putRuntimeValue(env, `${SUBSCRIPTION_PREFIX}${deviceId}`, body.subscription)
  await registerDevice(env, deviceId)
  return json({ ok: true })
}

const handlePull = async (request, env) => {
  const url = new URL(request.url)
  const deviceId = safeId(url.searchParams.get('deviceId'))
  if (!deviceId) return json({ empty: true, messages: [] })
  const messages = await getRuntimeValue(env, `${PENDING_PREFIX}${deviceId}`, [])
  const safeMessages = Array.isArray(messages) ? messages : []
  if (!safeMessages.length) return json({ empty: true, messages: [] })
  return json({ empty: false, messages: safeMessages })
}

const handleBackgroundAck = async (request, env) => {
  const body = await readJson(request)
  const deviceId = safeId(body.deviceId)
  const ackIds = new Set((Array.isArray(body.messageIds) ? body.messageIds : [body.messageId]).map((id) => String(id || '')))
  if (!deviceId || !ackIds.size) return json({ ok: false, error: 'missing_device_or_message' }, { status: 400 })
  const key = `${PENDING_PREFIX}${deviceId}`
  const current = await getRuntimeValue(env, key, [])
  const next = (Array.isArray(current) ? current : []).filter((message) => !ackIds.has(String(message.messageId || '')))
  await putRuntimeValue(env, key, next)
  return json({ ok: true, remaining: next.length })
}

const handlePushReceipt = async (request, env) => {
  const body = await readJson(request)
  const deviceId = safeId(body.deviceId)
  if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
  const stateKey = `${STATE_PREFIX}${deviceId}`
  const state = await getRuntimeValue(env, stateKey, {})
  await putRuntimeValue(env, stateKey, {
    ...state,
    lastPushReceiptAt: Math.max(0, Number(body.receiptAt || nowMs())),
    lastPushReceiptStage: String(body.stage || 'shown').trim() || 'shown',
    lastPushReceiptMessageId: String(body.messageId || '').trim()
  })
  await registerDevice(env, deviceId)
  return json({ ok: true })
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return json({ ok: true })
    const url = new URL(request.url)
    try {
      if (
        url.pathname === '/api'
        || url.pathname === '/wechat'
        || url.pathname.startsWith('/wechat/')
        || url.pathname.startsWith('/api/wechat/')
      ) {
        await requireOwner(request, env)
        return handleWechatRequest(request, env, ctx)
      }
      if (request.method === 'GET' && url.pathname === '/cloud/health') return handleHealth(env)
      if (request.method === 'GET' && url.pathname === '/health') return handleHealth(env)
      if (request.method === 'POST' && url.pathname === '/setup/claim') return handleClaim(request, env)
      if (request.method === 'POST' && url.pathname === '/chat/send') return handleChatSend(request, env)
      if (request.method === 'GET' && url.pathname === '/messages/sync') return handleSync(request, env)
      if (request.method === 'POST' && url.pathname === '/messages/ack') return handleMessagesAck(request, env)
      if (request.method === 'POST' && url.pathname === '/cloud/disconnect') return handleDisconnect(request, env)
      if (request.method === 'GET' && url.pathname === '/vapidPublicKey') {
        await requireOwner(request, env)
        const vapid = await getOrCreateVapidKeyPair(env)
        return new Response(vapid.publicKey || '', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'access-control-allow-origin': '*'
          }
        })
      }
      if (request.method === 'POST' && url.pathname === '/subscribe') {
        await requireOwner(request, env)
        return handleSubscribe(request, env)
      }
      if (request.method === 'POST' && url.pathname === '/background-ai-key') {
        await requireOwner(request, env)
        return handleBackgroundAiKey(request, env)
      }
      if (request.method === 'DELETE' && url.pathname === '/background-ai-key') {
        await requireOwner(request, env)
        const body = await readJson(request)
        const deviceId = safeId(body.deviceId)
        if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
        await deleteRuntimeValue(env, `${KEY_PREFIX}${deviceId}`)
        return json({ ok: true, deleted: true })
      }
      if (request.method === 'POST' && url.pathname === '/snapshot') {
        await requireOwner(request, env)
        return handleSnapshot(request, env)
      }
      if (request.method === 'POST' && url.pathname === '/activity') {
        await requireOwner(request, env)
        return handleActivity(request, env)
      }
      if (request.method === 'GET' && url.pathname === '/pull') {
        await requireOwner(request, env)
        return handlePull(request, env)
      }
      if (request.method === 'POST' && url.pathname === '/ack') {
        await requireOwner(request, env)
        return handleBackgroundAck(request, env)
      }
      if (request.method === 'POST' && url.pathname === '/push-receipt') {
        await requireOwner(request, env)
        return handlePushReceipt(request, env)
      }
      if (request.method === 'GET' && url.pathname === '/debug/status') {
        await requireOwner(request, env)
        const deviceId = safeId(url.searchParams.get('deviceId'))
        if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
        return json(await buildDeviceStatus(env, deviceId))
      }
      if (request.method === 'POST' && url.pathname === '/debug/run') {
        await requireOwner(request, env)
        const body = await readJson(request)
        const deviceId = safeId(body.deviceId)
        if (!deviceId) return json({ ok: false, error: 'missing_device' }, { status: 400 })
        return json({ ok: true, result: await runDevice(env, deviceId, { force: body.force === true }) })
      }
      return json({ ok: false, error: 'route_not_found' }, { status: 404 })
    } catch (error) {
      return errorJson(error)
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      assertDb(env)
      const devices = await getRuntimeValue(env, DEVICE_INDEX_KEY, [])
      const maxGenerations = Number(env.MAX_GENERATIONS_PER_CRON || DEFAULT_MAX_GENERATIONS_PER_CRON)
      let generatedCount = 0
      for (const deviceId of (Array.isArray(devices) ? devices : []).slice(0, MAX_DEVICES_PER_CRON)) {
        if (generatedCount >= maxGenerations) break
        try {
          const result = await runDevice(env, safeId(deviceId))
          if (result.generated) generatedCount += 1
        } catch (error) {
          const stateKey = `${STATE_PREFIX}${safeId(deviceId)}`
          const state = await getRuntimeValue(env, stateKey, {})
          await putRuntimeValue(env, stateKey, {
            ...state,
            lastCheckedAt: nowMs(),
            lastSkipReason: String(error?.message || error || 'scheduled_run_failed').slice(0, 300)
          })
        }
      }
      await createWechatDaemonRuntimeForWorker(env).tick().catch((error) => {
        console.warn('[personal-runtime] scheduled wechat daemon tick failed', error)
      })
    })())
  }
}
