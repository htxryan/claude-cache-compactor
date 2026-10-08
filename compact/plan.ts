// Pure timing logic: how long the cache lasts, when to compact, whether to,
// and how to say what happened. No `$` here.

export type Ttl = '5m' | '1h'

export type Settings = {
  minCacheTtlMs: number // sessions whose cache lasts less are left alone
  leadMs: number // how long before it expires to compact
  minTokens: number // smaller conversations are left alone
  instructions: string // what the summary should keep, as typed after /compact
}

export const DEFAULTS = { minCacheTtlSeconds: 3600, leadSeconds: 120, minTokens: 30000 } as const

const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// A number setting in a range; anything else falls back to its default and is
// named in `invalid`.
function num(name: string, value: unknown, fallback: number, ok: (n: number) => boolean, invalid: string[]): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (Number.isFinite(n) && ok(n)) return n
  invalid.push(`${name} "${String(value)}" (using ${fallback})`)
  return fallback
}

const asTtl = (v: unknown): Ttl | null => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return t === '5m' || t === '1h' ? t : null
}

export function readSettings(options: Readonly<Record<string, unknown>>, invalid: string[]): Settings {
  const minCacheTtlSeconds = num('minCacheTtlSeconds', options.minCacheTtlSeconds, DEFAULTS.minCacheTtlSeconds, n => n >= 0, invalid)
  const leadSeconds = num('leadSeconds', options.leadSeconds, DEFAULTS.leadSeconds, n => n >= 0 && n < 3600, invalid)
  const minTokens = num('minTokens', options.minTokens, DEFAULTS.minTokens, n => n >= 0, invalid)
  const instructions = typeof options.instructions === 'string' ? options.instructions.trim() : ''
  return { minCacheTtlMs: minCacheTtlSeconds * 1000, leadMs: leadSeconds * 1000, minTokens, instructions }
}

// How long this session's cache lasts, and how that was decided. `ttlMs` is
// null when there is nothing to do: caching is off, the cache lasts less than
// minCacheTtlSeconds, or no shorter than leadSeconds.
export type Cache = { ttlMs: number | null; why: string }

// What the session tells about its cache: Claude Code's environment variables
// and settings, its model, and the rate-limit windows its last response
// reported (a Claude subscription has five_hour and seven_day ones).
export type Signals = {
  env: Readonly<Record<string, string | undefined>>
  promptCacheTtl: unknown
  model: string
  rateLimits: readonly { kind: string; percentUsed: number }[]
}

const on = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']

// Claude Code's rules, from https://code.claude.com/docs/en/prompt-caching:
// one hour on a subscription within plan usage, five minutes with an API key,
// a cloud provider or usage credits, and the variables and setting first.
export function resolveCache(s: Settings, sig: Signals): Cache {
  const family = FAMILIES.find(f => sig.model.toLowerCase().includes(f))
  const off = ['DISABLE_PROMPT_CACHING', ...(family ? [`DISABLE_PROMPT_CACHING_${family.toUpperCase()}`] : [])].find(name => on(sig.env[name]))
  if (off) return { ttlMs: null, why: `prompt caching is off (${off})` }
  const [ttl, why] = autoTtl(sig)
  const ttlMs = TTL_MS[ttl]
  if (ttlMs < s.minCacheTtlMs) {
    return { ttlMs: null, why: `the prompt cache lasts only ${duration(ttlMs)} here (${why}), under minCacheTtlSeconds (${s.minCacheTtlMs / 1000}). Set minCacheTtlSeconds to ${ttlMs / 1000} or less to compact these sessions too` }
  }
  if (s.leadMs >= ttlMs) return { ttlMs: null, why: `leadSeconds (${s.leadMs / 1000}) is no shorter than this session's ${duration(ttlMs)} prompt cache` }
  return { ttlMs, why }
}

function autoTtl(sig: Signals): [Ttl, string] {
  const { env } = sig
  if (on(env.FORCE_PROMPT_CACHING_5M)) return ['5m', 'FORCE_PROMPT_CACHING_5M']
  const fromEnv = asTtl(env.CLAUDE_CODE_PROMPT_CACHE_TTL)
  if (fromEnv) return [fromEnv, `CLAUDE_CODE_PROMPT_CACHE_TTL is ${fromEnv}`]
  const fromSettings = asTtl(sig.promptCacheTtl)
  if (fromSettings) return [fromSettings, `promptCacheTtl is ${fromSettings}`]
  if (on(env.ENABLE_PROMPT_CACHING_1H)) return ['1h', 'ENABLE_PROMPT_CACHING_1H']
  const provider = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].find(name => on(env[name]))
  if (provider) return ['5m', provider]
  const plan = sig.rateLimits.filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
  if (plan.some(r => r.percentUsed >= 100)) return ['5m', 'past your plan’s usage limit, on usage credits']
  if (plan.length) return ['1h', 'Claude subscription']
  return ['5m', 'no Claude plan usage reported, so an API key']
}

// When to compact, and when the cache expires, counted from the start of the
// last main-conversation request: that request is what last read or wrote the
// cache.
export const dueAt = (anchor: number, ttlMs: number, s: Settings): number => anchor + ttlMs - s.leadMs
export const expiresAt = (anchor: number, ttlMs: number): number => anchor + ttlMs

export type State = {
  anchor: number | null // start of the last main-conversation request
  lastWasCompact: boolean // nothing has happened since the last compaction
  turning: boolean // a turn is running
  off: boolean // turned off for this session (/cache-compactor:off)
}

// Whether to compact now; when not, why.
export function check(state: State, now: number, tokens: number | undefined, cache: Cache, s: Settings): { compact: true } | { compact: false; reason: string } {
  if (state.off) return { compact: false, reason: 'it is turned off for this session' }
  if (state.anchor === null) return { compact: false, reason: 'nothing has been sent to Claude yet' }
  if (state.lastWasCompact) return { compact: false, reason: 'the last thing that happened was a compaction' }
  if (state.turning) return { compact: false, reason: 'a turn is running' }
  if (cache.ttlMs === null) return { compact: false, reason: cache.why }
  if (now >= expiresAt(state.anchor, cache.ttlMs)) {
    return { compact: false, reason: `the cache had already expired (${duration(now - state.anchor)} since the last request, so the computer was probably asleep)` }
  }
  if (tokens !== undefined && tokens < s.minTokens) {
    return { compact: false, reason: `the conversation is small (${k(tokens)} tokens, under minTokens ${k(s.minTokens)})` }
  }
  return { compact: true }
}

// What happened the last time the timer went off.
export type Last =
  | { at: number; outcome: 'compacted'; idleMs: number; before?: number; after?: number; cacheRead?: number }
  | { at: number; outcome: 'skipped' | 'failed'; reason: string }

// The line shown after compacting.
export function compactedText(last: Extract<Last, { outcome: 'compacted' }>): string {
  const sizes = last.before !== undefined && last.after !== undefined ? `: ${k(last.before)} → ${k(last.after)} tokens` : ''
  const cache =
    last.cacheRead === undefined ? '' : last.cacheRead > 0 ? ` (${k(last.cacheRead)} read from the cache)` : ' (nothing was read from the cache)'
  return `compacted after ${duration(last.idleMs)} idle, before the prompt cache expires${sizes}${cache}.`
}

export const ON_AGAIN = '/cache-compactor:on turns it back on.'

// What /cache-compactor:off and :on say.
export const offText = (was: boolean) => `Automatic compaction is ${was ? 'already' : 'now'} off for this session. ${ON_AGAIN}`
export const onText = (was: boolean, status: string) =>
  `Automatic compaction is ${was ? 'already on' : 'on again'} for this session. ${status}`

// What /cache-compactor:status says.
export function describe(args: { state: State; now: number; due: number | null; last: Last | null; cache: Cache | null; interactive: boolean }): string {
  const { state, now, due, last, cache } = args
  const lines: string[] = []
  if (state.off) {
    lines.push(`Off for this session: ${ON_AGAIN}`)
  } else if (due !== null && cache?.ttlMs) {
    lines.push(`Compacts in ${duration(Math.max(0, due - now))} if the session stays idle: the prompt cache expires ${duration(cache.ttlMs)} after the last request (${cache.why}).`)
  } else if (!args.interactive) {
    lines.push('Not scheduled: nothing draws this session (a headless run).')
  } else if (state.turning) {
    lines.push('Not scheduled while a turn runs: the timer starts when it ends.')
  } else if (state.lastWasCompact) {
    lines.push('Not scheduled: the last thing that happened was a compaction. The timer starts again after your next prompt.')
  } else if (state.anchor === null) {
    lines.push('Not scheduled: nothing has been sent to Claude yet.')
  } else if (cache?.ttlMs === null) {
    lines.push(`Off: ${cache.why}.`)
  } else if (cache) {
    lines.push(`Not scheduled: the cache expired ${duration(now - expiresAt(state.anchor, cache.ttlMs))} ago.`)
  } else {
    lines.push('Not scheduled.')
  }
  if (last) {
    const ago = `${duration(now - last.at)} ago`
    lines.push(
      last.outcome === 'compacted'
        ? `Last: ${compactedText(last).replace(/^compacted/, `compacted ${ago}`)}`
        : `Last: ${last.outcome === 'skipped' ? "didn't compact" : "couldn't compact"} ${ago}: ${last.reason}.`,
    )
  }
  return lines.join('\n')
}

// 142000 is "142k"; under 1000, the number itself.
export const k = (n: number): string => (n < 1000 ? String(Math.round(n)) : `${Math.round(n / 1000)}k`)

// 45 s, 58 min, 1 h 5 min.
export function duration(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec} s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}
