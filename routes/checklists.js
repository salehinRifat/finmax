import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'

const router = Router()

const ITEM_COLS = 'id, user_id, title, description, category, required, order_index, created_by, created_at, updated_at'

// GET /api/checklists?userId=  – user: own; admin: any (omit userId to get all)
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.profile?.role === 'admin'
    if (isAdmin && !req.query.userId) {
      const rows = await query(`SELECT ${ITEM_COLS} FROM checklist_items ORDER BY order_index`)
      return res.json(rows)
    }
    const targetId = isAdmin ? req.query.userId : req.user.id
    const rows = await query(
      `SELECT ${ITEM_COLS} FROM checklist_items WHERE user_id = ? ORDER BY order_index`,
      [targetId]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /api/checklists/bulk  – admin only (insert multiple items)
router.post('/bulk', requireAdmin, async (req, res) => {
  const items = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Body must be a non-empty array of checklist items' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const created = []
    for (const it of items) {
      const id = uuid()
      await conn.execute(
        `INSERT INTO checklist_items (id, user_id, title, description, category, required, order_index, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          it.user_id,
          it.title,
          it.description ?? null,
          it.category    ?? 'general',
          it.required    ?? 1,
          it.order_index ?? 0,
          it.created_by  ?? req.user.id,
        ]
      )
      created.push({ ...it, id })
    }

    // Notify each unique user about their new items
    const byUser = items.reduce((acc, it) => {
      if (it.user_id) acc[it.user_id] = (acc[it.user_id] || 0) + 1
      return acc
    }, {})
    for (const [uid, count] of Object.entries(byUser)) {
      await conn.execute(
        `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuid(), uid, 'checklist_assigned', 'Checklist updated',
          `${count} new item${count > 1 ? 's were' : ' was'} added to your checklist`,
          JSON.stringify({}),
        ]
      )
    }
    await conn.commit()

    const io  = req.app.get('io')
    const now = new Date().toISOString()
    Object.entries(byUser).forEach(([uid, count]) => {
      io.to(`user:${uid}`).emit('notification', {
        type: 'checklist_assigned',
        title: 'Checklist updated',
        body: `${count} new item${count > 1 ? 's were' : ' was'} added to your checklist`,
        is_read: false,
        created_at: now,
      })
    })

    res.status(201).json(created)
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  } finally {
    conn.release()
  }
})

// POST /api/checklists/apply-to-all  – admin only (sync template items to every user with dedup)
router.post('/apply-to-all', requireAdmin, async (req, res) => {
  const { items } = req.body
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' })
  }

  try {
    const users = await query(`SELECT id FROM profiles WHERE role = ?`, ['user'])
    if (!users.length) return res.json({ totalAdded: 0, userCount: 0 })

    // Single query: existing items for ALL users at once. Build a map keyed by user_id.
    const userIds = users.map(u => u.id)
    const placeholders = userIds.map(() => '?').join(',')
    const allExisting = await query(
      `SELECT user_id, title FROM checklist_items WHERE user_id IN (${placeholders})`,
      userIds
    )
    const byUser = new Map()
    for (const u of users) byUser.set(u.id, { titles: new Set(), count: 0 })
    for (const row of allExisting) {
      const entry = byUser.get(row.user_id)
      if (entry) {
        entry.titles.add(row.title.toLowerCase())
        entry.count += 1
      }
    }

    let totalAdded = 0
    for (const u of users) {
      const { titles: existingTitles, count: existingCount } = byUser.get(u.id)
      const toInsert = items
        .filter(t => !existingTitles.has(t.title.toLowerCase()))
        .map((t, idx) => ({
          id:          uuid(),
          user_id:     u.id,
          title:       t.title,
          description: t.description ?? null,
          required:    t.required ?? 1,
          category:    'general',
          order_index: existingCount + idx,
          created_by:  req.user.id,
        }))

      if (toInsert.length) {
        for (const it of toInsert) {
          await pool.execute(
            `INSERT INTO checklist_items (id, user_id, title, description, category, required, order_index, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [it.id, it.user_id, it.title, it.description, it.category, it.required, it.order_index, it.created_by]
          )
        }
        totalAdded += toInsert.length

        const body = `${toInsert.length} new item${toInsert.length > 1 ? 's were' : ' was'} added to your checklist`
        await pool.execute(
          `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), u.id, 'checklist_assigned', 'Checklist updated', body, JSON.stringify({})]
        )
        req.app.get('io').to(`user:${u.id}`).emit('notification', {
          type: 'checklist_assigned',
          title: 'Checklist updated',
          body,
          is_read: false,
          created_at: new Date().toISOString(),
        })
      }
    }

    res.json({ totalAdded, userCount: users.length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// POST /api/checklists  – admin only (single item)
router.post('/', requireAdmin, async (req, res) => {
  const { user_id, title, description, category, required, order_index } = req.body
  if (!user_id || !title) return res.status(400).json({ error: 'user_id and title are required' })

  const id = uuid()
  try {
    await pool.execute(
      `INSERT INTO checklist_items (id, user_id, title, description, category, required, order_index, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, user_id, title, description ?? null, category || 'general', required ?? 1, order_index ?? 0, req.user.id]
    )
    const data = await queryOne(`SELECT ${ITEM_COLS} FROM checklist_items WHERE id = ?`, [id])

    // Notify the user about their new checklist item
    await pool.execute(
      `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), user_id, 'checklist_assigned', 'New checklist item',
       `"${title}" was added to your checklist`, JSON.stringify({ item_id: id })]
    )
    req.app.get('io').to(`user:${user_id}`).emit('notification', {
      type: 'checklist_assigned',
      title: 'New checklist item',
      body: `"${title}" was added to your checklist`,
      is_read: false,
      created_at: new Date().toISOString(),
    })

    res.status(201).json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// PATCH /api/checklists/:id  – admin only
router.patch('/:id', requireAdmin, async (req, res) => {
  const allowed = ['title', 'description', 'category', 'required', 'order_index']
  const cols = []
  const vals = []
  for (const k of allowed) {
    if (k in req.body) {
      cols.push(`${k} = ?`)
      vals.push(req.body[k])
    }
  }
  if (cols.length === 0) {
    const data = await queryOne(`SELECT ${ITEM_COLS} FROM checklist_items WHERE id = ?`, [req.params.id])
    return res.json(data)
  }
  vals.push(req.params.id)
  try {
    await pool.execute(`UPDATE checklist_items SET ${cols.join(', ')} WHERE id = ?`, vals)
    const data = await queryOne(`SELECT ${ITEM_COLS} FROM checklist_items WHERE id = ?`, [req.params.id])
    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

// DELETE /api/checklists/:id  – admin only
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.execute(`DELETE FROM checklist_items WHERE id = ?`, [req.params.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Database error' })
  }
})

export default router
