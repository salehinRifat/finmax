import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const FIELD_TYPES = new Set(['text', 'date', 'select', 'checkbox', 'textarea', 'number'])

// GET /api/forms  — PUBLIC, list all forms + their fields.
// Used by the register page (anonymous) and the profile page (authenticated).
// Form definitions aren't sensitive — they only describe what fields a service collects.
router.get('/', async (req, res) => {
  try {
    const defs = await query(
      `SELECT id, form_key, label, description, is_builtin, order_index FROM form_definitions ORDER BY order_index, label`
    )
    const fields = await query(
      `SELECT id, form_key, field_key, field_label, field_type, field_options, required, order_index, is_builtin
       FROM form_fields ORDER BY order_index, field_label`
    )
    const byForm = fields.reduce((acc, f) => {
      const opts = f.field_options
      const parsed = typeof opts === 'string' ? JSON.parse(opts) : opts
      ;(acc[f.form_key] ||= []).push({ ...f, field_options: parsed, required: !!f.required, is_builtin: !!f.is_builtin })
      return acc
    }, {})
    res.json(defs.map(d => ({
      ...d,
      is_builtin: !!d.is_builtin,
      fields: byForm[d.form_key] || [],
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch forms' })
  }
})

// POST /api/forms  — admin only, create a custom form
router.post('/', requireAdmin, async (req, res) => {
  const { form_key, label, description, order_index } = req.body
  if (!form_key?.trim() || !label?.trim()) {
    return res.status(400).json({ error: 'form_key and label are required' })
  }
  const safeKey = form_key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 50)
  const existing = await queryOne(`SELECT id FROM form_definitions WHERE form_key = ?`, [safeKey])
  if (existing) return res.status(409).json({ error: 'A form with this key already exists' })

  const id = uuid()
  try {
    await pool.execute(
      `INSERT INTO form_definitions (id, form_key, label, description, is_builtin, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, safeKey, label.trim(), description?.trim() || null, 0, order_index ?? 100]
    )
    res.status(201).json({ id, form_key: safeKey, label: label.trim(), description: description?.trim() || null, is_builtin: false, order_index: order_index ?? 100, fields: [] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create form' })
  }
})

// PATCH /api/forms/:id  — admin only, edit form label/description
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['label', 'description', 'order_index']
  const cols = []
  const vals = []
  for (const k of allowed) {
    if (k in req.body) { cols.push(`${k} = ?`); vals.push(req.body[k]) }
  }
  if (cols.length === 0) return res.json({ success: true })
  vals.push(req.params.id)
  try {
    await pool.execute(`UPDATE form_definitions SET ${cols.join(', ')} WHERE id = ?`, vals)
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update form' })
  }
})

// DELETE /api/forms/:id  — admin only, only allowed for non-builtin forms
router.delete('/:id', requireAdmin, async (req, res) => {
  const form = await queryOne(`SELECT form_key, is_builtin FROM form_definitions WHERE id = ?`, [req.params.id])
  if (!form) return res.status(404).json({ error: 'Form not found' })
  if (form.is_builtin) return res.status(400).json({ error: 'Built-in forms cannot be deleted' })
  try {
    await pool.execute(`DELETE FROM form_fields WHERE form_key = ?`, [form.form_key])
    await pool.execute(`DELETE FROM form_definitions WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete form' })
  }
})

// POST /api/forms/:formKey/fields  — admin only, add a field to a form
router.post('/:formKey/fields', requireAdmin, async (req, res) => {
  const { field_key, field_label, field_type, field_options, required, order_index } = req.body
  if (!field_key?.trim() || !field_label?.trim() || !field_type) {
    return res.status(400).json({ error: 'field_key, field_label, and field_type are required' })
  }
  if (!FIELD_TYPES.has(field_type)) {
    return res.status(400).json({ error: 'Invalid field_type' })
  }
  const safeKey = field_key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 50)
  const formExists = await queryOne(`SELECT id FROM form_definitions WHERE form_key = ?`, [req.params.formKey])
  if (!formExists) return res.status(404).json({ error: 'Form not found' })

  const dupe = await queryOne(
    `SELECT id FROM form_fields WHERE form_key = ? AND field_key = ?`,
    [req.params.formKey, safeKey]
  )
  if (dupe) return res.status(409).json({ error: 'A field with this key already exists on this form' })

  const id = uuid()
  try {
    await pool.execute(
      `INSERT INTO form_fields (id, form_key, field_key, field_label, field_type, field_options, required, order_index, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, req.params.formKey, safeKey, field_label.trim(), field_type,
        field_options ? JSON.stringify(field_options) : null,
        required ? 1 : 0, order_index ?? 100, 0,
      ]
    )
    res.status(201).json({ id, field_key: safeKey })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to add field' })
  }
})

// PATCH /api/forms/fields/:id  — admin only, edit a field
router.patch('/fields/:id', requireAdmin, async (req, res) => {
  // Seeded built-in fields back the hardcoded profile sections — letting an
  // admin rename/retype them here would silently break the rendering, so we
  // lock them down at the API boundary.
  const existing = await queryOne(`SELECT is_builtin FROM form_fields WHERE id = ?`, [req.params.id])
  if (!existing) return res.status(404).json({ error: 'Field not found' })
  if (existing.is_builtin) return res.status(400).json({ error: 'Built-in fields cannot be edited' })

  const allowed = ['field_label', 'field_type', 'field_options', 'required', 'order_index']
  const cols = []
  const vals = []
  for (const k of allowed) {
    if (k in req.body) {
      let v = req.body[k]
      if (k === 'field_type' && !FIELD_TYPES.has(v)) return res.status(400).json({ error: 'Invalid field_type' })
      if (k === 'required')                              v = v ? 1 : 0
      if (k === 'field_options' && v !== null && typeof v === 'object') v = JSON.stringify(v)
      cols.push(`${k} = ?`); vals.push(v)
    }
  }
  if (cols.length === 0) return res.json({ success: true })
  vals.push(req.params.id)
  try {
    await pool.execute(`UPDATE form_fields SET ${cols.join(', ')} WHERE id = ?`, vals)
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update field' })
  }
})

// DELETE /api/forms/fields/:id  — admin only, built-in fields are locked
router.delete('/fields/:id', requireAdmin, async (req, res) => {
  const existing = await queryOne(`SELECT is_builtin FROM form_fields WHERE id = ?`, [req.params.id])
  if (!existing) return res.status(404).json({ error: 'Field not found' })
  if (existing.is_builtin) return res.status(400).json({ error: 'Built-in fields cannot be deleted' })
  try {
    await pool.execute(`DELETE FROM form_fields WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete field' })
  }
})

export default router
