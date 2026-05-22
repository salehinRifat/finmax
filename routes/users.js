import { Router } from 'express'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { copyDefaultItemsToUser } from '../lib/seed.js'
import { sendApprovalEmail, sendFilingProgressEmail, sendAdminMessageEmail } from '../lib/email.js'
import { generateProfilePdf } from '../lib/profilePdf.js'

const router = Router()

const PROFILE_COLS = 'id, email, full_name, phone, address, city, state, zip_code, date_of_birth, ssn_last_four, sin_number, filing_status, role, is_approved, filing_progress, service_type, service_data, avatar_url, notes, created_at, updated_at'

const FILING_PROGRESS_VALUES = new Set(['not_started', 'waiting_for_docs', 'in_progress', 'completed'])

// GET /api/users/summary  – admin only, returns each user + their checklist
// completion + pending-doc counts in one round-trip (used by /admin/users).
router.get('/summary', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        p.id, p.email, p.full_name, p.phone, p.role, p.is_approved,
        p.filing_progress, p.service_type, p.created_at,
        (SELECT COUNT(*) FROM checklist_items ci WHERE ci.user_id = p.id) AS items_total,
        (SELECT COUNT(DISTINCT d.checklist_item_id) FROM documents d
            WHERE d.user_id = p.id AND d.checklist_item_id IS NOT NULL) AS items_done,
        (SELECT COUNT(*) FROM documents d WHERE d.user_id = p.id AND d.status = 'pending') AS pending_docs
      FROM profiles p
      WHERE p.role = 'user'
      ORDER BY p.created_at DESC
    `)
    res.json(rows.map(r => ({
      ...r,
      is_approved: !!r.is_approved,
      items_total: Number(r.items_total),
      items_done:  Number(r.items_done),
      pending_docs: Number(r.pending_docs),
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch users summary' })
  }
})

// GET /api/users[?status=pending|approved]  – admin: all 'user' role users; user: own profile
router.get('/', requireAuth, async (req, res) => {
  try {
    if (req.profile?.role === 'admin') {
      let sql = `SELECT ${PROFILE_COLS} FROM profiles WHERE role = 'user'`
      const params = []
      if (req.query.status === 'pending') {
        sql += ` AND is_approved = 0`
      } else if (req.query.status === 'approved') {
        sql += ` AND is_approved = 1`
      }
      sql += ` ORDER BY created_at DESC`
      const rows = await query(sql, params)
      return res.json(rows.map(r => ({ ...r, is_approved: !!r.is_approved })))
    }
    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.user.id])
    if (profile) profile.is_approved = !!profile.is_approved
    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch users' })
  }
})

// GET /api/users/:id  – admin only
router.get('/:id', requireAdmin, async (req, res) => {
  try {
    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.params.id])
    if (!profile) return res.status(404).json({ error: 'User not found' })
    profile.is_approved = !!profile.is_approved
    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch user' })
  }
})

// PATCH /api/users/:id  – own profile or admin
router.patch('/:id', requireAuth, async (req, res) => {
  const isOwn   = req.user.id === req.params.id
  const isAdmin = req.profile?.role === 'admin'
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  const allowed = ['full_name', 'phone', 'address', 'city', 'state', 'zip_code', 'date_of_birth', 'ssn_last_four', 'sin_number', 'filing_status', 'service_type', 'service_data']
  if (isAdmin) allowed.push('notes', 'is_approved', 'filing_progress')

  // service_type must reference an existing form definition (built-in or custom)
  if ('service_type' in req.body && req.body.service_type !== null) {
    const ok = await queryOne(`SELECT form_key FROM form_definitions WHERE form_key = ?`, [req.body.service_type])
    if (!ok) return res.status(400).json({ error: 'Invalid service_type' })
  }

  const cols = []
  const vals = []
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k]
      if (k === 'is_approved')     v = v ? 1 : 0
      if (k === 'filing_progress') {
        if (!FILING_PROGRESS_VALUES.has(v)) return res.status(400).json({ error: 'Invalid filing_progress' })
      }
      if (k === 'service_data' && v !== null && typeof v === 'object') {
        v = JSON.stringify(v)
      }
      cols.push(`${k} = ?`)
      vals.push(v === '' ? null : v)
    }
  }
  if (cols.length === 0) {
    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.params.id])
    if (profile) profile.is_approved = !!profile.is_approved
    return res.json(profile)
  }
  vals.push(req.params.id)

  try {
    // Read previous values so we can detect transitions after the UPDATE.
    const prev = isAdmin
      ? await queryOne(`SELECT is_approved, filing_progress FROM profiles WHERE id = ?`, [req.params.id])
      : null

    const triggerApproval =
      isAdmin && 'is_approved' in req.body && req.body.is_approved && prev && !prev.is_approved

    const triggerProgress =
      isAdmin && 'filing_progress' in req.body && prev && req.body.filing_progress !== prev.filing_progress

    await pool.execute(`UPDATE profiles SET ${cols.join(', ')} WHERE id = ?`, vals)

    if (triggerApproval) {
      await copyDefaultItemsToUser(req.params.id, req.user.id)
    }

    const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.params.id])
    if (profile) profile.is_approved = !!profile.is_approved

    // Fire-and-forget emails (run after the response is committed to disk).
    if (triggerApproval && profile?.email) {
      sendApprovalEmail({ to: profile.email, fullName: profile.full_name })
    }
    if (triggerProgress && profile?.email) {
      sendFilingProgressEmail({
        to: profile.email,
        fullName: profile.full_name,
        progress: profile.filing_progress,
      })
    }

    res.json(profile)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update profile' })
  }
})

// GET /api/users/:id/profile-pdf — admin only, returns a structured PDF
router.get('/:id/profile-pdf', requireAdmin, async (req, res) => {
  const profile = await queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ?`, [req.params.id])
  if (!profile) return res.status(404).json({ error: 'User not found' })

  // Boolean coercion for is_approved (tinyint comes back as 0/1)
  profile.is_approved = !!profile.is_approved

  // Fetch the matching form definition so we can render labels for service_data
  const formDef = await queryOne(
    `SELECT form_key, label FROM form_definitions WHERE form_key = ?`,
    [profile.service_type]
  )
  let form = null
  if (formDef) {
    const fields = await query(
      `SELECT id, field_key, field_label, field_type, field_options, required, order_index, is_builtin
       FROM form_fields WHERE form_key = ? ORDER BY order_index, field_label`,
      [profile.service_type]
    )
    form = {
      ...formDef,
      fields: fields.map(f => ({
        ...f,
        field_options: typeof f.field_options === 'string' ? JSON.parse(f.field_options) : f.field_options,
        required:      !!f.required,
        is_builtin:    !!f.is_builtin,
      })),
    }
  }

  const filename = `${(profile.full_name || profile.email || 'client').replace(/[^a-zA-Z0-9_-]+/g, '_')}-profile.pdf`
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  generateProfilePdf({ profile, form }).pipe(res)
})

// POST /api/users/:id/email — admin only, send a custom email to a client
router.post('/:id/email', requireAdmin, async (req, res) => {
  const { subject, message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' })

  const profile = await queryOne(`SELECT email, full_name FROM profiles WHERE id = ?`, [req.params.id])
  if (!profile) return res.status(404).json({ error: 'User not found' })

  sendAdminMessageEmail({
    to:       profile.email,
    fullName: profile.full_name,
    subject:  subject?.trim() || 'A message from Finmax Services',
    message:  message.trim(),
  })

  res.json({ success: true, queued_to: profile.email })
})

export default router
