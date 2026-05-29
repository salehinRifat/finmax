import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { pool, queryOne } from '../lib/db.js'
import {
  hashPassword, comparePassword, signSessionToken,
  signChallengeToken, verifyChallengeToken,
  generateOtp, hashOtp, compareOtp,
} from '../lib/auth.js'
import { sendLoginCodeEmail, sendPasswordResetEmail } from '../lib/email.js'
import { requireAuth } from '../middleware/auth.js'
import { decryptProfile } from '../lib/crypto.js'

const router = Router()

const PROFILE_COLS = 'id, email, alt_email, full_name, first_name, middle_name, last_name, phone, address, city, state, country, zip_code, date_of_birth, ssn_last_four, sin_number, filing_status, role, is_approved, filing_progress, service_type, service_data, avatar_url, notes, two_factor_enabled, payment_status, created_at, updated_at'

// payment_status is internal billing state — strip it from any response
// that's sent back to a non-admin caller (their own /me, etc.).
function stripAdminOnly(profile) {
  if (!profile) return profile
  const { payment_status, ...rest } = profile
  return rest
}

// Codes expire fast — 2FA codes are sent right before the user types them.
const OTP_TTL_MINUTES = { login_2fa: 10, password_reset: 15 }
// 3 strikes on 2FA so an attacker can't grind through codes; password reset
// is a little more forgiving since users often fat-finger the long email code.
const MAX_OTP_ATTEMPTS = { login_2fa: 3, password_reset: 5 }

// Generic message for "we sent something to your email if it exists" — avoids
// confirming whether an account is registered for any given email.
const NEUTRAL_RESET_MESSAGE = 'If an account exists for that email, we sent a code to reset your password.'

async function issueOtp(userId, purpose) {
  // Invalidate any pending codes of this purpose for this user so the user
  // can't satisfy the challenge with a stale code if multiple were sent.
  await pool.execute(
    `UPDATE auth_codes SET consumed_at = NOW() WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`,
    [userId, purpose]
  )
  const code = generateOtp()
  const hash = await hashOtp(code)
  const ttl  = OTP_TTL_MINUTES[purpose] || 10
  await pool.execute(
    `INSERT INTO auth_codes (id, user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [uuid(), userId, purpose, hash, ttl]
  )
  return code
}

// Find the active (un-consumed, un-expired) OTP for this user/purpose. Returns
// the DB row, or null if no usable code exists.
async function findActiveOtp(userId, purpose) {
  return queryOne(
    `SELECT id, code_hash, attempts FROM auth_codes
     WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  )
}

function isTwoFactorRequired(profile) {
  // Admins always 2FA; clients opt in via two_factor_enabled.
  return profile.role === 'admin' || !!profile.two_factor_enabled
}

// POST /api/auth/register — PUBLIC, always creates a non-admin user.
// `role` from the request body is ignored to prevent privilege escalation.
router.post('/register', async (req, res) => {
  const {
    email, password,
    firstName, first_name,
    middleName, middle_name,
    lastName,  last_name,
    fullName,  full_name,
    serviceType, service_type,
  } = req.body

  const first  = (firstName  ?? first_name  ?? '').trim()
  const middle = (middleName ?? middle_name ?? '').trim()
  const last   = (lastName   ?? last_name   ?? '').trim()
  // Fall back to the legacy single-field full_name if a client still sends it.
  const legacyFull = (fullName ?? full_name ?? '').trim()
  // Derived full_name keeps existing UI/email templates that read full_name
  // working without each one knowing about the split.
  const computedFull = [first, middle, last].filter(Boolean).join(' ') || legacyFull

  if (!email || !password) return res.status(400).json({ error: 'email and password are required' })
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (!first || !last) {
    return res.status(400).json({ error: 'First name and last name are required' })
  }

  const existing = await queryOne('SELECT id FROM profiles WHERE email = ?', [email.toLowerCase()])
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

  const id   = uuid()
  const hash = await hashPassword(password)
  // Service must exist in form_definitions. Validate to avoid arbitrary text.
  const requestedService = serviceType ?? service_type ?? 'personal_tax'
  const formExists = await queryOne(`SELECT form_key FROM form_definitions WHERE form_key = ?`, [requestedService])
  const finalService = formExists ? requestedService : 'personal_tax'

  await pool.execute(
    `INSERT INTO profiles (id, email, password_hash, full_name, first_name, middle_name, last_name, role, service_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email.toLowerCase(), hash, computedFull, first, middle || null, last, 'user', finalService]
  )

  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [id])
  decryptProfile(profile)
  const token   = signSessionToken({ sub: id, email: profile.email, role: profile.role })

  // Registration always creates a non-admin account.
  res.status(201).json({ token, user: { id, email: profile.email }, profile: stripAdminOnly(profile) })
})

// POST /api/auth/login
// If the account requires 2FA (admin OR client with toggle on), we don't
// return a session token here — instead, we email a code and return a
// short-lived challenge token the client must pass to /login/verify-2fa.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' })

    const row = await queryOne(
      `SELECT id, password_hash, role, is_approved, two_factor_enabled, full_name, email FROM profiles WHERE email = ?`,
      [email.toLowerCase()]
    )
    if (!row) return res.status(401).json({ error: 'Invalid email or password' })

    const ok = await comparePassword(password, row.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

    if (row.role !== 'admin' && !row.is_approved) {
      return res.status(403).json({ error: 'Your account is awaiting admin approval. You will be able to sign in once it is approved.' })
    }

    if (isTwoFactorRequired(row)) {
      const code = await issueOtp(row.id, 'login_2fa')
      sendLoginCodeEmail({ to: row.email, fullName: row.full_name, code })
      const challengeToken = signChallengeToken({ sub: row.id, purpose: 'login_2fa' })
      return res.json({ requires2fa: true, challengeToken, email: row.email })
    }

    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [row.id])
    decryptProfile(profile)
    const token   = signSessionToken({ sub: row.id, email: profile.email, role: profile.role })

    const safe = row.role === 'admin' ? profile : stripAdminOnly(profile)
    res.json({ token, user: { id: row.id, email: profile.email }, profile: safe })
  } catch (err) {
    console.error('[auth/login]', err.code || err.message)
    res.status(500).json({ error: 'Login temporarily unavailable. Please try again.' })
  }
})

// POST /api/auth/login/verify-2fa
// Body: { challengeToken, code }
router.post('/login/verify-2fa', async (req, res) => {
  try {
    const { challengeToken, code } = req.body
    if (!challengeToken || !code) return res.status(400).json({ error: 'Challenge token and code are required' })

    let decoded
    try { decoded = verifyChallengeToken(challengeToken, 'login_2fa') }
    catch { return res.status(401).json({ error: 'This sign-in session has expired. Please log in again.' }) }

    const otp = await findActiveOtp(decoded.sub, 'login_2fa')
    if (!otp) return res.status(400).json({ error: 'Your code has expired. Please request a new one.' })

    const limit = MAX_OTP_ATTEMPTS.login_2fa
    if (otp.attempts >= limit) {
      await pool.execute(`UPDATE auth_codes SET consumed_at = NOW() WHERE id = ?`, [otp.id])
      return res.status(429).json({ error: 'Too many incorrect attempts. Please sign in again.' })
    }

    const matches = await compareOtp(String(code).trim(), otp.code_hash)
    if (!matches) {
      // Increment first so we can decide in-flight whether this strike was the last.
      const newAttempts = otp.attempts + 1
      if (newAttempts >= limit) {
        // Burn the code so the challenge is dead even if the JWT is still valid.
        await pool.execute(`UPDATE auth_codes SET attempts = ?, consumed_at = NOW() WHERE id = ?`, [newAttempts, otp.id])
        return res.status(429).json({ error: 'Too many incorrect attempts. Please sign in again.' })
      }
      await pool.execute(`UPDATE auth_codes SET attempts = ? WHERE id = ?`, [newAttempts, otp.id])
      const remaining = limit - newAttempts
      return res.status(401).json({
        error: `Incorrect code. ${remaining} ${remaining === 1 ? 'try' : 'tries'} remaining.`,
        attemptsRemaining: remaining,
      })
    }

    await pool.execute(`UPDATE auth_codes SET consumed_at = NOW() WHERE id = ?`, [otp.id])

    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [decoded.sub])
    if (!profile) return res.status(404).json({ error: 'Account not found' })
    decryptProfile(profile)
    const token = signSessionToken({ sub: profile.id, email: profile.email, role: profile.role })
    const safe  = profile.role === 'admin' ? profile : stripAdminOnly(profile)
    res.json({ token, user: { id: profile.id, email: profile.email }, profile: safe })
  } catch (err) {
    console.error('[auth/verify-2fa]', err.code || err.message)
    res.status(500).json({ error: 'Verification temporarily unavailable. Please try again.' })
  }
})

// POST /api/auth/login/resend-2fa
// Body: { challengeToken }
router.post('/login/resend-2fa', async (req, res) => {
  try {
    const { challengeToken } = req.body
    if (!challengeToken) return res.status(400).json({ error: 'Challenge token is required' })

    let decoded
    try { decoded = verifyChallengeToken(challengeToken, 'login_2fa') }
    catch { return res.status(401).json({ error: 'This sign-in session has expired. Please log in again.' }) }

    const profile = await queryOne(`SELECT id, email, full_name FROM profiles WHERE id = ?`, [decoded.sub])
    if (!profile) return res.status(404).json({ error: 'Account not found' })

    const code = await issueOtp(profile.id, 'login_2fa')
    sendLoginCodeEmail({ to: profile.email, fullName: profile.full_name, code })
    res.json({ ok: true })
  } catch (err) {
    console.error('[auth/resend-2fa]', err.code || err.message)
    res.status(500).json({ error: 'Could not resend code. Please try again.' })
  }
})

// POST /api/auth/password-reset/request — body: { email }
// Always returns the same neutral message so attackers can't enumerate accounts.
router.post('/password-reset/request', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required' })

    const profile = await queryOne(
      `SELECT id, email, full_name FROM profiles WHERE email = ?`,
      [String(email).toLowerCase()]
    )
    if (profile) {
      const code = await issueOtp(profile.id, 'password_reset')
      sendPasswordResetEmail({ to: profile.email, fullName: profile.full_name, code })
    }
    res.json({ ok: true, message: NEUTRAL_RESET_MESSAGE })
  } catch (err) {
    console.error('[auth/password-reset/request]', err.code || err.message)
    // Still return the neutral message — never reveal failures here either.
    res.json({ ok: true, message: NEUTRAL_RESET_MESSAGE })
  }
})

// POST /api/auth/password-reset/verify — body: { email, code, newPassword }
// Verifies the OTP and immediately rotates the password. We don't issue a
// session here — user is sent back to /login to sign in fresh.
router.post('/password-reset/verify', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const profile = await queryOne(
      `SELECT id FROM profiles WHERE email = ?`,
      [String(email).toLowerCase()]
    )
    // Constant-ish response so attackers can't tell "no such user" from "bad code".
    if (!profile) return res.status(400).json({ error: 'Invalid or expired reset code' })

    const otp = await findActiveOtp(profile.id, 'password_reset')
    if (!otp) return res.status(400).json({ error: 'Invalid or expired reset code' })

    const limit = MAX_OTP_ATTEMPTS.password_reset
    if (otp.attempts >= limit) {
      await pool.execute(`UPDATE auth_codes SET consumed_at = NOW() WHERE id = ?`, [otp.id])
      return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' })
    }

    const matches = await compareOtp(String(code).trim(), otp.code_hash)
    if (!matches) {
      const newAttempts = otp.attempts + 1
      if (newAttempts >= limit) {
        await pool.execute(`UPDATE auth_codes SET attempts = ?, consumed_at = NOW() WHERE id = ?`, [newAttempts, otp.id])
        return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' })
      }
      await pool.execute(`UPDATE auth_codes SET attempts = ? WHERE id = ?`, [newAttempts, otp.id])
      return res.status(400).json({ error: 'Invalid or expired reset code' })
    }

    const newHash = await hashPassword(newPassword)
    await pool.execute(`UPDATE profiles SET password_hash = ? WHERE id = ?`, [newHash, profile.id])
    await pool.execute(`UPDATE auth_codes SET consumed_at = NOW() WHERE id = ?`, [otp.id])
    // Also invalidate any outstanding login_2fa codes — the account just rotated creds.
    await pool.execute(
      `UPDATE auth_codes SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL`,
      [profile.id]
    )

    res.json({ ok: true })
  } catch (err) {
    console.error('[auth/password-reset/verify]', err.code || err.message)
    res.status(500).json({ error: 'Password reset temporarily unavailable. Please try again.' })
  }
})

// PATCH /api/auth/me/2fa — toggle 2FA on/off for the logged-in client.
// Admins cannot turn 2FA off; it's always enforced for them.
router.patch('/me/2fa', requireAuth, async (req, res) => {
  const enabled = !!req.body?.enabled
  const me = await queryOne(`SELECT id, role FROM profiles WHERE id = ?`, [req.user.id])
  if (!me) return res.status(404).json({ error: 'Profile not found' })
  if (me.role === 'admin' && !enabled) {
    return res.status(400).json({ error: 'Two-factor authentication is mandatory for administrator accounts.' })
  }
  await pool.execute(
    `UPDATE profiles SET two_factor_enabled = ? WHERE id = ?`,
    [enabled ? 1 : 0, me.id]
  )
  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [me.id])
  decryptProfile(profile)
  const safe = me.role === 'admin' ? profile : stripAdminOnly(profile)
  res.json({ profile: safe })
})

// GET /api/auth/me — return current user + profile based on token
router.get('/me', requireAuth, async (req, res) => {
  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.user.id])
  if (!profile) return res.status(404).json({ error: 'Profile not found' })
  decryptProfile(profile)
  const safe = profile.role === 'admin' ? profile : stripAdminOnly(profile)
  res.json({ user: { id: profile.id, email: profile.email }, profile: safe })
})

export default router
