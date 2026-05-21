import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import 'dotenv/config'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET is missing or too short (must be ≥ 16 chars). Set it in backend/.env.')
  process.exit(1)
}
const JWT_EXPIRES_IN     = process.env.JWT_EXPIRES_IN     || '7d'
const DOWNLOAD_TOKEN_TTL = process.env.DOWNLOAD_TOKEN_TTL || '5m'

export function signSessionToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function signDownloadToken(payload) {
  return jwt.sign({ ...payload, scope: 'download' }, JWT_SECRET, { expiresIn: DOWNLOAD_TOKEN_TTL })
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10)
}

export async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}
