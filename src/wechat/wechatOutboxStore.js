import fs from 'node:fs/promises'
import path from 'node:path'
import { buildWechatDaemonThreadKey, normalizeWechatDaemonThreadMeta } from './wechatDaemonStore.js'

const STORE_VERSION = 1
const DEFAULT_STORE_RELATIVE_PATH = path.join('data', 'wechat-outbox-store.json')
const KV_STORE_KEY = 'wechat-outbox-store'

const normalizeText = (value = '') => String(value || '').trim()
const clone = (value) => JSON.parse(JSON.stringify(value))

function resolveStorePath(env = process.env) {
  const configured = normalizeText(env.WECHAT_OUTBOX_STORE_FILE)
  return path.resolve(configured || DEFAULT_STORE_RELATIVE_PATH)
}

function createEmptyStoreData() {
  return {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    messages: []
  }
}

function normalizeOutboxMessage(input = {}) {
  const safe = input && typeof input === 'object' ? input : {}
  const threadMeta = normalizeWechatDaemonThreadMeta(safe.threadMeta || safe)
  return {
    id: normalizeText(safe.id) || `wechat_outbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    threadKey: normalizeText(safe.threadKey) || buildWechatDaemonThreadKey(threadMeta),
    roleId: normalizeText(safe.roleId || threadMeta.roleId),
    accountId: normalizeText(safe.accountId || threadMeta.accountId),
    identity: normalizeText(safe.identity || threadMeta.identity || 'main'),
    chatId: normalizeText(safe.chatId || threadMeta.chatId),
    to: normalizeText(safe.to),
    type: normalizeText(safe.type) || 'text',
    content: normalizeText(safe.content),
    mediaUrl: normalizeText(safe.mediaUrl || safe.media_url),
    mediaMime: normalizeText(safe.mediaMime || safe.media_mime),
    caption: normalizeText(safe.caption),
    contextToken: normalizeText(safe.contextToken),
    source: normalizeText(safe.source) || 'unknown',
    status: normalizeText(safe.status) || 'pending',
    bindingId: normalizeText(safe.bindingId),
    remoteBindingId: normalizeText(safe.remoteBindingId || safe.bindingId),
    clientMessageId: normalizeText(safe.clientMessageId || safe.client_message_id),
    idempotencyKey: normalizeText(safe.idempotencyKey || safe.idempotency_key),
    messageId: normalizeText(safe.messageId),
    lastError: normalizeText(safe.lastError),
    attemptCount: Math.max(0, Number(safe.attemptCount || 0)),
    nextAttemptAt: Math.max(0, Number(safe.nextAttemptAt || 0)),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now())),
    updatedAt: Math.max(0, Number(safe.updatedAt || Date.now())),
    sentAt: Math.max(0, Number(safe.sentAt || 0))
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
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      messages: Array.isArray(parsed?.messages)
        ? parsed.messages.map((item) => normalizeOutboxMessage(item)).filter((item) => item.id)
        : []
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
    messages: Array.isArray(data?.messages) ? data.messages.map((item) => normalizeOutboxMessage(item)) : []
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
    return {
      version: STORE_VERSION,
      updatedAt: Math.max(0, Number(parsed?.updatedAt || 0)),
      messages: Array.isArray(parsed?.messages)
        ? parsed.messages.map((item) => normalizeOutboxMessage(item)).filter((item) => item.id)
        : []
    }
  }
  return readStoreFile(filePath)
}

async function writeStoreData(env = process.env, filePath = '', data = {}) {
  if (hasKvStore(env)) {
    const payload = {
      version: STORE_VERSION,
      updatedAt: Date.now(),
      messages: Array.isArray(data?.messages) ? data.messages.map((item) => normalizeOutboxMessage(item)) : []
    }
    await env.PROACTIVE_KV.put(KV_STORE_KEY, JSON.stringify(payload))
    return payload
  }
  return writeStoreFile(filePath, data)
}

export function createWechatOutboxStore(env = process.env) {
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

  const listMessages = async () => {
    const current = await load()
    return clone(current.messages || [])
  }

  const listPendingMessages = async (limit = 50, now = Date.now()) => {
    const messages = await listMessages()
    return messages
      .filter((item) => item.status === 'pending' && Number(item.nextAttemptAt || 0) <= now)
      .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
      .slice(0, Math.max(1, Number(limit || 50)))
  }

  const enqueueMessage = async (input = {}) => {
    const message = normalizeOutboxMessage(input)
    const current = await load()
    const duplicate = current.messages.find((item) => (
      message.idempotencyKey
      && String(item.idempotencyKey || '') === message.idempotencyKey
    ))
    if (duplicate) return clone(duplicate)
    current.messages.push(message)
    await persist()
    return message
  }

  const patchMessage = async (messageId = '', patch = {}) => {
    const safeMessageId = normalizeText(messageId)
    if (!safeMessageId) return null
    const current = await load()
    const index = current.messages.findIndex((item) => item.id === safeMessageId)
    if (index < 0) return null
    current.messages[index] = normalizeOutboxMessage({
      ...current.messages[index],
      ...(patch && typeof patch === 'object' ? patch : {}),
      id: safeMessageId,
      updatedAt: Date.now()
    })
    await persist()
    return clone(current.messages[index])
  }

  return {
    filePath: storageLabel,
    load,
    listMessages,
    listPendingMessages,
    enqueueMessage,
    patchMessage
  }
}

let defaultStore = null

export function getWechatOutboxStore(env = process.env) {
  if (!defaultStore) {
    defaultStore = createWechatOutboxStore(env)
  }
  return defaultStore
}
