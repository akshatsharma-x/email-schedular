/**
 * Redis Lua scripts used for rate limiting.
 *
 * These live in TypeScript (as template literals) rather than .lua files so the
 * compiled `dist/` needs no asset-copy step. The Lua itself is unmodified and
 * reviewable as-is.
 *
 * Why Lua at all: the admission decision reads three keys and conditionally
 * writes three keys. Doing that with separate round-trips means two workers can
 * interleave between the check and the write and both send -- blowing the hourly
 * cap or the minimum gap. A Lua script runs atomically inside Redis, so the
 * check-then-reserve is indivisible and correct across any number of worker
 * processes or machines. It also means there is never a half-applied
 * reservation to roll back.
 */

/**
 * ADMIT: decide whether one email may be sent right now, and reserve the
 * capacity in the same atomic step.
 *
 *   KEYS[1] per-sender hourly counter      (rl:sender:<senderId>:<hourWindow>)
 *   KEYS[2] per-tenant hourly counter      (rl:tenant:<userId>:<hourWindow>)
 *   KEYS[3] per-sender min-gap gate        (rl:gap:<senderId>)
 *   KEYS[4] per-sender gate fencing token  (rl:gaptok:<senderId>)
 *
 *   ARGV[1] now                 (epoch ms)
 *   ARGV[2] senderHourlyLimit   (> 0)
 *   ARGV[3] tenantHourlyLimit   (0 disables the tenant ceiling)
 *   ARGV[4] minGapMs            (0 disables the gap)
 *   ARGV[5] windowEndsAt        (epoch ms at which the current hour window ends)
 *   ARGV[6] counterTtlSeconds
 *   ARGV[7] holdMs              (reservation held while the send is in flight)
 *
 * Returns { allowed, waitMs, reason, senderRemaining, tenantRemaining, token }
 * where allowed is 1/0 and reason is OK | SENDER_HOURLY_LIMIT |
 * TENANT_HOURLY_LIMIT | MIN_DELAY. `token` must be handed to RELEASE_GAP once
 * the send finishes.
 *
 * Note the shape: *every* limit is checked before *any* limit is reserved. A
 * denial therefore mutates nothing, which is what makes the "no rollback"
 * guarantee hold.
 */
export const ADMIT_SCRIPT = `
local now            = tonumber(ARGV[1])
local sender_limit   = tonumber(ARGV[2])
local tenant_limit   = tonumber(ARGV[3])
local min_gap_ms     = tonumber(ARGV[4])
local window_ends_at = tonumber(ARGV[5])
local counter_ttl    = tonumber(ARGV[6])
local hold_ms        = tonumber(ARGV[7])

local sender_count = tonumber(redis.call('GET', KEYS[1])) or 0
local tenant_count = tonumber(redis.call('GET', KEYS[2])) or 0

-- ---- phase 1: checks only, no writes ----------------------------------------

if sender_count >= sender_limit then
  local wait = window_ends_at - now
  if wait < 0 then wait = 0 end
  return { 0, wait, 'SENDER_HOURLY_LIMIT', 0, tenant_limit - tenant_count, '0' }
end

if tenant_limit > 0 and tenant_count >= tenant_limit then
  local wait = window_ends_at - now
  if wait < 0 then wait = 0 end
  return { 0, wait, 'TENANT_HOURLY_LIMIT', sender_limit - sender_count, 0, '0' }
end

if min_gap_ms > 0 then
  local next_allowed = tonumber(redis.call('GET', KEYS[3])) or 0
  if now < next_allowed then
    return {
      0,
      next_allowed - now,
      'MIN_DELAY',
      sender_limit - sender_count,
      tenant_limit - tenant_count,
      '0'
    }
  end
end

-- ---- phase 2: every check passed, so reserve atomically ---------------------

local new_sender = redis.call('INCR', KEYS[1])
if new_sender == 1 then
  redis.call('EXPIRE', KEYS[1], counter_ttl)
end

local new_tenant = tenant_count
if tenant_limit > 0 then
  new_tenant = redis.call('INCR', KEYS[2])
  if new_tenant == 1 then
    redis.call('EXPIRE', KEYS[2], counter_ttl)
  end
end

local token = '0'
if min_gap_ms > 0 then
  -- Reserve the gate for the whole expected duration of this send, so no other
  -- send for this sender can start while it is in flight. RELEASE_GAP lowers it
  -- to completedAt + gap as soon as the send finishes; the TTL is the backstop
  -- for a worker that dies mid-send.
  local hold = min_gap_ms + hold_ms
  token = tostring(redis.call('INCR', KEYS[4]))
  redis.call('PEXPIRE', KEYS[4], hold + 60000)
  redis.call('SET', KEYS[3], now + hold, 'PX', hold + 1000)
end

local sender_remaining = sender_limit - new_sender
if sender_remaining < 0 then sender_remaining = 0 end

local tenant_remaining = -1
if tenant_limit > 0 then
  tenant_remaining = tenant_limit - new_tenant
  if tenant_remaining < 0 then tenant_remaining = 0 end
end

return { 1, 0, 'OK', sender_remaining, tenant_remaining, token }
`;

/**
 * RELEASE_GAP: end a sender's in-flight reservation and re-arm the delay.
 *
 * Why a *held* reservation rather than just "gate = now + gap" at admission:
 * admission happens before the SMTP dialogue, so if a send takes longer than
 * the gap, the next job clears the gate and starts while the first is still in
 * flight. One sender then holds several concurrent SMTP conversations -- exactly
 * what provider throttling exists to prevent -- and observed `sent_at` deltas
 * come out smaller than the configured minimum. Re-arming after the fact cannot
 * fix that: by then the next send has already been admitted.
 *
 * So ADMIT reserves the gate for `gap + holdMs` (a conservative upper bound on
 * one send), which blocks every other send for that sender, and this script
 * releases it down to `completedAt + gap` once the send is done. The guarantee
 * becomes crisp and directly observable: **for one sender, at most one send is
 * in flight, and the next one starts no sooner than `gap` after the previous
 * finished.**
 *
 * The fencing token is what makes lowering the gate safe. Each admission bumps
 * a counter; a send releases only if the counter still matches the value it was
 * given. If this send overran its hold and another was admitted meanwhile, the
 * token has moved on and the stale release is ignored instead of wrongly
 * clearing the newer send's reservation.
 *
 *   KEYS[1] gap gate        KEYS[2] gate fencing token
 *   ARGV[1] now   ARGV[2] gapMs   ARGV[3] token held by the caller
 */
export const RELEASE_GAP_SCRIPT = `
local gap   = tonumber(ARGV[2])
local token = ARGV[3]

if gap <= 0 then return 0 end

local current_token = redis.call('GET', KEYS[2])
if current_token and current_token ~= token then
  -- A newer admission owns the gate; this release is stale.
  return -1
end

local next_allowed = tonumber(ARGV[1]) + gap
redis.call('SET', KEYS[1], next_allowed, 'PX', gap + 1000)
return next_allowed
`;

/**
 * NOTIFY_ONCE: claim the right to send one Slack alert for a given key.
 *
 * Returns 1 for the first caller in the window and 0 for everyone after, so a
 * campaign that hits its ceiling 800 times in a row produces exactly one Slack
 * message per sender per hour instead of 800.
 *
 *   KEYS[1] alert key   ARGV[1] ttlSeconds
 */
export const NOTIFY_ONCE_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[1])) then
  return 1
end
return 0
`;

/**
 * PEEK: read current usage without reserving anything. Used by the dashboard's
 * throughput panel, which must never perturb the limiter it is reporting on.
 *
 *   KEYS[1] sender counter   KEYS[2] tenant counter   KEYS[3] gap gate
 */
export const PEEK_SCRIPT = `
local sender_count = tonumber(redis.call('GET', KEYS[1])) or 0
local tenant_count = tonumber(redis.call('GET', KEYS[2])) or 0
local next_allowed = tonumber(redis.call('GET', KEYS[3])) or 0
return { sender_count, tenant_count, next_allowed }
`;
