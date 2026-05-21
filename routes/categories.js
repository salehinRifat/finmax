import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const CAT_COLS  = 'id, name, description, is_general, service_type, order_index, created_by, created_at'
const ITEM_COLS = 'id, category_id, title, description, required, order_index, created_at'

// GET /api/categories  – categories + their items (admin + user can read)
router.get('/', requireAuth, async (req, res) => {
  try {
    const cats  = await query(`SELECT ${CAT_COLS} FROM checklist_categories ORDER BY order_index`)
    if (cats.length === 0) return res.json([])
    const items = await query(`SELECT ${ITEM_COLS} FROM category_items ORDER BY order_index`)
    const byCat = items.reduce((acc, it) => {
      (acc[it.category_id] ||= []).push(it)
      return acc
    }, {})
    res.json(cats.map(c => ({ ...c, category_items: byCat[c.id] || [] })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /api/categories
router.post('/', requireAdmin, async (req, res) => {
  const { name, description, is_general, service_type, order_index, created_by } = req.body
  if (!name) return res.status(400).json({ error: 'name is required' })

  const id = uuid()
  try {
    await pool.execute(
      `INSERT INTO checklist_categories (id, name, description, is_general, service_type, order_index, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, description ?? null, is_general ? 1 : 0, service_type || null, order_index ?? 0, created_by || req.user.id]
    )
    const data = await queryOne(`SELECT ${CAT_COLS} FROM checklist_categories WHERE id = ?`, [id])
    res.status(201).json({ ...data, category_items: [] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// PATCH /api/categories/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'description', 'is_general', 'service_type', 'order_index']
  const cols = []
  const vals = []
  for (const k of allowed) {
    if (k in req.body) {
      cols.push(`${k} = ?`)
      vals.push(k === 'is_general' ? (req.body[k] ? 1 : 0) : req.body[k])
    }
  }
  if (cols.length === 0) {
    const data = await queryOne(`SELECT ${CAT_COLS} FROM checklist_categories WHERE id = ?`, [req.params.id])
    return res.json(data)
  }
  vals.push(req.params.id)
  try {
    await pool.execute(`UPDATE checklist_categories SET ${cols.join(', ')} WHERE id = ?`, vals)
    const data = await queryOne(`SELECT ${CAT_COLS} FROM checklist_categories WHERE id = ?`, [req.params.id])
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// DELETE /api/categories/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.execute(`DELETE FROM checklist_categories WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /api/categories/:id/items
router.post('/:id/items', requireAdmin, async (req, res) => {
  const { title, description, required, order_index } = req.body
  if (!title) return res.status(400).json({ error: 'title is required' })

  const id = uuid()
  try {
    await pool.execute(
      `INSERT INTO category_items (id, category_id, title, description, required, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, title, description ?? null, required ?? 1, order_index ?? 0]
    )
    const data = await queryOne(`SELECT ${ITEM_COLS} FROM category_items WHERE id = ?`, [id])
    res.status(201).json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// DELETE /api/categories/items/:id
router.delete('/items/:id', requireAdmin, async (req, res) => {
  try {
    await pool.execute(`DELETE FROM category_items WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

export default router
