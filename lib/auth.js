import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import 'dotenv/config'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET is missing or too short (must be ≥ 16 chars). Set it in backend/.env.')
  process.exit(1)
}
const JWT_EXPIRES_IN     = process.env.JWT_EXPIRES_IN     || '7d'
const DOWNLOAD_TOKEN_TTL = process.env.DOWNLOAD_TOKEN_TTL || '5m'
const CHALLENGE_TOKEN_TTL = process.env.CHALLENGE_TOKEN_TTL || '10m'

export function signSessionToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export function signDownloadToken(payload) {
  return jwt.sign({ ...payload, scope: 'download' }, JWT_SECRET, { expiresIn: DOWNLOAD_TOKEN_TTL })
}

// Short-lived token returned during a 2FA or password-reset challenge. The
// caller must present it back along with the OTP — it identifies which user
// the OTP belongs to without trusting the email field from the client again.
export function signChallengeToken({ sub, purpose }) {
  return jwt.sign({ sub, scope: 'challenge', purpose }, JWT_SECRET, { expiresIn: CHALLENGE_TOKEN_TTL })
}

export function verifyChallengeToken(token, expectedPurpose) {
  const decoded = jwt.verify(token, JWT_SECRET)
  if (decoded.scope !== 'challenge') throw new Error('Invalid token scope')
  if (expectedPurpose && decoded.purpose !== expectedPurpose) throw new Error('Wrong challenge purpose')
  return decoded
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

// Cryptographically-random 6-digit string — leading zeros preserved.
export function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export async function hashOtp(code) {
  return bcrypt.hash(code, 8)
}

export async function compareOtp(code, hash) {
  return bcrypt.compare(code, hash)
}
