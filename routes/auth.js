import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { pool, queryOne } from '../lib/db.js'
import { hashPassword, comparePassword, signSessionToken } from '../lib/auth.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const PROFILE_COLS = 'id, email, full_name, phone, address, city, state, zip_code, date_of_birth, ssn_last_four, sin_number, filing_status, role, is_approved, filing_progress, service_type, service_data, avatar_url, notes, created_at, updated_at'

// POST /api/auth/register — PUBLIC, always creates a non-admin user.
// `role` from the request body is ignored to prevent privilege escalation.
router.post('/register', async (req, res) => {
  const { email, password, fullName, full_name, serviceType, service_type } = req.body
  const name = fullName ?? full_name ?? ''
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' })
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' })

  const existing = await queryOne('SELECT id FROM profiles WHERE email = ?', [email.toLowerCase()])
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' })

  const id   = uuid()
  const hash = await hashPassword(password)
  // Service must exist in form_definitions. Validate to avoid arbitrary text.
  const requestedService = serviceType ?? service_type ?? 'personal_tax'
  const formExists = await queryOne(`SELECT form_key FROM form_definitions WHERE form_key = ?`, [requestedService])
  const finalService = formExists ? requestedService : 'personal_tax'

  await pool.execute(
    `INSERT INTO profiles (id, email, password_hash, full_name, role, service_type) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email.toLowerCase(), hash, name, 'user', finalService]
  )

  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [id])
  const token   = signSessionToken({ sub: id, email: profile.email, role: profile.role })

  res.status(201).json({ token, user: { id, email: profile.email }, profile })
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' })

    const row = await queryOne(
      `SELECT id, password_hash, role, is_approved FROM profiles WHERE email = ?`,
      [email.toLowerCase()]
    )
    if (!row) return res.status(401).json({ error: 'Invalid email or password' })

    const ok = await comparePassword(password, row.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

    if (row.role !== 'admin' && !row.is_approved) {
      return res.status(403).json({ error: 'Your account is awaiting admin approval. You will be able to sign in once it is approved.' })
    }

    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [row.id])
    const token   = signSessionToken({ sub: row.id, email: profile.email, role: profile.role })

    res.json({ token, user: { id: row.id, email: profile.email }, profile })
  } catch (err) {
    console.error('[auth/login]', err.code || err.message)
    res.status(500).json({ error: 'Login temporarily unavailable. Please try again.' })
  }
})

// GET /api/auth/me — return current user + profile based on token
router.get('/me', requireAuth, async (req, res) => {
  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.user.id])
  if (!profile) return res.status(404).json({ error: 'Profile not found' })
  res.json({ user: { id: profile.id, email: profile.email }, profile })
})

export default router
