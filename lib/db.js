import 'dotenv/config'
import mysql from 'mysql2/promise'

export const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:     Number(   process.env.DB_PORT)    || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'finmax',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  dateStrings:        true,
  // Remote MySQL (Hostinger) drops idle connections; keep them alive and
  // recycle anything sitting idle so we don't hand out dead sockets.
  enableKeepAlive:        true,
  keepAliveInitialDelay:  10_000,
  idleTimeout:            60_000,
  maxIdle:                5,
  connectTimeout:         15_000,
})

// Hostinger silently drops idle MySQL sockets, so the first query against a
// stale connection blows up with one of these codes. Retrying once is enough —
// the pool hands out a fresh socket on the next attempt.
const TRANSIENT_DB_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ER_LOCK_DEADLOCK',
])

function isTransient(err) {
  return TRANSIENT_DB_ERRORS.has(err?.code)
}

// Wrap pool.execute and pool.query so every call site in the codebase
// transparently retries dead-socket errors without needing per-route changes.
const _origExecute = pool.execute.bind(pool)
const _origQuery   = pool.query.bind(pool)

async function withRetry(fn, attempts = 3) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransient(err) || i === attempts - 1) throw err
      // Small backoff so we don't slam the pool while it reconnects
      await new Promise(r => setTimeout(r, 100 * (i + 1)))
    }
  }
  throw lastErr
}

pool.execute = (...args) => withRetry(() => _origExecute(...args))
pool.query   = (...args) => withRetry(() => _origQuery(...args))

// Convenience wrappers — mysql2 returns [rows, fields]; we usually only need rows.
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}
