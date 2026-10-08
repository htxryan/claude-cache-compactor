import type { EngineInterface, Register, Timer } from 'claude-code'

import { check, compactedText, describe, dueAt, expiresAt, readSettings, resolveCache } from '../compact/plan'
import type { Cache, Last, Settings, State } from '../compact/plan'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Per-session bookkeeping, reset when the session ends (/clear, /resume).
type Session = State & { timer: Timer | null; due: number | null; last: Last | null; cache: Cache | null; gen: number; marked: boolean }

function cancel(ss: Session): void {
  ss.timer?.cancel()
  ss.timer = null
  ss.due = null
}

// A headless run (claude -p) ends with its answer: nobody comes back to it.
async function interactive($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

// How long this session's cache lasts, from the variables and setting Claude
// Code reads for prompt caching, the model, and the plan's usage windows.
async function readCache($: EngineInterface, s: Settings): Promise<Cache> {
  const env = {
    DISABLE_PROMPT_CACHING: await $.env.get('DISABLE_PROMPT_CACHING'),
    DISABLE_PROMPT_CACHING_FABLE: await $.env.get('DISABLE_PROMPT_CACHING_FABLE'),
    DISABLE_PROMPT_CACHING_OPUS: await $.env.get('DISABLE_PROMPT_CACHING_OPUS'),
    DISABLE_PROMPT_CACHING_SONNET: await $.env.get('DISABLE_PROMPT_CACHING_SONNET'),
    DISABLE_PROMPT_CACHING_HAIKU: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU'),
    FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    ENABLE_PROMPT_CACHING_1H: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
    CLAUDE_CODE_USE_BEDROCK: await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
    CLAUDE_CODE_USE_VERTEX: await $.env.get('CLAUDE_CODE_USE_VERTEX'),
    CLAUDE_CODE_USE_FOUNDRY: await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
  }
  const settings = await $.settings.read()
  const usage = await $.session.usage().catch(() => null)
  return resolveCache(s, { env, promptCacheTtl: settings.promptCacheTtl, model: await $.session.model(), rateLimits: usage?.rateLimits ?? [] })
}

// Sessions whose last event was a compaction, by id, kept in the plugin's
// store so a resumed session knows (newest 100).
async function remember($: EngineInterface, ss: Session, compacted: boolean): Promise<void> {
  ss.marked = compacted
  const id = await $.session.id()
  const prev = (await $.store.get('compacted')) as Record<string, number> | undefined
  const map = { ...(prev ?? {}) }
  delete map[id]
  if (compacted) map[id] = await $.clock.now()
  await $.store.set('compacted', Object.fromEntries(Object.entries(map).slice(-100)))
}

async function compactedLast($: EngineInterface): Promise<boolean> {
  const map = (await $.store.get('compacted')) as Record<string, number> | undefined
  if (map && (await $.session.id()) in map) return true
  // A session compacted before this plugin knew it: the summary, then only
  // the replies compaction kept, no prompt of yours.
  const messages = await $.session.messages()
  const summary = messages.findLastIndex(m => m.role === 'user' && m.text.includes('continued from a previous conversation'))
  return summary >= 0 && !messages.slice(summary + 1).some(m => m.role === 'user' && m.text.trim() !== '')
}

// The conversation's size, the Messages row of /context (estimated locally, no
// request): the system prompt and tools stay whatever compaction does.
async function conversationTokens($: EngineInterface): Promise<number | undefined> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  return usage?.context.breakdown?.categories.find(c => c.name === 'Messages')?.tokens
}

// Sets the timer for the cache's last minutes, counted from the last request.
// It reads everything first and decides after, with `settle` applied then: a
// turn that started meanwhile (`gen` moved on) leaves it unset.
async function arm($: EngineInterface, ss: Session, s: Settings, settle: () => void = () => {}): Promise<void> {
  const gen = ss.gen
  const isInteractive = await interactive($)
  const cache = await readCache($, s)
  const now = await $.clock.now()
  if (ss.gen !== gen) return
  settle()
  cancel(ss)
  ss.cache = cache
  if (ss.anchor === null || ss.lastWasCompact || ss.turning || !isInteractive || cache.ttlMs === null) return
  // A resumed session whose cache has already expired has nothing left to save.
  if (now >= expiresAt(ss.anchor, cache.ttlMs)) return
  const at = dueAt(ss.anchor, cache.ttlMs, s)
  ss.due = at
  ss.timer = $.clock.after(Math.max(0, at - now), () => void fire($, ss, s, at))
}

// The timer went off: compact, unless something changed since it was set.
async function fire($: EngineInterface, ss: Session, s: Settings, at: number): Promise<void> {
  if (ss.due !== at) return
  ss.timer = null
  ss.due = null
  const now = await $.clock.now()
  const tokens = await conversationTokens($)
  const verdict = check(ss, now, tokens, ss.cache ?? { ttlMs: null, why: 'unknown' }, s)
  if (!verdict.compact) {
    ss.last = { at: now, outcome: 'skipped', reason: verdict.reason }
    $.ui.log(`didn't compact: ${verdict.reason}.`, { to: 'debug' })
    return
  }
  const idleMs = now - ss.anchor!
  $.ui.status('compacting before the prompt cache expires…')
  try {
    const result = await $.session.compact(s.instructions ? { instructions: s.instructions } : {})
    if (result.skip !== undefined) {
      // Another plugin or a PreCompact hook vetoed it; the engine says why.
      ss.last = { at: now, outcome: 'skipped', reason: `a hook skipped it (${result.skip})` }
      return
    }
    ss.lastWasCompact = true
    await remember($, ss, true)
    const done: Last = { at: now, outcome: 'compacted', idleMs, before: result.tokensBefore, after: result.tokensAfter, cacheRead: result.usage?.cache_read_input_tokens }
    ss.last = done
    $.ui.log(compactedText(done))
  } catch (err) {
    // A prompt sent while it was getting ready: that turn sets a new timer.
    const reason = ss.turning ? 'a turn started first' : message(err)
    ss.last = { at: now, outcome: 'failed', reason }
    if (!ss.turning) $.ui.log(`couldn't compact before the prompt cache expires: ${reason}`)
  } finally {
    $.ui.status(undefined)
  }
}

export const register: Register = (on, options) => {
  const invalid: string[] = []
  const s = readSettings(options, invalid)
  let warned = false // invalid settings were named once in this process
  const ss: Session = { anchor: null, lastWasCompact: false, turning: false, timer: null, due: null, last: null, cache: null, gen: 0, marked: false }

  // /cache-compactor:status (commands/status.md), answered here without the model.
  on('command.run', { command: 'cache-compactor:status' }, async $ => ({
    text: describe({ state: ss, now: await $.clock.now(), due: ss.due, last: ss.last, cache: ss.cache, interactive: await interactive($) }),
  })).catch(() => ({ text: "cache-compactor couldn't read its status." }))

  on('prompt.submit', async ($, e, next) => {
    if (invalid.length && !warned) {
      warned = true
      $.ui.log(`ignoring invalid settings: ${invalid.join('; ')}.`)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A main-conversation turn: no timer while it runs, and what it says next
  // is not a compaction. (Subagents' runs raise no turn.start.)
  on('turn.start', async ($, e, next) => {
    cancel(ss)
    ss.gen += 1
    ss.turning = true
    ss.lastWasCompact = false
    if (ss.marked) await remember($, ss, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each main-conversation request reads or writes the cache, so its start is
  // the moment the cache's hour counts from. Subagents' requests have a cache
  // of their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) ss.anchor = await $.clock.now()
    return yield* next(e)
  })

  // The response is in, or the turn was interrupted or failed: start the timer
  // from the turn's last request.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await arm($, ss, s, () => {
        ss.turning = false
        ss.lastWasCompact = false
      })
    }
    return result
  })

  // Any compaction of the main conversation (/compact, the automatic one, a
  // plugin's) counts as the last thing that happened until the next turn.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      ss.lastWasCompact = true
      if (!ss.turning) cancel(ss)
      await remember($, ss, true)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A resumed session's cache may still be warm: count from its last response,
  // unless a compaction came after it.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if ((e.source === 'resume' || e.source === 'fork') && e.seconds_since_last_response !== undefined && !ss.turning) {
      if (await compactedLast($)) {
        ss.lastWasCompact = ss.marked = true
        return result
      }
      const anchor = (await $.clock.now()) - e.seconds_since_last_response * 1000
      await arm($, ss, s, () => {
        ss.anchor = anchor
        ss.lastWasCompact = false
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  // /clear, or /resume of another conversation, ends the session without a
  // new session.start.
  on('session.end', async ($, e, next) => {
    cancel(ss)
    ss.gen += 1
    ss.anchor = null
    ss.lastWasCompact = false
    ss.turning = false
    ss.last = null
    ss.cache = null
    ss.marked = false
    return next(e)
  })
}
