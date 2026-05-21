import { Router } from 'express'
import { pool, query } from '../lib/db.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const COLS = 'id, recipient_id, type, title, body, metadata, is_read, created_at'

// GET /api/notifications — own notifications, newest first (max 50)
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT ${COLS} FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    )
    // mysql2 returns JSON columns as objects already
    res.json(rows.map(r => ({ ...r, is_read: !!r.is_read })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch notifications' })
  }
})

// PATCH /api/notifications/read-all — mark every unread as read
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    await pool.execute(
      `UPDATE notifications SET is_read = 1 WHERE recipient_id = ? AND is_read = 0`,
      [req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update notifications' })
  }
})

// PATCH /api/notifications/:id/read — mark single notification as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.execute(
      `UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?`,
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update notification' })
  }
})

export default router
