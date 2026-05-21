import 'dotenv/config'
import http from 'http'
import express from 'express'
import cors from 'cors'
import compression from 'compression'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { Server } from 'socket.io'
import { verifyToken } from './lib/auth.js'
import { queryOne }    from './lib/db.js'
import { ensureGeneralCategory } from './lib/seed.js'
import { ensureBuiltinForms } from './lib/formSeed.js'
import { verifyEmailConfig } from './lib/email.js'
import authRouter          from './routes/auth.js'
import usersRouter         from './routes/users.js'
import checklistRouter     from './routes/checklists.js'
import documentsRouter     from './routes/documents.js'
import categoriesRouter    from './routes/categories.js'
import notificationsRouter from './routes/notifications.js'
import messagesRouter      from './routes/messages.js'
import formsRouter         from './routes/forms.js'

const app        = express()
const httpServer = http.createServer(app)
const PORT       = process.env.PORT || 5000

const prodOrigins = process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []
const devOrigins  = process.env.NODE_ENV !== 'production'
  ? ['http://localhost:3000','http://localhost:3001','http://localhost:3002','http://localhost:5173','http://localhost:5174']
  : []
const allowedOrigins = [...prodOrigins, ...devOrigins]

// ── Socket.io ──────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
})

// Validate our JWT on every socket handshake
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) return next(new Error('Authentication required'))
  try {
    const decoded = verifyToken(token)
    if (decoded.scope === 'download') return next(new Error('Invalid token scope'))
    const user = await queryOne('SELECT id FROM profiles WHERE id = ?', [decoded.sub])
    if (!user) return next(new Error('User not found'))
    socket.userId = user.id
    next()
  } catch {
    next(new Error('Invalid token'))
  }
})

io.on('connection', (socket) => {
  // Each user has their own room — emit to `user:<id>` to target them
  socket.join(`user:${socket.userId}`)

  // Message threads: clients open thread:{userId}, admins can open any
  socket.on('join:thread', async (userId) => {
    if (!userId) return
    if (userId === socket.userId) { socket.join(`thread:${userId}`); return }
    const me = await queryOne('SELECT role FROM profiles WHERE id = ?', [socket.userId])
    if (me?.role === 'admin') socket.join(`thread:${userId}`)
  })
  socket.on('leave:thread', (userId) => {
    if (userId) socket.leave(`thread:${userId}`)
  })

  socket.on('disconnect', () => {})
})

// Make io accessible in route handlers via req.app.get('io')
app.set('io', io)

// ── Express middleware ─────────────────────────────────────────────────────────
// Loosen CORP/CSP so the frontend (different port in dev) can embed PDFs and
// images served from the documents/messages download routes in iframes/<img>.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  frameguard: false,
}))
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(compression())

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
})
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many uploads, please try again later' },
})

app.use('/api', apiLimiter)
app.post('/api/documents', uploadLimiter)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter)
app.use('/api/users',         usersRouter)
app.use('/api/checklists',    checklistRouter)
app.use('/api/documents',     documentsRouter)
app.use('/api/categories',    categoriesRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/messages',      messagesRouter)
app.use('/api/forms',         formsRouter)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File exceeds the 20 MB limit' })
  }
  res.status(500).json({ error: 'Internal server error' })
})

// One-time / idempotent seeds.
ensureGeneralCategory().catch(err => console.error('General seed failed:', err))
ensureBuiltinForms().catch(err => console.error('Form seed failed:', err))

// Verify Gmail SMTP credentials so we see auth issues at boot, not later.
verifyEmailConfig()

// Last-resort safety net: a transient DB error (e.g. ECONNRESET from Hostinger
// dropping an idle connection) should not crash the whole process.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled]', reason?.code || reason?.message || reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err?.code || err?.message || err)
})

httpServer.listen(PORT, () => console.log(`TaxPro backend running on http://localhost:${PORT}`))
