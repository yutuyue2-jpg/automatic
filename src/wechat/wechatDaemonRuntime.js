import { getWechatDaemonStore } from './wechatDaemonStore.js'
import { getWechatOutboxStore } from './wechatOutboxStore.js'
import { sendWechatIlinkMediaMessage, sendWechatIlinkTextMessage, sendWechatIlinkTypingIndicator, syncWechatIlinkBinding } from './wechatIlinkBridge.js'

const normalizeText = (value = '') => String(value || '').trim()
const REMOTE_DEBUG_EVENT_URL = 'https://ai-phone-background.yutuyue2.workers.dev/debug/event'

const DEFAULT_POLL_INTERVAL_MS = 3000
const AUTO_REPLY_RETRY_DELAY_MS = 60 * 1000
const DEFAULT_AUTO_REPLY_HANDLER_TIMEOUT_MS = 50 * 1000
const DEFAULT_INLINE_QUIET_WAIT_MS = 12 * 1000
const DEFAULT_OUTBOX_DELIVERY_GAP_MS = 900
const DEFAULT_TYPING_KEEPALIVE_MS = 5000
const WECHAT_CONTEXT_TOKEN_MAX_AGE_MS = 23 * 60 * 60 * 1000
const BACKGROUND_PENDING_PREFIX = 'pending:'
const PROACTIVE_PENDING_LIMIT = 20

function resolvePollIntervalMs(env = process.env) {
  const parsed = Math.floor(Number(env.WECHAT_DAEMON_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS))
  if (!Number.isFinite(parsed)) return DEFAULT_POLL_INTERVAL_MS
  return Math.max(1000, Math.min(60000, parsed))
}

function resolveAutoReplyHandlerTimeoutMs(env = process.env) {
  const parsed = Math.floor(Number(env.WECHAT_DAEMON_AUTO_REPLY_TIMEOUT_MS || DEFAULT_AUTO_REPLY_HANDLER_TIMEOUT_MS))
  if (!Number.isFinite(parsed)) return DEFAULT_AUTO_REPLY_HANDLER_TIMEOUT_MS
  return Math.max(5000, Math.min(120000, parsed))
}

function resolveInlineQuietWaitMs(env = process.env) {
  const parsed = Math.floor(Number(env.WECHAT_DAEMON_INLINE_QUIET_WAIT_MS || DEFAULT_INLINE_QUIET_WAIT_MS))
  if (!Number.isFinite(parsed)) return DEFAULT_INLINE_QUIET_WAIT_MS
  return Math.max(0, Math.min(30000, parsed))
}

function resolveOutboxDeliveryGapMs(env = process.env) {
  const parsed = Math.floor(Number(env.WECHAT_OUTBOX_DELIVERY_GAP_MS || DEFAULT_OUTBOX_DELIVERY_GAP_MS))
  if (!Number.isFinite(parsed)) return DEFAULT_OUTBOX_DELIVERY_GAP_MS
  return Math.max(0, Math.min(15000, parsed))
}

function resolveTypingKeepaliveMs(env = process.env) {
  const parsed = Math.floor(Number(env.WECHAT_TYPING_KEEPALIVE_MS || DEFAULT_TYPING_KEEPALIVE_MS))
  if (!Number.isFinite(parsed)) return DEFAULT_TYPING_KEEPALIVE_MS
  return Math.max(3000, Math.min(15000, parsed))
}

function resolveAutoReplyHandler(env = process.env) {
  if (typeof env?.wechatDaemonAutoReplyHandler === 'function') return env.wechatDaemonAutoReplyHandler
  if (typeof env?.__WECHAT_DAEMON_AUTO_REPLY_HANDLER__ === 'function') return env.__WECHAT_DAEMON_AUTO_REPLY_HANDLER__
  return null
}

async function withTimeout(promise, timeoutMs = DEFAULT_AUTO_REPLY_HANDLER_TIMEOUT_MS, message = 'operation_timeout') {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))))

function isAutoReplyReady(binding = {}, now = Date.now()) {
  const bindingId = normalizeText(binding?.bindingId || binding?.remoteBindingId)
  const bindingStatus = normalizeText(binding?.status)
  if (!bindingId) return false
  if (bindingStatus && !['bound', 'pending'].includes(bindingStatus)) return false
  if (binding?.wechatReplyTriggersAi === false) return false
  if (Number(binding?.pendingInboundCount || 0) <= 0) return false
  if (normalizeText(binding?.autoReplyState || 'idle') !== 'ready') return false
  if (Number(binding?.nextAutoReplyAttemptAt || 0) > now) return false
  return true
}

function buildVisibleAutoReplyError(error = null) {
  const raw = normalizeText(error?.message || error)
  if (raw === 'wechat_daemon_background_device_missing') {
    return '小手机微信同步出错：这条微信线程还没有关联到后台设备 ID。请先打开一次对应聊天页，让最新线程快照同步到后台后再试。'
  }
  if (raw === 'wechat_daemon_background_ai_key_missing') {
    return '小手机微信同步出错：后台设备已经识别到了，但这个设备下还没有保存后台 AI Key。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_secret_missing') {
    return '小手机微信同步出错：后台解密密钥缺失，当前无法读取已保存的后台 AI Key。请检查部署环境里的 `KEY_ENCRYPTION_SECRET`。'
  }
  if (raw === 'wechat_daemon_background_ai_decrypt_failed' || raw.includes('Decryption failed')) {
    return '小手机微信同步出错：后台 AI Key 解密失败。通常是更换过加密密钥后，旧 Key 还没重新保存。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_key_invalid') {
    return '小手机微信同步出错：后台 AI Key 已读取到，但内容不完整，缺少 API Key、Base URL 或模型。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_ai_settings_missing') {
    return '小手机微信同步出错：后台 AI 配置没有读到。请重新保存一次“后台消息专用 API Key”，我这边就能继续自动回复。'
  }
  if (raw === 'wechat_daemon_auto_reply_timeout') {
    return '小手机微信同步出错：后台 AI 回复超时了。这次没有自动发出回复，我会稍后重试。'
  }
  if (raw === 'missing_context_token' || raw === 'wechat_context_token_missing') {
    return '微信同步失败：这条微信线程还没有可用的 context_token。请先在微信里给这个角色发一条消息，后台拿到会话令牌后才能主动发回微信。'
  }
  if (raw === 'wechat_context_token_expired') {
    return '微信同步失败：这条微信线程的 context_token 可能已超过 24 小时。请先在微信里给这个角色发一条消息刷新令牌。'
  }
  if (raw.startsWith('wechat_daemon_ai_request_failed:')) {
    return `小手机微信同步出错：后台 AI 请求失败（${raw.split(':').pop()}）。请检查后台消息专用 API 地址、模型或额度。`
  }
  return `小手机微信同步出错：${raw || '后台自动回复失败'}`
}

function buildLatestSentAtByThread(messages = []) {
  const latestSentAtByThread = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (normalizeText(message?.status) !== 'sent') continue
    const threadKey = normalizeText(message?.threadKey)
    if (!threadKey) continue
    const sentAt = Number(message?.sentAt || 0)
    if (!(sentAt > 0)) continue
    latestSentAtByThread.set(threadKey, Math.max(
      Number(latestSentAtByThread.get(threadKey) || 0),
      sentAt
    ))
  }
  return latestSentAtByThread
}

function listDueOutboxMessages(messages = [], limit = 20, now = Date.now()) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => normalizeText(item?.status) === 'pending' && Number(item?.nextAttemptAt || 0) <= now)
    .sort((a, b) => Number(a?.createdAt || 0) - Number(b?.createdAt || 0))
    .slice(0, Math.max(1, Number(limit || 20)))
}

function resolveTypingTarget(binding = {}) {
  const updates = Array.isArray(binding?.processingInboundUpdates) ? binding.processingInboundUpdates : []
  const latestInbound = [...updates].reverse().find((item) => normalizeText(item?.from || item?.contextToken)) || null
  return {
    to: normalizeText(latestInbound?.from || binding?.lastInboundFrom),
    contextToken: normalizeText(latestInbound?.contextToken || binding?.lastInboundContextToken)
  }
}

async function getKvJson(env = process.env, key = '', fallback = null) {
  if (!env?.PROACTIVE_KV || typeof env.PROACTIVE_KV.get !== 'function') return fallback
  const raw = await env.PROACTIVE_KV.get(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function putKvJson(env = process.env, key = '', value = null) {
  if (!env?.PROACTIVE_KV || typeof env.PROACTIVE_KV.put !== 'function') return false
  await env.PROACTIVE_KV.put(key, JSON.stringify(value))
  return true
}

export function createWechatDaemonRuntime(env = process.env) {
  const store = getWechatDaemonStore(env)
  const outboxStore = getWechatOutboxStore(env)
  const autoReplyHandler = resolveAutoReplyHandler(env)
  const autoReplyHandlerTimeoutMs = resolveAutoReplyHandlerTimeoutMs(env)
  const inlineQuietWaitMs = resolveInlineQuietWaitMs(env)
  const state = {
    started: false,
    timer: null,
    tickInFlight: false,
    lastTickAt: 0,
    lastError: '',
    pollIntervalMs: resolvePollIntervalMs(env),
    outboxDeliveryGapMs: resolveOutboxDeliveryGapMs(env),
    typingKeepaliveMs: resolveTypingKeepaliveMs(env),
    lastSyncedThreadCount: 0,
    lastUpdateCount: 0,
    lastReadyAutoReplyCount: 0,
    lastProcessedAutoReplyCount: 0
  }

  const enqueueVisibleAutoReplyError = async (binding = null, error = null) => {
    const safeBinding = binding && typeof binding === 'object' ? binding : {}
    const threadKey = normalizeText(safeBinding.threadKey)
    if (!threadKey) return
    const errorText = buildVisibleAutoReplyError(error)
    const errorKey = normalizeText(error?.message || error || 'unknown')
    const threadContext = safeBinding.threadContextSnapshot && typeof safeBinding.threadContextSnapshot === 'object'
      ? safeBinding.threadContextSnapshot
      : {}
    const deviceId = normalizeText(
      threadContext.backgroundDeviceId
      || threadContext.deviceId
      || env.WECHAT_DAEMON_BACKGROUND_DEVICE_ID
    )
    const contact = threadContext.contact && typeof threadContext.contact === 'object'
      ? threadContext.contact
      : {}
    const roleId = normalizeText(contact.id || safeBinding.roleId)
    if (deviceId && roleId) {
      const pendingKey = `${BACKGROUND_PENDING_PREFIX}${deviceId}`
      const currentPending = await getKvJson(env, pendingKey, [])
      const nextPending = [
        ...(Array.isArray(currentPending) ? currentPending : []),
        {
          messageId: `wechat_daemon_error_${Date.now()}`,
          roleId,
          roleName: normalizeText(contact.remarkName || contact.name || safeBinding.externalAccountName || '微信同步'),
          title: '微信同步出错',
          body: errorText,
          icon: normalizeText(contact.avatar || contact.avatarUrl),
          rawText: errorText,
          createdAt: Date.now(),
          data: {
            action: 'open_chat',
            roleId,
            source: 'wechat_daemon_error',
            threadKey
          }
        }
      ].slice(-PROACTIVE_PENDING_LIMIT)
      await putKvJson(env, pendingKey, nextPending).catch(() => null)
    }
    await outboxStore.enqueueMessage({
      threadMeta: safeBinding,
      to: normalizeText(safeBinding.lastInboundFrom),
      contextToken: normalizeText(safeBinding.lastInboundContextToken),
      content: errorText,
      source: 'daemon_auto_reply_error',
      idempotencyKey: [
        'wechat_daemon_auto_reply_error',
        threadKey,
        errorKey,
        Math.floor(Date.now() / (30 * 60 * 1000))
      ].join(':')
    }).catch(() => null)
  }

  const processReadyAutoReplyThread = async (binding = null) => {
    if (!binding?.threadKey || typeof autoReplyHandler !== 'function') return false
    const claimedBinding = await store.claimAutoReplyThread(binding.threadKey)
    if (!claimedBinding?.threadKey) return false
    let stopTyping = async () => {}
    try {
      stopTyping = await startWechatTypingIndicator(claimedBinding).catch((error) => {
        console.warn('[wechat-daemon] typing indicator failed', {
          threadKey: claimedBinding?.threadKey,
          error
        })
        return async () => {}
      })
      // #region debug-point B:runtime-handler-start
      fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'B',location:'server/wechatDaemonRuntime.js:processReadyAutoReplyThread',msg:'[DEBUG] daemon runtime invoking auto reply handler',data:{threadKey:claimedBinding.threadKey,processingInboundCount:Number(claimedBinding.processingInboundCount||0),snapshotUpdatedAt:Number(claimedBinding.threadContextUpdatedAt||0),hasSnapshot:!!claimedBinding.threadContextSnapshot},ts:Date.now()})}).catch(()=>{})
      // #endregion
      const result = await withTimeout(autoReplyHandler({
        env,
        binding: claimedBinding,
        inboundUpdates: claimedBinding.processingInboundUpdates || [],
        store,
        outboxStore
      }), autoReplyHandlerTimeoutMs, 'wechat_daemon_auto_reply_timeout')
      const queued = (
        result?.queued === true
        || (Array.isArray(result?.outboxMessages) && result.outboxMessages.length > 0)
        || (Array.isArray(result?.messages) && result.messages.length > 0)
      )
      if (!queued) {
        throw new Error('wechat_daemon_auto_reply_not_queued')
      }
      // #region debug-point B:runtime-handler-success
      fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'B',location:'server/wechatDaemonRuntime.js:processReadyAutoReplyThread',msg:'[DEBUG] daemon runtime handler queued outbox',data:{threadKey:claimedBinding.threadKey,outboxCount:Array.isArray(result?.outboxMessages)?result.outboxMessages.length:0,actionCount:Array.isArray(result?.actions)?result.actions.length:0},ts:Date.now()})}).catch(()=>{})
      // #endregion
      await store.completeAutoReplyThread(binding.threadKey, {
        lastAutoReplyQueuedAt: Date.now(),
        lastError: ''
      })
      return true
    } catch (error) {
      // #region debug-point B:runtime-handler-failed
      fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'B',location:'server/wechatDaemonRuntime.js:processReadyAutoReplyThread',msg:'[DEBUG] daemon runtime handler failed',data:{threadKey:claimedBinding?.threadKey||binding?.threadKey||'',error:normalizeText(error?.message||error)},ts:Date.now()})}).catch(()=>{})
      // #endregion
      await store.failAutoReplyThread(binding.threadKey, {
        lastError: normalizeText(error?.message || error),
        autoReplyLastError: normalizeText(error?.message || error),
        retryDelayMs: AUTO_REPLY_RETRY_DELAY_MS
      })
      await enqueueVisibleAutoReplyError(claimedBinding, error)
      throw error
    } finally {
      await stopTyping().catch(() => null)
    }
  }

  const startWechatTypingIndicator = async (binding = null) => {
    const safeBinding = binding && typeof binding === 'object' ? binding : {}
    const bindingId = normalizeText(safeBinding.bindingId || safeBinding.remoteBindingId)
    if (!bindingId) return async () => {}
    const target = resolveTypingTarget(safeBinding)
    if (!target.to) return async () => {}
    let stopped = false
    const sendTyping = (status = 1) => sendWechatIlinkTypingIndicator({
      env,
      bindingId,
      threadMeta: safeBinding,
      to: target.to,
      contextToken: target.contextToken,
      status
    }).catch((error) => {
      console.warn('[wechat-daemon] send typing failed', {
        threadKey: safeBinding.threadKey,
        status,
        error
      })
      return null
    })
    const firstTypingResult = await sendTyping(1)
    if (firstTypingResult?.ok !== true) return async () => {}
    const timer = setInterval(() => {
      if (stopped) return
      void sendTyping(1)
    }, state.typingKeepaliveMs)
    if (typeof timer?.unref === 'function') timer.unref()
    return async () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      await sendTyping(2)
    }
  }

  const tick = async () => {
    if (state.tickInFlight) return
    state.tickInFlight = true
    state.lastTickAt = Date.now()
    try {
      // #region debug-point B:tick-start
      fetch(REMOTE_DEBUG_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'wechat-sync-lag',
          runId: 'pre-fix',
          hypothesisId: 'H5',
          location: 'server/wechatDaemonRuntime.js:tick:start',
          msg: '[DEBUG] daemon tick started',
          data: {
            lastTickAt: Number(state.lastTickAt || 0)
          },
          ts: Date.now()
        })
      }).catch(() => {})
      // #endregion
      const bindings = await store.listBindings()
      let syncedThreadCount = 0
      let updateCount = 0
      for (const binding of bindings) {
        const bindingId = normalizeText(binding?.bindingId || binding?.remoteBindingId)
        if (!bindingId) continue
        const bindingStatus = normalizeText(binding?.status)
        if (bindingStatus && !['bound', 'pending'].includes(bindingStatus)) continue
        try {
          if (bindingStatus !== 'bound') {
            await store.patchBinding(binding, { status: 'bound', lastError: '' }).catch(() => null)
          }
          const result = await syncWechatIlinkBinding({
            env,
            bindingId,
            threadMeta: binding
          })
          syncedThreadCount += 1
          updateCount += Array.isArray(result?.updates) ? result.updates.length : 0
        } catch (error) {
          await store.patchBinding(binding, {
            lastError: normalizeText(error?.message || error),
            lastSyncFailedAt: Date.now()
          }).catch(() => null)
          console.warn('[wechat-daemon] sync binding failed', {
            threadKey: binding?.threadKey,
            error
          })
        }
      }
      let refreshedBindings = await store.listBindings()
      let recoveredAutoReplyCount = 0
      let readyAutoReplyCount = 0
      let processedAutoReplyCount = 0
      const readyBindings = []
      let now = Date.now()
      const inlineQuietWaits = refreshedBindings
        .map((binding) => ({
          pendingInboundCount: Number(binding?.pendingInboundCount || 0),
          autoReplyState: normalizeText(binding?.autoReplyState || 'idle'),
          quietUntilAt: Number(binding?.quietUntilAt || 0)
        }))
        .filter((item) => (
          inlineQuietWaitMs > 0
          && item.pendingInboundCount > 0
          && item.autoReplyState === 'waiting_quiet'
          && item.quietUntilAt > now
          && item.quietUntilAt - now <= inlineQuietWaitMs
        ))
        .map((item) => item.quietUntilAt - now)
      if (inlineQuietWaits.length) {
        await sleep(Math.min(...inlineQuietWaits))
        refreshedBindings = await store.listBindings()
        now = Date.now()
      }
      for (const binding of refreshedBindings) {
        const autoReplyState = normalizeText(binding?.autoReplyState || 'idle')
        const startedAt = Number(binding?.lastAutoReplyStartedAt || 0)
        const processingInboundCount = Number(binding?.processingInboundCount || 0)
        if (
          autoReplyState === 'processing'
          && processingInboundCount > 0
          && startedAt > 0
          && now - startedAt > autoReplyHandlerTimeoutMs
        ) {
          await store.failAutoReplyThread(binding.threadKey, {
            lastError: 'wechat_daemon_auto_reply_timeout',
            autoReplyLastError: 'wechat_daemon_auto_reply_timeout',
            retryDelayMs: 0
          })
          recoveredAutoReplyCount += 1
        }
      }
      const replyCandidateBindings = recoveredAutoReplyCount > 0
        ? await store.listBindings()
        : refreshedBindings
      for (const binding of replyCandidateBindings) {
        const pendingInboundCount = Number(binding?.pendingInboundCount || 0)
        const bindingId = normalizeText(binding?.bindingId || binding?.remoteBindingId)
        const bindingStatus = normalizeText(binding?.status)
        if (!bindingId) continue
        if (bindingStatus && !['bound', 'pending'].includes(bindingStatus)) continue
        if (binding?.wechatReplyTriggersAi === false) continue
        if (pendingInboundCount <= 0) continue
        const quietUntilAt = Number(binding?.quietUntilAt || 0)
        const autoReplyState = normalizeText(binding?.autoReplyState || 'idle')
        if (quietUntilAt > 0 && quietUntilAt <= now && autoReplyState !== 'ready') {
          const readyBinding = await store.markAutoReplyReady(binding.threadKey)
          readyAutoReplyCount += 1
          if (readyBinding?.threadKey) readyBindings.push(readyBinding)
          continue
        }
        if (isAutoReplyReady(binding, now)) {
          readyAutoReplyCount += 1
          readyBindings.push(binding)
        }
      }
      if (typeof autoReplyHandler === 'function') {
        for (const binding of readyBindings) {
          try {
            const handled = await processReadyAutoReplyThread(binding)
            if (handled) processedAutoReplyCount += 1
          } catch (error) {
            console.warn('[wechat-daemon] auto reply thread failed', {
              threadKey: binding?.threadKey,
              error
            })
          }
        }
      }
      // #region debug-point B:tick-ready-summary
      fetch(REMOTE_DEBUG_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'wechat-sync-lag',
          runId: 'pre-fix',
          hypothesisId: 'H5',
          location: 'server/wechatDaemonRuntime.js:tick:ready-summary',
          msg: '[DEBUG] daemon tick ready summary',
          data: {
            syncedThreadCount,
            updateCount,
            recoveredAutoReplyCount,
            readyAutoReplyCount,
            processedAutoReplyCount,
            readyThreadKeys: readyBindings.map((item) => normalizeText(item?.threadKey)).filter(Boolean).slice(0, 8)
          },
          ts: Date.now()
        })
      }).catch(() => {})
      // #endregion
      const latestBindings = await store.listBindings()
      const allOutboxMessages = await outboxStore.listMessages()
      const latestSentAtByThread = buildLatestSentAtByThread(allOutboxMessages)
      const pendingMessages = listDueOutboxMessages(allOutboxMessages, 20, Date.now())
      for (const message of pendingMessages) {
        const binding = latestBindings.find((item) => item.threadKey === message.threadKey)
        const bindingId = normalizeText(message.bindingId || message.remoteBindingId || binding?.bindingId || binding?.remoteBindingId)
        if (!bindingId) {
          await outboxStore.patchMessage(message.id, {
            status: 'failed',
            lastError: 'missing_binding_id',
            attemptCount: Number(message.attemptCount || 0) + 1,
            nextAttemptAt: Date.now() + 60 * 1000
          })
          continue
        }
        try {
          const threadKey = normalizeText(message.threadKey || binding?.threadKey)
          const lastSentAt = Number(latestSentAtByThread.get(threadKey) || 0)
          const nextAllowedAt = lastSentAt + state.outboxDeliveryGapMs
          if (threadKey && state.outboxDeliveryGapMs > 0 && lastSentAt > 0 && nextAllowedAt > Date.now()) {
            await outboxStore.patchMessage(message.id, {
              nextAttemptAt: nextAllowedAt
            })
            continue
          }
          const targetTo = normalizeText(message.to || binding?.lastInboundFrom)
          const contextToken = normalizeText(message.contextToken || binding?.lastInboundContextToken)
          if (!contextToken) {
            throw new Error('wechat_context_token_missing')
          }
          const lastInboundAt = Number(binding?.lastInboundAt || 0)
          if (lastInboundAt > 0 && Date.now() - lastInboundAt > WECHAT_CONTEXT_TOKEN_MAX_AGE_MS) {
            throw new Error('wechat_context_token_expired')
          }
          // #region debug-point D:runtime-outbox-send-attempt
          fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'D',location:'server/wechatDaemonRuntime.js:tick',msg:'[DEBUG] daemon runtime sending outbox message',data:{messageId:message.id,threadKey:message.threadKey||binding?.threadKey||'',bindingId,hasTo:!!targetTo,hasContextToken:!!contextToken,contentPreview:normalizeText(message.content).slice(0,80),source:normalizeText(message.source)},ts:Date.now()})}).catch(()=>{})
          // #endregion
          const sendResult = normalizeText(message.type) === 'image'
            ? await sendWechatIlinkMediaMessage({
              env,
              bindingId,
              threadMeta: binding || message,
              message: {
                to: targetTo,
                content: message.content,
                caption: message.caption,
                mediaUrl: message.mediaUrl,
                mediaMime: message.mediaMime,
                type: message.type,
                contextToken
              }
            })
            : await sendWechatIlinkTextMessage({
              env,
              bindingId,
              threadMeta: binding || message,
              message: {
                to: targetTo,
                content: message.content,
                contextToken
              }
            })
          // #region debug-point D:runtime-outbox-send-success
          fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'D',location:'server/wechatDaemonRuntime.js:tick',msg:'[DEBUG] daemon runtime sent outbox message',data:{messageId:message.id,threadKey:message.threadKey||binding?.threadKey||'',externalMessageId:normalizeText(sendResult?.messageId)},ts:Date.now()})}).catch(()=>{})
          // #endregion
          const sentAt = Date.now()
          await outboxStore.patchMessage(message.id, {
            status: 'sent',
            messageId: normalizeText(sendResult?.messageId),
            sentAt,
            lastError: '',
            attemptCount: Number(message.attemptCount || 0) + 1
          })
          if (threadKey) latestSentAtByThread.set(threadKey, sentAt)
        } catch (error) {
          // #region debug-point D:runtime-outbox-send-failed
          fetch('http://127.0.0.1:7777/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'wechat-daemon-sync',runId:'pre-fix',hypothesisId:'D',location:'server/wechatDaemonRuntime.js:tick',msg:'[DEBUG] daemon runtime failed to send outbox message',data:{messageId:message.id,threadKey:message.threadKey||binding?.threadKey||'',error:normalizeText(error?.message||error)},ts:Date.now()})}).catch(()=>{})
          // #endregion
          const nextAttemptCount = Number(message.attemptCount || 0) + 1
          await outboxStore.patchMessage(message.id, {
            status: nextAttemptCount >= 5 ? 'failed' : 'pending',
            lastError: normalizeText(error?.message || error),
            attemptCount: nextAttemptCount,
            nextAttemptAt: Date.now() + Math.min(5, nextAttemptCount) * 60 * 1000
          })
        }
      }
      state.lastSyncedThreadCount = syncedThreadCount
      state.lastUpdateCount = updateCount
      state.lastReadyAutoReplyCount = readyAutoReplyCount
      state.lastProcessedAutoReplyCount = processedAutoReplyCount
      state.lastError = ''
      // #region debug-point B:tick-finished
      fetch(REMOTE_DEBUG_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'wechat-sync-lag',
          runId: 'pre-fix',
          hypothesisId: 'H5',
          location: 'server/wechatDaemonRuntime.js:tick:finished',
          msg: '[DEBUG] daemon tick finished',
          data: {
            lastSyncedThreadCount: syncedThreadCount,
            lastUpdateCount: updateCount,
            lastReadyAutoReplyCount: readyAutoReplyCount,
            lastProcessedAutoReplyCount: processedAutoReplyCount,
            pendingOutboxCount: (await outboxStore.listPendingMessages(200, Date.now())).length
          },
          ts: Date.now()
        })
      }).catch(() => {})
      // #endregion
    } catch (error) {
      state.lastError = normalizeText(error?.message || error)
      console.warn('[wechat-daemon] tick failed', error)
    } finally {
      state.tickInFlight = false
    }
  }

  const start = () => {
    if (state.started) return
    state.started = true
    state.timer = setInterval(() => {
      tick().catch((error) => {
        state.lastError = normalizeText(error?.message || error)
      })
    }, state.pollIntervalMs)
    if (typeof state.timer?.unref === 'function') state.timer.unref()
    tick().catch((error) => {
      state.lastError = normalizeText(error?.message || error)
    })
  }

  const stop = () => {
    if (state.timer) clearInterval(state.timer)
    state.timer = null
    state.started = false
  }

  const getStatus = async () => {
    const bindings = await store.listBindings()
    return {
      ok: true,
      service: 'wechat-daemon-runtime',
      enabled: env.WECHAT_DAEMON_ENABLED === '1' || env.WECHAT_DAEMON_ENABLED === 'true',
      started: state.started,
      pollIntervalMs: state.pollIntervalMs,
      outboxDeliveryGapMs: state.outboxDeliveryGapMs,
      lastTickAt: state.lastTickAt,
      lastSyncedThreadCount: state.lastSyncedThreadCount,
      lastUpdateCount: state.lastUpdateCount,
      lastReadyAutoReplyCount: state.lastReadyAutoReplyCount,
      lastProcessedAutoReplyCount: state.lastProcessedAutoReplyCount,
      autoReplyHandlerEnabled: typeof autoReplyHandler === 'function',
      lastError: state.lastError,
      threadCount: bindings.length,
      pendingOutboxCount: (await outboxStore.listPendingMessages(200, Date.now())).length,
      threadKeys: bindings.map((item) => item.threadKey).filter(Boolean).slice(0, 20),
      storeFilePath: store.filePath
    }
  }

  return {
    start,
    stop,
    tick,
    getStatus,
    store,
    outboxStore
  }
}

let defaultRuntime = null

export function getWechatDaemonRuntime(env = process.env) {
  if (!defaultRuntime) {
    defaultRuntime = createWechatDaemonRuntime(env)
  }
  return defaultRuntime
}
