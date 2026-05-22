import nodemailer from 'nodemailer'
import fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import 'dotenv/config'

const SMTP_HOST   = process.env.SMTP_HOST   || 'smtp.hostinger.com'
const SMTP_PORT   = Number(process.env.SMTP_PORT) || 465
const SMTP_SECURE = process.env.SMTP_SECURE != null
  ? process.env.SMTP_SECURE === 'true'
  : SMTP_PORT === 465
const SMTP_USER   = process.env.NODE_MAILER_USER || ''
const SMTP_PASS   = (process.env.NODE_MAILER_PASSWORD || '').replace(/\s+/g, '')
const FROM_NAME   = process.env.NODE_MAILER_FROM_NAME || 'Finmax Services'
const FROM_ADDR   = SMTP_USER

const enabled = !!(SMTP_USER && SMTP_PASS)

// Logo lives in the frontend's public folder. Resolve from backend/lib up two
// levels to the project root, then into frontend/public/Logo.jpg. We embed it
// inline as a CID attachment so emails render the logo offline.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOGO_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'Logo.jpg')
const LOGO_CID  = 'finmax-logo'
const logoExists = fs.existsSync(LOGO_PATH)
if (!logoExists) console.warn(`[email] logo not found at ${LOGO_PATH} — emails will use text-only header`)

// Lazily-created transporter so the backend boots even with no email config.
let transporter = null
function getTransporter() {
  if (!enabled) return null
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   SMTP_PORT,
      secure: SMTP_SECURE, // true for 465 (SSL), false for 587 (STARTTLS)
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
    })
  }
  return transporter
}

// Startup self-check — silent on success, logs only when something is wrong.
export async function verifyEmailConfig() {
  if (!enabled) return false
  try {
    await getTransporter().verify()
    return true
  } catch (err) {
    console.error('[email] SMTP login failed:', err.message)
    return false
  }
}

// Fire-and-forget send — never block / never crash the calling request.
export async function sendMail({ to, subject, html, text }) {
  const tx = getTransporter()
  if (!tx) return
  try {
    await tx.sendMail({
      from:    `"${FROM_NAME}" <${FROM_ADDR}>`,
      replyTo: FROM_ADDR,
      to,
      subject,
      html,
      text,
      attachments: logoExists ? [{
        filename: 'logo.jpg',
        path:     LOGO_PATH,
        cid:      LOGO_CID,
      }] : [],
      headers: {
        'X-Entity-Ref-ID':  `finmax-${Date.now()}`,
        'X-Mailer':         'Finmax Services Portal',
        'List-Unsubscribe': `<mailto:${FROM_ADDR}?subject=unsubscribe>`,
        'Auto-Submitted':   'auto-generated',
      },
    })
  } catch (err) {
    console.error(`[email] send failed (${to}):`, err.message)
  }
}

// TEMPORARY — diagnostic helper that returns the exact SMTP error instead of
// swallowing it. Used by POST /api/users/debug/test-mail. Safe to remove.
export async function debugSmtp(to) {
  const config = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER,
    passLen: SMTP_PASS.length,
    enabled,
  }
  if (!enabled) return { ok: false, stage: 'config', config, error: 'SMTP not enabled (missing user or password env vars)' }
  const tx = getTransporter()
  try {
    await tx.verify()
  } catch (err) {
    return { ok: false, stage: 'verify', config, error: err.message, code: err.code, command: err.command }
  }
  try {
    const info = await tx.sendMail({
      from:    `"${FROM_NAME}" <${FROM_ADDR}>`,
      to,
      subject: 'Finmax SMTP diagnostic',
      text:    `Diagnostic message at ${new Date().toISOString()}`,
    })
    return { ok: true, stage: 'send', config, messageId: info.messageId, response: info.response }
  } catch (err) {
    return { ok: false, stage: 'send', config, error: err.message, code: err.code, command: err.command, response: err.response }
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

const LOGO_TAG = logoExists
  ? `<img src="cid:${LOGO_CID}" alt="Finmax Services" width="36" height="36" style="display:inline-block;vertical-align:middle;border-radius:0;border:0;outline:none;text-decoration:none;">`
  : `<span style="display:inline-block;background:#c4a55a;color:#0a1a2a;width:36px;height:36px;text-align:center;line-height:36px;font-weight:bold;font-family:Georgia,serif;font-size:18px;vertical-align:middle;">F</span>`

const WRAPPER = (body) => `
<!DOCTYPE html>
<html><body style="font-family:Inter,Helvetica,Arial,sans-serif;background:#F5F4F0;margin:0;padding:32px 16px;color:#0a1a2a;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d0dde8;">
    <tr><td style="padding:24px 28px;background:#0a1a2a;color:#ffffff;">
      ${LOGO_TAG}
      <span style="font-family:Georgia,serif;font-weight:600;font-size:18px;margin-left:12px;vertical-align:middle;color:#ffffff;">Finmax Services</span>
    </td></tr>
    <tr><td style="padding:32px 28px;">${body}</td></tr>
    <tr><td style="padding:18px 28px;background:#F5F4F0;color:#244d73;font-size:12px;border-top:1px solid #d0dde8;">
      Sent by Finmax Services. If you weren't expecting this email, you can safely ignore it.
    </td></tr>
  </table>
</body></html>`

export function sendApprovalEmail({ to, fullName }) {
  const portalUrl = process.env.CLIENT_URL || 'http://localhost:3000'
  const greeting  = fullName ? `Hello ${fullName},` : 'Hello,'
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#0a1a2a;margin:0 0 16px;">Your account access has been approved</h1>
    <p style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 16px;">${greeting}</p>
    <p style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 16px;">
      An administrator has approved your Finmax Services portal account. You may now sign in to view your document checklist and submit any required materials.
    </p>
    <p style="margin:24px 0;">
      <a href="${portalUrl}/login" style="display:inline-block;background:#c4a55a;color:#0a1a2a;padding:12px 24px;text-decoration:none;font-weight:600;font-size:14px;">Sign in</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#7099ba;margin:24px 0 0;">
      Sign-in link: <span style="color:#244d73;">${portalUrl}/login</span>
    </p>`
  return sendMail({
    to,
    subject: 'Finmax Services portal access approved',
    html: WRAPPER(body),
    text: `${greeting}\n\nAn administrator has approved your Finmax Services portal account. Sign in at ${portalUrl}/login to view your document checklist.`,
  })
}

const PROGRESS_COPY = {
  not_started: {
    subject:  'Filing status update: Not Started',
    headline: 'Your filing status has been updated',
    blurb:    'Your accountant has set your filing status to "Not Started". You can sign in to your portal to review your account.',
  },
  waiting_for_docs: {
    subject:  'Filing status update: Waiting for Document',
    headline: 'Documents needed for your filing',
    blurb:    'Your accountant has updated the status of your filing to "Waiting for Document". Please sign in to your portal to review the checklist and upload the requested items.',
  },
  in_progress: {
    subject:  'Filing status update: In Progress',
    headline: 'Your filing is now in progress',
    blurb:    'Your accountant has begun working on your filing. You can sign in to your portal at any time to review the latest status.',
  },
  completed: {
    subject:  'Filing status update: Complete',
    headline: 'Your filing has been completed',
    blurb:    'Your accountant has marked your filing as complete. You can sign in to your portal at any time to review your submitted documents.',
  },
}

// Admin-composed email to a client. message is plain text; we render it
// inside the same branded WRAPPER and preserve line breaks.
export function sendAdminMessageEmail({ to, fullName, subject, message }) {
  const portalUrl = process.env.CLIENT_URL || 'http://localhost:3000'
  const greeting  = fullName ? `Hello ${fullName},` : 'Hello,'
  const escaped = String(message || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#0a1a2a;margin:0 0 16px;">${subject || 'A message from Finmax Services'}</h1>
    <p style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 16px;">${greeting}</p>
    <div style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 20px;">${escaped}</div>
    <p style="margin:24px 0;">
      <a href="${portalUrl}/dashboard" style="display:inline-block;background:#c4a55a;color:#0a1a2a;padding:12px 24px;text-decoration:none;font-weight:600;font-size:14px;">Sign in to your portal</a>
    </p>`
  return sendMail({
    to,
    subject: subject || 'A message from Finmax Services',
    html: WRAPPER(body),
    text: `${greeting}\n\n${message}\n\nSign in: ${portalUrl}/dashboard`,
  })
}

export function sendFilingProgressEmail({ to, fullName, progress }) {
  const copy = PROGRESS_COPY[progress]
  if (!copy) return
  const portalUrl = process.env.CLIENT_URL || 'http://localhost:3000'
  const greeting  = fullName ? `Hello ${fullName},` : 'Hello,'
  const body = `
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:600;color:#0a1a2a;margin:0 0 16px;">${copy.headline}</h1>
    <p style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 16px;">${greeting}</p>
    <p style="font-size:14px;line-height:1.6;color:#244d73;margin:0 0 20px;">${copy.blurb}</p>
    <p style="margin:24px 0;">
      <a href="${portalUrl}/dashboard" style="display:inline-block;background:#c4a55a;color:#0a1a2a;padding:12px 24px;text-decoration:none;font-weight:600;font-size:14px;">Sign in</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#7099ba;margin:24px 0 0;">
      Sign-in link: <span style="color:#244d73;">${portalUrl}/dashboard</span>
    </p>`
  return sendMail({
    to,
    subject: copy.subject,
    html: WRAPPER(body),
    text: `${greeting}\n\n${copy.blurb}\n\nSign in at ${portalUrl}/dashboard`,
  })
}
