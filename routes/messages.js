import { Router } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth } from '../middleware/auth.js'
import { signDownloadToken, verifyToken } from '../lib/auth.js'

const router = Router()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')

// Ensure upload root exists without using top-level await.
(async () => {
  try { await fs.mkdir(UPLOAD_ROOT, { recursive: true }) } catch (err) { /* ignore */ }
})()

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s)

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true)
    else cb(Object.assign(new Error('File type not allowed'), { status: 415 }))
  },
})

const COLS = 'id, user_id, sender_id, body, attachment_path, attachment_name, attachment_size, attachment_type, is_read, created_at'

// Resolve and authorize the thread the caller wants to interact with.
async function resolveThread(req, res) {
  const isAdmin = req.profile?.role === 'admin'
  const userId  = isAdmin ? (req.query.userId || req.body.userId) : req.user.id
  if (!userId) {
    res.status(400).json({ error: 'userId is required for admins' })
    return null
  }
  if (!isUuid(userId)) {
    res.status(400).json({ error: 'Invalid userId' })
    return null
  }
  if (!isAdmin && userId !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' })
    return null
  }
  return { userId, isAdmin }
}

// GET /api/messages?userId=  — fetch the thread for a client
router.get('/', requireAuth, async (req, res) => {
  const ctx = await resolveThread(req, res); if (!ctx) return
  try {
    const rows = await query(
      `SELECT ${COLS} FROM messages WHERE user_id = ? ORDER BY created_at ASC`,
      [ctx.userId]
    )
    res.json(rows.map(r => ({ ...r, is_read: !!r.is_read })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch messages' })
  }
})

// GET /api/messages/threads  — admin only, list clients with last-message + unread count
router.get('/threads', requireAuth, async (req, res) => {
  if (req.profile?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  try {
    const rows = await query(`
      SELECT
        p.id, p.email, p.full_name,
        (SELECT body FROM messages m WHERE m.user_id = p.id ORDER BY created_at DESC LIMIT 1)        AS last_body,
        (SELECT created_at FROM messages m WHERE m.user_id = p.id ORDER BY created_at DESC LIMIT 1)  AS last_at,
        (SELECT sender_id FROM messages m WHERE m.user_id = p.id ORDER BY created_at DESC LIMIT 1)   AS last_sender,
        (SELECT COUNT(*)  FROM messages m WHERE m.user_id = p.id AND m.sender_id = p.id AND m.is_read = 0) AS unread
      FROM profiles p
      WHERE p.role = 'user'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.user_id = p.id)
      ORDER BY last_at DESC
    `)
    res.json(rows.map(r => ({ ...r, unread: Number(r.unread) || 0 })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch threads' })
  }
})

// POST /api/messages  — send a message (text + optional attachment)
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const ctx = await resolveThread(req, res); if (!ctx) return
  const body = (req.body.body || '').trim() || null
  if (!body && !req.file) return res.status(400).json({ error: 'Message body or attachment required' })

  try {
    let attachmentPath = null, attachmentName = null, attachmentSize = null, attachmentType = null
    if (req.file) {
      const rawExt = req.file.originalname.split('.').pop()?.toLowerCase()
      const ext    = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : 'bin'
      attachmentPath = path.posix.join('messages', ctx.userId, `${Date.now()}.${ext}`)
      const absPath  = path.join(UPLOAD_ROOT, 'messages', ctx.userId, `${Date.now()}.${ext}`)
      await fs.mkdir(path.dirname(absPath), { recursive: true })
      await fs.writeFile(absPath, req.file.buffer)
      attachmentName = req.file.originalname
      attachmentSize = req.file.size
      attachmentType = req.file.mimetype
    }

    const id = uuid()
    await pool.execute(
      `INSERT INTO messages (id, user_id, sender_id, body, attachment_path, attachment_name, attachment_size, attachment_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.userId, req.user.id, body, attachmentPath, attachmentName, attachmentSize, attachmentType]
    )
    const message = await queryOne(`SELECT ${COLS} FROM messages WHERE id = ?`, [id])
    message.is_read = !!message.is_read

    // Broadcast over Socket.io to anyone in this thread room
    const io = req.app.get('io')
    io.to(`thread:${ctx.userId}`).emit('message', message)

    // Notification + toast: who needs to know?
    const sender = await queryOne(`SELECT full_name, email, role FROM profiles WHERE id = ?`, [req.user.id])
    const senderName = sender?.full_name || sender?.email || 'Someone'
    const preview    = body ? body.slice(0, 80) : `Sent an attachment: ${attachmentName}`

    if (ctx.isAdmin) {
      // Admin → client: notify the client
      await pool.execute(
        `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), ctx.userId, 'message', `New message from ${senderName}`, preview,
         JSON.stringify({ message_id: id, user_id: ctx.userId })]
      )
      io.to(`user:${ctx.userId}`).emit('notification', {
        type: 'message',
        title: `New message from ${senderName}`,
        body: preview,
        is_read: false,
        created_at: new Date().toISOString(),
        metadata: { message_id: id, user_id: ctx.userId },
      })
    } else {
      // Client → admins: notify every admin
      const admins = await query(`SELECT id FROM profiles WHERE role = 'admin'`)
      for (const a of admins) {
        await pool.execute(
          `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), a.id, 'message', `New message from ${senderName}`, preview,
           JSON.stringify({ message_id: id, user_id: ctx.userId })]
        )
        io.to(`user:${a.id}`).emit('notification', {
          type: 'message',
          title: `New message from ${senderName}`,
          body: preview,
          is_read: false,
          created_at: new Date().toISOString(),
          metadata: { message_id: id, user_id: ctx.userId },
        })
      }
    }

    res.status(201).json(message)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to send message' })
  }
})

// PATCH /api/messages/read?userId=  — mark all messages from the *other side* as read
router.patch('/read', requireAuth, async (req, res) => {
  const ctx = await resolveThread(req, res); if (!ctx) return
  try {
    if (ctx.isAdmin) {
      // Admin reading: mark all messages sent by the client (sender_id = user_id) as read
      await pool.execute(
        `UPDATE messages SET is_read = 1 WHERE user_id = ? AND sender_id = ? AND is_read = 0`,
        [ctx.userId, ctx.userId]
      )
    } else {
      // User reading: mark all messages NOT sent by them as read
      await pool.execute(
        `UPDATE messages SET is_read = 1 WHERE user_id = ? AND sender_id != ? AND is_read = 0`,
        [ctx.userId, req.user.id]
      )
    }
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to mark messages read' })
  }
})

// GET /api/messages/:id/url  — signed download URL for the message's attachment
router.get('/:id/url', requireAuth, async (req, res) => {
  const msg = await queryOne(`SELECT ${COLS} FROM messages WHERE id = ?`, [req.params.id])
  if (!msg || !msg.attachment_path) return res.status(404).json({ error: 'Attachment not found' })

  const isOwnThread = msg.user_id === req.user.id
  const isAdmin     = req.profile?.role === 'admin'
  if (!isOwnThread && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  const token = signDownloadToken({ sub: req.user.id, msg: msg.id })
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.get('host')
  const url   = `${proto}://${host}/api/messages/${msg.id}/download?token=${encodeURIComponent(token)}`
  res.json({ url })
})

// GET /api/messages/:id/download?token=  — stream an attachment with a signed token
router.get('/:id/download', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'Missing download token' })

  let decoded
  try { decoded = verifyToken(token) } catch { return res.status(401).json({ error: 'Invalid or expired token' }) }
  if (decoded.scope !== 'download' || decoded.msg !== req.params.id) {
    return res.status(401).json({ error: 'Invalid download token' })
  }

  const msg = await queryOne(`SELECT ${COLS} FROM messages WHERE id = ?`, [req.params.id])
  if (!msg || !msg.attachment_path) return res.status(404).json({ error: 'Attachment not found' })

  const absPath = path.join(UPLOAD_ROOT, msg.attachment_path)
  try { await fs.access(absPath) } catch { return res.status(404).json({ error: 'File missing on disk' }) }

  res.setHeader('Content-Type', msg.attachment_type || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(msg.attachment_name || 'attachment')}"`)
  res.sendFile(absPath)
})

export default router
