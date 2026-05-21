import { queryOne } from '../lib/db.js'
import { verifyToken } from '../lib/auth.js'

export async function requireAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split('Bearer ')?.[1]
    if (!token) return res.status(401).json({ error: 'No token provided' })

    let decoded
    try {
      decoded = verifyToken(token)
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    if (decoded.scope === 'download') {
      return res.status(401).json({ error: 'Invalid token scope' })
    }

    const profile = await queryOne(
      'SELECT id, email, full_name, role FROM profiles WHERE id = ?',
      [decoded.sub]
    )
    if (!profile) return res.status(401).json({ error: 'User profile not found' })

    req.user    = { id: profile.id, email: profile.email }
    req.profile = profile
    next()
  } catch (err) {
    next(err)
  }
}

export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.profile?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }
    next()
  })
}
