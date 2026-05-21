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

// Convenience wrappers — mysql2 returns [rows, fields]; we usually only need rows.
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params)
  return rows[0] || null
}
