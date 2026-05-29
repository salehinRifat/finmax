import crypto from 'crypto'
import 'dotenv/config'

// AES-256-GCM encryption for sensitive at-rest fields (SIN, etc.). The key
// is a 32-byte secret stored only in backend/.env so DB dumps / backups never
// contain plaintext sensitive values.
//
// Generate a key once with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// and put it in backend/.env as:
//   SIN_ENCRYPTION_KEY=<64 hex chars>
//
// NEVER rotate this key without first decrypting everything with the old one
// and re-encrypting with the new one — losing the key means losing the data.

const KEY_HEX = process.env.SIN_ENCRYPTION_KEY
if (!KEY_HEX || KEY_HEX.length !== 64 || !/^[0-9a-fA-F]+$/.test(KEY_HEX)) {
  console.error('FATAL: SIN_ENCRYPTION_KEY is missing or invalid in backend/.env.')
  console.error('It must be exactly 64 hex characters (32 random bytes).')
  console.error('Generate one with:')
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}

const KEY    = Buffer.from(KEY_HEX, 'hex')
const ALGO   = 'aes-256-gcm'
const PREFIX = 'enc:v1:'   // marker so we can tell encrypted from legacy plaintext
const IV_LEN = 12
const TAG_LEN = 16

// Encrypt a small string (returns null/undefined/'' unchanged). If the input
// is already a ciphertext (has our prefix), return as-is — idempotent so the
// boot-time migration can run repeatedly without double-encrypting.
export function encryptSensitive(plain) {
  if (plain === null || plain === undefined || plain === '') return plain
  const str = String(plain)
  if (str.startsWith(PREFIX)) return str

  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Stored as: prefix + base64(iv || tag || ciphertext)
  const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64')
  return PREFIX + payload
}

// Decrypt a value previously produced by encryptSensitive. Returns:
//   • null/undefined/'' unchanged
//   • plaintext strings (no prefix) unchanged — for legacy rows that haven't
//     been migrated yet, the boot-time migration covers these.
//   • null if the ciphertext is malformed (fails closed; never returns the
//     raw ciphertext, which would corrupt downstream consumers).
export function decryptSensitive(value) {
  if (value === null || value === undefined || value === '') return value
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value

  try {
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv  = payload.subarray(0, IV_LEN)
    const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const enc = payload.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch (err) {
    console.error('[crypto] Failed to decrypt sensitive value:', err.message)
    return null
  }
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

// Mutates a profile-shaped object so its sin_number is decrypted in place.
// Safe to call repeatedly; null/missing values pass through unchanged.
export function decryptProfile(profile) {
  if (!profile) return profile
  if (profile.sin_number) profile.sin_number = decryptSensitive(profile.sin_number)
  return profile
}
