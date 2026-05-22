import { Router } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from '../lib/db.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { signDownloadToken, verifyToken } from '../lib/auth.js'

const router = Router()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let UPLOAD_ROOT
if (typeof path.resolve === 'function') {
  UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')
} else {
  // Fallback for environments where `path.resolve` is not available.
  UPLOAD_ROOT = fileURLToPath(new URL(`../${process.env.UPLOAD_DIR || 'uploads'}`, import.meta.url))
}

// Create upload root asynchronously but avoid top-level `await` so the
// module can be required by environments that don't support top-level await.
(async () => {
  try { await fs.mkdir(UPLOAD_ROOT, { recursive: true }) } catch (err) { /* ignore */ }
})()

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'])

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

const DOC_COLS = 'id, user_id, checklist_item_id, file_name, file_path, file_size, file_type, status, admin_notes, uploaded_at, reviewed_at, reviewed_by'

// GET /api/documents?userId=  – user: own; admin: any (omit userId to get all)
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.profile?.role === 'admin'
    if (isAdmin && !req.query.userId) {
      const rows = await query(`SELECT ${DOC_COLS} FROM documents ORDER BY uploaded_at DESC`)
      return res.json(rows)
    }
    const targetId = isAdmin ? req.query.userId : req.user.id
    const rows = await query(
      `SELECT ${DOC_COLS} FROM documents WHERE user_id = ? ORDER BY uploaded_at DESC`,
      [targetId]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to fetch documents' })
  }
})

// POST /api/documents  – upload file + create record
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const { itemId } = req.body
  const isAdmin = req.profile?.role === 'admin'
  const userId  = isAdmin ? (req.body.userId || req.user.id) : req.user.id

  if (!req.file || !itemId) {
    return res.status(400).json({ error: 'file and itemId are required' })
  }
  if (!isUuid(userId) || !isUuid(itemId)) {
    return res.status(400).json({ error: 'Invalid userId or itemId' })
  }

  try {
    const rawExt = req.file.originalname.split('.').pop()?.toLowerCase()
    const ext    = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : 'bin'
    const ts      = Date.now()
    const relPath = path.posix.join(userId, itemId, `${ts}.${ext}`)
    const absPath = path.join(UPLOAD_ROOT, userId, itemId, `${ts}.${ext}`)

    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, req.file.buffer)

    const id = uuid()
    await pool.execute(
      `INSERT INTO documents (id, user_id, checklist_item_id, file_name, file_path, file_size, file_type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, itemId, req.file.originalname, relPath, req.file.size, req.file.mimetype, 'pending']
    )
    const data = await queryOne(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`, [id])

    // Notify all admins about the new upload
    const admins   = await query(`SELECT id FROM profiles WHERE role = ?`, ['admin'])
    const uploader = await queryOne(`SELECT full_name, email FROM profiles WHERE id = ?`, [userId])
    if (admins.length) {
      const uploaderName = uploader?.full_name || uploader?.email || 'A user'
      const notifTitle   = `${uploaderName} uploaded a file`
      const notifBody    = `"${req.file.originalname}" is waiting for your review`
      const metadata     = JSON.stringify({ document_id: data.id, user_id: userId })
      for (const a of admins) {
        await pool.execute(
          `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
          [uuid(), a.id, 'document_uploaded', notifTitle, notifBody, metadata]
        )
      }
      const io  = req.app.get('io')
      const now = new Date().toISOString()
      admins.forEach(a => {
        io.to(`user:${a.id}`).emit('notification', {
          type: 'document_uploaded',
          title: notifTitle,
          body:  notifBody,
          is_read: false,
          created_at: now,
          metadata: { document_id: data.id, user_id: userId },
        })
      })
    }

    res.status(201).json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// GET /api/documents/:id/url  – returns a short-lived URL for inline viewing/download
router.get('/:id/url', requireAuth, async (req, res) => {
  const doc = await queryOne(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`, [req.params.id])
  if (!doc) return res.status(404).json({ error: 'Document not found' })

  const isOwn   = doc.user_id === req.user.id
  const isAdmin = req.profile?.role === 'admin'
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  const token = signDownloadToken({ sub: req.user.id, doc: doc.id })
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.get('host')
  const url   = `${proto}://${host}/api/documents/${doc.id}/download?token=${encodeURIComponent(token)}`
  res.json({ url })
})

// GET /api/documents/:id/download?token=  – serve file inline using signed token
router.get('/:id/download', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'Missing download token' })

  let decoded
  try { decoded = verifyToken(token) } catch { return res.status(401).json({ error: 'Invalid or expired token' }) }
  if (decoded.scope !== 'download' || decoded.doc !== req.params.id) {
    return res.status(401).json({ error: 'Invalid download token' })
  }

  const doc = await queryOne(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`, [req.params.id])
  if (!doc) return res.status(404).json({ error: 'Document not found' })

  const absPath = path.join(UPLOAD_ROOT, doc.file_path)
  try {
    await fs.access(absPath)
  } catch {
    return res.status(404).json({ error: 'File missing on disk' })
  }

  res.setHeader('Content-Type', doc.file_type || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file_name)}"`)
  res.sendFile(absPath)
})

// PATCH /api/documents/:id  – admin only (approve/reject + notes)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, admin_notes } = req.body
  if (status && !['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' })
  }

  const cols = ['reviewed_by = ?', 'reviewed_at = ?']
  const vals = [req.user.id, new Date()]
  if (status)                    { cols.push('status = ?');      vals.push(status) }
  if (admin_notes !== undefined) { cols.push('admin_notes = ?'); vals.push(admin_notes) }
  vals.push(req.params.id)

  try {
    await pool.execute(`UPDATE documents SET ${cols.join(', ')} WHERE id = ?`, vals)
    const data = await queryOne(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`, [req.params.id])

    if (status === 'approved' || status === 'rejected') {
      const noteBody = admin_notes
        ? `"${data.file_name}" was ${status}: ${admin_notes}`
        : `"${data.file_name}" was ${status}`
      await pool.execute(
        `INSERT INTO notifications (id, recipient_id, type, title, body, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuid(), data.user_id,
          status === 'approved' ? 'document_approved' : 'document_rejected',
          `Document ${status}`, noteBody,
          JSON.stringify({ document_id: data.id }),
        ]
      )
      req.app.get('io').to(`user:${data.user_id}`).emit('notification', {
        type: status === 'approved' ? 'document_approved' : 'document_rejected',
        title: `Document ${status}`,
        body: noteBody,
        is_read: false,
        created_at: new Date().toISOString(),
      })
    }

    res.json(data)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to update document' })
  }
})

// DELETE /api/documents/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const doc = await queryOne(`SELECT ${DOC_COLS} FROM documents WHERE id = ?`, [req.params.id])
  if (!doc) return res.status(404).json({ error: 'Not found' })

  const isOwn   = doc.user_id === req.user.id
  const isAdmin = req.profile?.role === 'admin'
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  try {
    const absPath = path.join(UPLOAD_ROOT, doc.file_path)
    await fs.unlink(absPath).catch(() => {})
    await pool.execute(`DELETE FROM documents WHERE id = ?`, [doc.id])
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to delete document' })
  }
})

export default router
