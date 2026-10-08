import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULTS, check, compactedText, duration, k, readSettings, resolveCache } from '../compact/plan'
import type { Signals } from '../compact/plan'

const MIN = 60_000
const T0 = 1_760_000_000_000 // where the mocked clock starts
const SUMMARY = { messages: [{ role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }], tokensBefore: 152_000, tokensAfter: 9_400, usage: { input_tokens: 12, output_tokens: 3_100, cache_read_input_tokens: 151_000, cache_creation_input_tokens: 0 } }

// `tokens`: the conversation's size, the Messages row of /context. `compact`: how
// the engine answers a compaction. `surfaces`: what draws the session (none in
// a headless run).
// `rateLimits`: the plan's usage windows the last response reported (a Claude
// subscription's by default). `vars` and `promptCacheTtl`: Claude Code's
// prompt-caching variables and setting.
type Env = {
  transcript?: { role: 'user' | 'assistant'; text?: string }[]
  tokens?: number
  compact?: 'ok' | 'skip' | 'reject'
  surfaces?: string[]
  rateLimits?: { kind: string; percentUsed: number }[]
  vars?: Record<string, string>
  promptCacheTtl?: string
  whileArming?: ($: any) => Promise<void>
  store?: Record<string, unknown>
}
const PLAN = [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40 }]
const HOUR: { ttlMs: number; why: string } = { ttlMs: 60 * MIN, why: 'Claude subscription' }

// Stands in for the engine beneath the plugin.
function engine(on: On, env: Env = {}) {
  const calls = { compacts: [] as string[], logs: [] as string[], debug: [] as string[], status: [] as (string | undefined)[] }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, env.store ?? {})
  on('session.id', () => value('s1'))
  const value = <T>(v: T) => ({ value: v }) as never
  on('session.surfaces', async $ => {
    const run = env.whileArming
    env.whileArming = undefined
    await run?.($)
    return value(env.surfaces ?? ['terminal'])
  })
  on('session.usage', (_$, e) => {
    const breakdown = (e as { breakdown?: string }).breakdown
      ? { categories: [{ name: 'System prompt', tokens: 40_000, kind: 'used' }, { name: 'Messages', tokens: env.tokens ?? 112_000, kind: 'used' }, { name: 'Free space', tokens: 800_000, kind: 'free' }] }
      : undefined
    return value({ startedAt: T0, context: { tokens: 40_000 + (env.tokens ?? 112_000), window: 1_000_000, percent: 15, breakdown }, rateLimits: env.rateLimits ?? PLAN })
  })
  on('session.model', () => value('claude-opus-5-5'))
  on('session.messages', () => value((env.transcript ?? [{ role: 'user' }, { role: 'assistant' }]).map(m => ({ text: '', toolUses: [], ...m }))))
  on('settings.read', () => value(env.promptCacheTtl ? { promptCacheTtl: env.promptCacheTtl } : {}))
  mock.env(on, env.vars ?? {})
  on('session.compact', (_$, e) => {
    // The kit hands a plugin's compaction on without the engine's trigger and transcript.
    calls.compacts.push(`compact:${e.instructions ?? ''}`)
    if (env.compact === 'skip') return { skip: 'a PreCompact hook said no' }
    if (env.compact === 'reject') throw new Error('Not enough messages to compact.')
    return SUMMARY as never
  })
  on('ui.log', (_$, e) => {
    ;(e.to === 'debug' ? calls.debug : calls.logs).push(e.text)
    return value(undefined)
  })
  on('ui.status', (_$, e) => {
    calls.status.push((e as { text?: string }).text)
    return value(undefined)
  })
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('classic.SessionStart', () => ({}) as never)
  turnNo = 0
  return { calls, clock }
}
let turnNo = 0

// A compaction the engine runs (/compact, or the automatic one at its threshold).
const compactNow = ($: any, trigger = 'manual') => $.session.compact({ trigger, messages: SUMMARY.messages } as never)

// One main-conversation turn: a prompt, `requests` model requests `gap` ms
// apart, and the answer. Subagent requests in between, when given.
async function turn($: any, clock: { advance: (ms: number) => Promise<void> }, opts: { requests?: number; gap?: number; tail?: number; agent?: string; reason?: string } = {}) {
  const sent = await $.prompt.submit({ text: 'do the thing', wait: false, origin: { kind: 'composer' } })
  const turnId = `t${++turnNo}`
  await $.turn.start({ text: sent.text, turnId })
  for (let i = 0; i < (opts.requests ?? 1); i++) {
    if (i > 0) await clock.advance(opts.gap ?? 0)
    for await (const _ of $.turn.step({ turnId, index: i, model: 'claude-opus-5-5', messageCount: 1 })) {}
  }
  if (opts.agent) {
    await clock.advance(opts.gap ?? 0)
    for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: opts.agent })) {}
  }
  if (opts.tail) await clock.advance(opts.tail)
  await $.turn.complete({ turnId, reason: opts.reason ?? 'answer', answer: 'done', durationMs: 1000, isAborted: opts.reason === 'aborted' })
}

const status = async ($: any): Promise<string> =>
  (await $.command.run({ command: 'cache-compactor:status', args: '', origin: { kind: 'composer' }, presentation: {} })).text ?? ''

const command = async ($: any, name: string): Promise<string> =>
  (await $.command.run({ command: `cache-compactor:${name}`, args: '', origin: { kind: 'composer' }, presentation: {} })).text ?? ''

const resume = ($: any, secondsAgo: number) =>
  $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'resume', session_id: 's', transcript_path: '', cwd: '', seconds_since_last_response: secondsAgo } as never)

describe('timing logic', () => {
  test('reads the settings and falls back on bad values', () => {
    const invalid: string[] = []
    expect(readSettings({}, invalid)).toEqual({ minCacheTtlMs: 60 * MIN, leadMs: 120_000, minTokens: DEFAULTS.minTokens, instructions: '' })
    expect(readSettings({ minCacheTtlSeconds: 300, leadSeconds: 30, minTokens: 0, instructions: ' keep the plan ' }, invalid)).toEqual({ minCacheTtlMs: 5 * MIN, leadMs: 30_000, minTokens: 0, instructions: 'keep the plan' })
    expect(invalid).toEqual([])
    const bad = readSettings({ minCacheTtlSeconds: -5, leadSeconds: 3600, minTokens: 'lots' }, invalid)
    expect(bad).toMatchObject({ minCacheTtlMs: 60 * MIN, leadMs: 120_000, minTokens: DEFAULTS.minTokens })
    expect(invalid).toEqual(['minCacheTtlSeconds "-5" (using 3600)', 'leadSeconds "3600" (using 120)', 'minTokens "lots" (using 30000)'])
  })

  test('works out how long the cache lasts as Claude Code does', () => {
    const auto = readSettings({}, [])
    const sig = (over: Partial<Signals> = {}): Signals => ({ env: {}, promptCacheTtl: undefined, model: 'claude-opus-5-5', rateLimits: PLAN, ...over })
    expect(resolveCache(auto, sig())).toEqual(HOUR)
    expect(resolveCache(auto, sig({ rateLimits: [] }))).toEqual({
      ttlMs: null,
      why: 'the prompt cache lasts only 5 min here (no Claude plan usage reported, so an API key), under minCacheTtlSeconds (3600). Set minCacheTtlSeconds to 300 or less to compact these sessions too',
    })
    expect(resolveCache(auto, sig({ rateLimits: [{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 60 }] })).ttlMs).toBe(null)
    expect(resolveCache(auto, sig({ rateLimits: [], env: { ENABLE_PROMPT_CACHING_1H: '1' } }))).toEqual({ ttlMs: 60 * MIN, why: 'ENABLE_PROMPT_CACHING_1H' })
    expect(resolveCache(auto, sig({ rateLimits: [], promptCacheTtl: '1h' }))).toEqual({ ttlMs: 60 * MIN, why: 'promptCacheTtl is 1h' })
    expect(resolveCache(auto, sig({ promptCacheTtl: '1h', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })).ttlMs).toBe(null)
    expect(resolveCache(auto, sig({ env: { FORCE_PROMPT_CACHING_5M: 'true', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })).ttlMs).toBe(null)
    expect(resolveCache(auto, sig({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).ttlMs).toBe(null)
    expect(resolveCache(auto, sig({ env: { DISABLE_PROMPT_CACHING_OPUS: '1' } }))).toEqual({ ttlMs: null, why: 'prompt caching is off (DISABLE_PROMPT_CACHING_OPUS)' })
    expect(resolveCache(auto, sig({ env: { DISABLE_PROMPT_CACHING_SONNET: '1' } }))).toEqual(HOUR)
    // A lower minCacheTtlSeconds takes five-minute caches too; turning caching off still wins.
    const five = readSettings({ minCacheTtlSeconds: 300 }, [])
    expect(resolveCache(five, sig({ rateLimits: [] }))).toEqual({ ttlMs: 5 * MIN, why: 'no Claude plan usage reported, so an API key' })
    expect(resolveCache(five, sig({ env: { DISABLE_PROMPT_CACHING: '1' } })).ttlMs).toBe(null)
    expect(resolveCache(readSettings({ minCacheTtlSeconds: 300, leadSeconds: 300 }, []), sig({ rateLimits: [] }))).toEqual({
      ttlMs: null,
      why: "leadSeconds (300) is no shorter than this session's 5 min prompt cache",
    })
  })

  test('compacts only an idle, compactable session with the cache still warm', () => {
    const s = readSettings({}, [])
    const idle = { anchor: T0, lastWasCompact: false, turning: false, off: false }
    expect(check(idle, T0 + 58 * MIN, 152_000, HOUR, s)).toEqual({ compact: true })
    expect(check(idle, T0 + 58 * MIN, undefined, HOUR, s)).toEqual({ compact: true })
    expect(check({ ...idle, anchor: null }, T0, 152_000, HOUR, s)).toEqual({ compact: false, reason: 'nothing has been sent to Claude yet' })
    expect(check({ ...idle, lastWasCompact: true }, T0 + 58 * MIN, 152_000, HOUR, s)).toEqual({ compact: false, reason: 'the last thing that happened was a compaction' })
    expect(check({ ...idle, turning: true }, T0 + 58 * MIN, 152_000, HOUR, s)).toEqual({ compact: false, reason: 'a turn is running' })
    expect(check({ ...idle, off: true }, T0 + 58 * MIN, 152_000, HOUR, s)).toEqual({ compact: false, reason: 'it is turned off for this session' })
    expect(check(idle, T0 + 60 * MIN, 152_000, HOUR, s)).toEqual({ compact: false, reason: 'the cache had already expired (1 h since the last request, so the computer was probably asleep)' })
    expect(check(idle, T0 + 58 * MIN, 12_000, HOUR, s)).toEqual({ compact: false, reason: 'the conversation is small (12k tokens, under minTokens 30k)' })
  })

  test('says what a compaction did', () => {
    expect(compactedText({ at: 0, outcome: 'compacted', idleMs: 58 * MIN, before: 152_000, after: 9_400, cacheRead: 151_000 })).toBe(
      'compacted after 58 min idle, before the prompt cache expires: 152k → 9k tokens (151k read from the cache).',
    )
    expect(compactedText({ at: 0, outcome: 'compacted', idleMs: 58 * MIN, cacheRead: 0 })).toBe(
      'compacted after 58 min idle, before the prompt cache expires (nothing was read from the cache).',
    )
    expect(compactedText({ at: 0, outcome: 'compacted', idleMs: 90_000 })).toBe('compacted after 2 min idle, before the prompt cache expires.')
  })

  test('formats durations and token counts', () => {
    expect([duration(45_000), duration(58 * MIN), duration(60 * MIN), duration(65 * MIN), k(950), k(151_400)]).toEqual(['45 s', '58 min', '1 h', '1 h 5 min', '950', '151k'])
  })
})

describe('compacting an idle session', () => {
  test('compacts 58 minutes after the last request, once', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(58 * MIN - 1)
    expect(calls.compacts).toEqual([])
    await clock.advance(1)
    expect(calls.compacts).toEqual(['compact:'])
    expect(calls.logs).toEqual(['compacted after 58 min idle, before the prompt cache expires: 152k → 9k tokens (151k read from the cache).'])
    expect(calls.status).toEqual(['compacting before the prompt cache expires…', undefined])
    // The compaction was the last thing that happened: never again until a new turn.
    await clock.advance(5 * 60 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
    expect(await status($)).toBe(
      'Not scheduled: the last thing that happened was a compaction. The timer starts again after your next prompt.\n' +
        'Last: compacted 5 h ago after 58 min idle, before the prompt cache expires: 152k → 9k tokens (151k read from the cache).',
    )
  })

  test('the next turn after a compaction starts the timer again', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(58 * MIN)
    await clock.advance(10 * MIN)
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:', 'compact:'])
  })

  test('every message or response pushes it back', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(50 * MIN)
    await turn($, clock)
    await clock.advance(50 * MIN)
    expect(calls.compacts).toEqual([])
    await clock.advance(8 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('counts from the turn’s last request, not from when it ended', async ($, on) => {
    const { calls, clock } = engine(on)
    // Three requests 10 minutes apart, the last one starting at +20 min and
    // streaming for 10 more.
    await turn($, clock, { requests: 3, gap: 10 * MIN, tail: 10 * MIN })
    await clock.advance(48 * MIN - 1)
    expect(calls.compacts).toEqual([])
    await clock.advance(1)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('a subagent’s requests don’t count: they have a cache of their own', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock, { agent: 'a1', gap: 30 * MIN })
    await clock.advance(28 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('no timer while a turn runs, however long', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(30 * MIN)
    await $.turn.start({ text: 'a long one', turnId: 'long' })
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(await status($)).toBe('Not scheduled while a turn runs: the timer starts when it ends.')
  })

  test('a turn that starts while the timer is being set keeps it unset', async ($, on) => {
    const env: Env = {}
    const { calls, clock } = engine(on, env)
    env.whileArming = async $ => {
      await $.turn.start({ text: 'next', turnId: 'next' })
    }
    await turn($, clock)
    expect(await status($)).toBe('Not scheduled while a turn runs: the timer starts when it ends.')
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
  })

  test('an interrupted turn still counts its requests', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock, { reason: 'aborted' })
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('status says when it will compact', async ($, on) => {
    const { clock } = engine(on)
    expect(await status($)).toBe('Not scheduled: nothing has been sent to Claude yet.')
    await turn($, clock)
    await clock.advance(20 * MIN)
    expect(await status($)).toBe('Compacts in 38 min if the session stays idle: the prompt cache expires 1 h after the last request (Claude subscription).')
  })

  test('passes the instructions setting on', { options: { instructions: 'Keep the open TODOs.' } }, async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:Keep the open TODOs.'])
  })

  test('follows leadSeconds', { options: { leadSeconds: 300 } }, async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(55 * MIN - 1)
    expect(calls.compacts).toEqual([])
    await clock.advance(1)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('names invalid settings once', { options: { minCacheTtlSeconds: -5 } }, async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await turn($, clock)
    expect(calls.logs).toEqual(['ignoring invalid settings: minCacheTtlSeconds "-5" (using 3600).'])
  })
})

describe('when it leaves the session alone', () => {
  test('a compaction you ran is the last thing that happened', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await clock.advance(20 * MIN)
    await compactNow($) // /compact
    expect(calls.compacts).toEqual(['compact:'])
    await clock.advance(60 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('an automatic compaction during a turn is followed by its answer', async ($, on) => {
    const { calls, clock } = engine(on)
    const sent = await $.prompt.submit({ text: 'big job', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'big job', turnId: 'big' })
    await compactNow($, 'auto') // the threshold, mid-turn
    for await (const _ of $.turn.step({ turnId: 'big', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {}
    await $.turn.complete({ turnId: 'big', reason: 'answer', answer: 'done', durationMs: 1000, isAborted: false })
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:', 'compact:'])
  })

  test('a small conversation is left alone', async ($, on) => {
    const { calls, clock } = engine(on, { tokens: 12_000 })
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual([])
    expect(calls.logs).toEqual([])
    expect(calls.debug).toEqual(["didn't compact: the conversation is small (12k tokens, under minTokens 30k)."])
  })

  test('minTokens 0 compacts any idle session', { options: { minTokens: 0 } }, async ($, on) => {
    const { calls, clock } = engine(on, { tokens: 12_000 })
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('headless runs set no timer', async ($, on) => {
    const { calls, clock } = engine(on, { surfaces: [] })
    await turn($, clock)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(await status($)).toBe('Not scheduled: nothing draws this session (a headless run).')
  })

  test('/clear cancels the timer', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await $.session.end({ sessionId: 's', reason: 'clear' } as never)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
  })

  test('a hook that vetoes the compaction is respected, and the next turn tries again', async ($, on) => {
    const { calls, clock } = engine(on, { compact: 'skip' })
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
    expect(calls.logs).toEqual([])
    expect(await status($)).toContain("Last: didn't compact 0 s ago: a hook skipped it (a PreCompact hook said no).")
  })

  test('a failed compaction is reported', async ($, on) => {
    const { calls, clock } = engine(on, { compact: 'reject' })
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.logs).toHaveLength(1)
    expect(calls.logs[0]).toStartWith("couldn't compact before the prompt cache expires: ")
    expect(calls.status).toEqual(['compacting before the prompt cache expires…', undefined])
  })
})

describe('turning it off for a session', () => {
  test('/cache-compactor:off stops the timer and says how to turn it back on', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    expect(await command($, 'off')).toBe('Automatic compaction is now off for this session. /cache-compactor:on turns it back on.')
    expect(calls.status).toEqual(['auto-compact off'])
    await clock.advance(3 * 60 * MIN)
    await turn($, clock)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(await status($)).toBe('Off for this session: /cache-compactor:on turns it back on.')
    expect(await command($, 'off')).toBe('Automatic compaction is already off for this session. /cache-compactor:on turns it back on.')
  })

  test('/cache-compactor:on sets the timer again from the last request', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await command($, 'off')
    await clock.advance(20 * MIN)
    expect(await command($, 'on')).toBe(
      'Automatic compaction is on again for this session. Compacts in 38 min if the session stays idle: the prompt cache expires 1 h after the last request (Claude subscription).',
    )
    expect(calls.status).toEqual(['auto-compact off', undefined])
    await clock.advance(38 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('on past the moment it would have compacted waits for the next prompt', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await command($, 'off')
    await clock.advance(59 * MIN)
    expect(await command($, 'on')).toBe('Automatic compaction is on again for this session. The timer starts after your next prompt.')
    await clock.advance(10 * MIN)
    expect(calls.compacts).toEqual([])
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('on when it was never off says so', async ($, on) => {
    engine(on)
    expect(await command($, 'on')).toBe('Automatic compaction is already on for this session. Not scheduled: nothing has been sent to Claude yet.')
  })

  test('off lasts through a resume, and /clear starts the next conversation on', async ($, on) => {
    const { calls, clock } = engine(on)
    await turn($, clock)
    await command($, 'off')
    await $.session.end({ sessionId: 's1', reason: 'other' } as never)
    await resume($, 60)
    expect(await status($)).toBe('Off for this session: /cache-compactor:on turns it back on.')
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    // /clear: a new conversation, never resumed.
    await $.session.end({ sessionId: 's1', reason: 'clear' } as never)
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })
})

describe('how long the cache lasts', () => {
  test('an API-key session (no plan usage windows) is left alone', async ($, on) => {
    const { calls, clock } = engine(on, { rateLimits: [] })
    await turn($, clock)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(await status($)).toBe(
      'Off: the prompt cache lasts only 5 min here (no Claude plan usage reported, so an API key), under minCacheTtlSeconds (3600). Set minCacheTtlSeconds to 300 or less to compact these sessions too.',
    )
  })

  test('minCacheTtlSeconds 300 compacts an API-key session after its short wait', { options: { minCacheTtlSeconds: 300 } }, async ($, on) => {
    const { calls, clock } = engine(on, { rateLimits: [] })
    await turn($, clock)
    await clock.advance(3 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('the one-hour variable wins over an API key', async ($, on) => {
    const { calls, clock } = engine(on, { rateLimits: [], vars: { ENABLE_PROMPT_CACHING_1H: '1' } })
    await turn($, clock)
    await clock.advance(58 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('promptCacheTtl 5m in settings turns it off', async ($, on) => {
    const { calls, clock } = engine(on, { promptCacheTtl: '5m' })
    await turn($, clock)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
  })
})

describe('resumed sessions', () => {
  test('a resumed session counts from its last response', async ($, on) => {
    const { calls, clock } = engine(on)
    await resume($, 20 * 60)
    await clock.advance(38 * MIN - 1)
    expect(calls.compacts).toEqual([])
    await clock.advance(1)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('one this plugin saw compacted is left alone', async ($, on) => {
    const { calls, clock } = engine(on, { store: { compacted: { s1: T0 - 25 * MIN } } })
    await resume($, 20 * 60)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(await status($)).toBe('Not scheduled: the last thing that happened was a compaction. The timer starts again after your next prompt.')
  })

  test('one compacted before the plugin knew it is left alone: a summary and only kept replies after it', async ($, on) => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.'
    const { calls, clock } = engine(on, { transcript: [{ role: 'user', text: summary }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'Done.' }] })
    await resume($, 20 * 60)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
  })

  test('one with a prompt after its last compaction counts', async ($, on) => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.'
    const { calls, clock } = engine(on, { transcript: [{ role: 'user', text: summary }, { role: 'user', text: 'next thing' }, { role: 'assistant', text: 'Done.' }] })
    await resume($, 20 * 60)
    await clock.advance(38 * MIN)
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('the plugin remembers its compaction until the next turn', async ($, on) => {
    const { calls, clock } = engine(on)
    const reopen = async () => {
      await $.session.end({ sessionId: 's1', reason: 'other' } as never)
      await resume($, 60)
    }
    await turn($, clock)
    await clock.advance(58 * MIN)
    await reopen()
    expect(await status($)).toStartWith('Not scheduled: the last thing that happened was a compaction.')
    await turn($, clock)
    await reopen()
    expect(await status($)).toStartWith('Compacts in 57 min')
    expect(calls.compacts).toEqual(['compact:'])
  })

  test('one resumed after the cache expired is left alone', async ($, on) => {
    const { calls, clock } = engine(on)
    await resume($, 3 * 60 * 60)
    await clock.advance(3 * 60 * MIN)
    expect(calls.compacts).toEqual([])
    expect(calls.debug).toEqual([])
    expect(await status($)).toBe('Not scheduled: the cache expired 5 h ago.')
  })
})
