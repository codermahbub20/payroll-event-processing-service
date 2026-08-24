/**
 * Lua scripts implementing the per-employee sequence lock.
 *
 * These run atomically inside Redis. The check-then-act sequences below MUST
 * NOT be split into separate round trips: two workers evaluating "is the lock
 * free?" concurrently would both see yes and both proceed, which is exactly
 * the ordering violation this mechanism exists to prevent.
 */

/**
 * Try to acquire the ordering lock for an employee.
 *
 * KEYS[1] = lock key, KEYS[2] = FIFO queue key
 * ARGV[1] = eventId, ARGV[2] = lock TTL in ms
 *
 * Returns:
 *   1  -> acquired; this worker owns the employee and may process eventId
 *   0  -> not acquired; another event holds the lock, or this event is not at
 *         the head of the FIFO queue (i.e. an earlier event is still pending)
 *
 * The TTL is a safety net: if a worker dies mid-job the lock expires rather
 * than blocking the employee forever. It is refreshed while work is in flight
 * (see RENEW_LOCK) so a legitimately slow job is never pre-empted.
 */
export const ACQUIRE_LOCK = `
local lockKey = KEYS[1]
local queueKey = KEYS[2]
local eventId = ARGV[1]
local ttl = tonumber(ARGV[2])

-- Refuse unless this event is at the head of the employee's FIFO queue.
-- This is what enforces ordering: a later event cannot overtake an earlier
-- one even if its job happens to be delivered first.
local head = redis.call('LINDEX', queueKey, 0)
if head and head ~= eventId then
  return 0
end

-- Re-entrant: a retry of the SAME event re-acquires its own lock rather than
-- deadlocking against itself.
local holder = redis.call('GET', lockKey)
if holder == eventId then
  redis.call('PEXPIRE', lockKey, ttl)
  return 1
end

if holder then
  return 0
end

redis.call('SET', lockKey, eventId, 'PX', ttl)
return 1
`;

/**
 * Release the lock and advance the FIFO queue.
 *
 * KEYS[1] = lock key, KEYS[2] = FIFO queue key
 * ARGV[1] = eventId
 *
 * Returns the next eventId for this employee, or false when none remain.
 *
 * Releasing and popping are one atomic step: doing them separately opens a
 * window where the lock is free but the completed event is still at the head
 * of the queue, so the next job would be refused and the employee could stall.
 */
export const RELEASE_LOCK = `
local lockKey = KEYS[1]
local queueKey = KEYS[2]
local eventId = ARGV[1]

-- Only the holder may release. Prevents a job that lost its lock to a TTL
-- expiry from later releasing a lock a different worker now legitimately owns.
local holder = redis.call('GET', lockKey)
if holder == eventId then
  redis.call('DEL', lockKey)
end

-- Remove this event from the head if it is still there.
local head = redis.call('LINDEX', queueKey, 0)
if head == eventId then
  redis.call('LPOP', queueKey)
end

local nextId = redis.call('LINDEX', queueKey, 0)
if nextId then
  return nextId
end
return false
`;

/**
 * Refresh the lock TTL while a job is still running.
 *
 * KEYS[1] = lock key; ARGV[1] = eventId, ARGV[2] = TTL in ms
 * Returns 1 if refreshed, 0 if this event no longer holds the lock.
 */
export const RENEW_LOCK = `
local holder = redis.call('GET', KEYS[1])
if holder == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`;

/**
 * Append an event to an employee's FIFO queue at enqueue time.
 *
 * KEYS[1] = FIFO queue key, KEYS[2] = sequence counter key
 * ARGV[1] = eventId, ARGV[2] = queue TTL in seconds
 * Returns the assigned sequence number.
 *
 * Guarded against duplicates: re-enqueueing an event already in the queue
 * (an at-least-once redelivery) must not add a second entry, or the queue
 * would never drain past it.
 */
export const ENQUEUE_EVENT = `
local queueKey = KEYS[1]
local seqKey = KEYS[2]
local eventId = ARGV[1]
local ttl = tonumber(ARGV[2])

local existing = redis.call('LPOS', queueKey, eventId)
if existing then
  return -1
end

redis.call('RPUSH', queueKey, eventId)
local seq = redis.call('INCR', seqKey)
-- Housekeeping TTL so a stalled employee's keys cannot leak forever. Refreshed
-- on every enqueue, so an active employee's queue never expires underneath it.
redis.call('EXPIRE', queueKey, ttl)
redis.call('EXPIRE', seqKey, ttl)
return seq
`;
