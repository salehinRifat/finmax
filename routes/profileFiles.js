import { Router } from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { pool, queryOne } from '../lib/db.js'
import { requireAuth } from '../middleware/auth.js'
import { signDownloadToken, verifyToken } from '../lib/auth.js'

const router = Router()

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')
;(async () => { try { await fs.mkdir(UPLOAD_ROOT, { recursive: true }) } catch {} })()

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
])
const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xls', 'xlsx', 'csv'])
const ALLOWED_PURPOSES   = new Set(['self_employed_form'])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true)
    else cb(Object.assign(new Error('File type not allowed'), { status: 415 }))
  },
})

const FILE_COLS = 'id, user_id, purpose, file_name, file_path, file_size, file_type, uploaded_at'

// POST /api/profile-files — upload an attachment for the caller's own profile.
// Admins may upload on behalf of another user via `userId` in the body.
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const { purpose } = req.body
  const isAdmin = req.profile?.role === 'admin'
  const userId  = isAdmin ? (req.body.userId || req.user.id) : req.user.id

  if (!req.file)                          return res.status(400).json({ error: 'file is required' })
  if (!purpose || !ALLOWED_PURPOSES.has(purpose)) return res.status(400).json({ error: 'Invalid purpose' })
  if (!UUID_RE.test(userId))              return res.status(400).json({ error: 'Invalid userId' })

  try {
    const rawExt = req.file.originalname.split('.').pop()?.toLowerCase()
    const ext    = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : 'bin'
    const ts      = Date.now()
    const relPath = path.posix.join(userId, 'profile-files', `${purpose}-${ts}.${ext}`)
    const absPath = path.join(UPLOAD_ROOT, userId, 'profile-files', `${purpose}-${ts}.${ext}`)

    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, req.file.buffer)

    const id = uuid()
    await pool.execute(
      `INSERT INTO profile_files (id, user_id, purpose, file_name, file_path, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, purpose, req.file.originalname, relPath, req.file.size, req.file.mimetype]
    )

    const row = await queryOne(`SELECT ${FILE_COLS} FROM profile_files WHERE id = ?`, [id])
    res.status(201).json(row)
  } catch (err) {
    console.error('[profile-files/upload]', err.message)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// GET /api/profile-files/:id/url — returns a short-lived signed URL the
// browser can open to view / download the file.
router.get('/:id/url', requireAuth, async (req, res) => {
  const row = await queryOne(`SELECT ${FILE_COLS} FROM profile_files WHERE id = ?`, [req.params.id])
  if (!row) return res.status(404).json({ error: 'File not found' })

  const isOwn   = row.user_id === req.user.id
  const isAdmin = req.profile?.role === 'admin'
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  const token = signDownloadToken({ sub: req.user.id, file: row.id, kind: 'profile-file' })
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host  = req.headers['x-forwarded-host']  || req.get('host')
  const url   = `${proto}://${host}/api/profile-files/${row.id}/download?token=${encodeURIComponent(token)}`
  res.json({ url, file: row })
})

// GET /api/profile-files/:id/download?token=  — serves the file inline.
router.get('/:id/download', async (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'Missing download token' })

  let decoded
  try { decoded = verifyToken(token) } catch { return res.status(401).json({ error: 'Invalid or expired token' }) }
  if (decoded.scope !== 'download' || decoded.kind !== 'profile-file' || decoded.file !== req.params.id) {
    return res.status(401).json({ error: 'Invalid download token' })
  }

  const row = await queryOne(`SELECT ${FILE_COLS} FROM profile_files WHERE id = ?`, [req.params.id])
  if (!row) return res.status(404).json({ error: 'File not found' })

  const absPath = path.join(UPLOAD_ROOT, row.file_path)
  try { await fs.access(absPath) }
  catch { return res.status(404).json({ error: 'File missing on disk' }) }

  res.setHeader('Content-Type', row.file_type || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name)}"`)
  res.sendFile(absPath)
})

// DELETE /api/profile-files/:id — owner or admin only.
router.delete('/:id', requireAuth, async (req, res) => {
  const row = await queryOne(`SELECT ${FILE_COLS} FROM profile_files WHERE id = ?`, [req.params.id])
  if (!row) return res.status(404).json({ error: 'Not found' })

  const isOwn   = row.user_id === req.user.id
  const isAdmin = req.profile?.role === 'admin'
  if (!isOwn && !isAdmin) return res.status(403).json({ error: 'Forbidden' })

  try {
    const absPath = path.join(UPLOAD_ROOT, row.file_path)
    await fs.unlink(absPath).catch(() => {})
    await pool.execute(`DELETE FROM profile_files WHERE id = ?`, [row.id])
    res.json({ success: true })
  } catch (err) {
    console.error('[profile-files/delete]', err.message)
    res.status(500).json({ error: 'Failed to delete file' })
  }
})

export default router
