import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOGO_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'Logo.jpg')

// Finmax brand palette (matches the frontend)
const COLOR = {
  navy:    '#0a1a2a',
  navyMid: '#244d73',
  navyDim: '#7099ba',
  gold:    '#c4a55a',
  goldDk:  '#a08040',
  line:    '#d0dde8',
  bg:      '#F5F4F0',
}

function formatDate(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatValue(field, raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (field?.field_type === 'date') return formatDate(raw)
  if (field?.field_type === 'checkbox') return raw ? 'Yes' : 'No'
  if (field?.field_type === 'select') {
    const opt = field.field_options?.options?.find(o => o.value === raw)
    return opt ? opt.label : String(raw)
  }
  return String(raw)
}

const SERVICE_LABEL = {
  personal_tax: 'Personal Tax',
  business_tax: 'Business Tax',
  business_reg: 'Business Registration',
  work_permit:  'Work Permit',
}

const FILING_LABEL = {
  not_started:      'Not Started',
  waiting_for_docs: 'Waiting for Document',
  in_progress:      'In Progress',
  completed:        'Complete',
}

// ─── Helpers that draw onto the PDFKit doc ───────────────────────────────────

function header(doc, profile) {
  const pageWidth = doc.page.width
  const top = 50

  // Gold bar
  doc.save()
    .rect(0, 0, pageWidth, 110).fill(COLOR.navy)
    .restore()

  // Logo
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, 50, 30, { fit: [48, 48] })
    } catch { /* logo failed to embed — silently skip */ }
  }

  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold').fontSize(18).text('Finmax Services', 110, 40)
    .font('Helvetica').fontSize(10).fillColor(COLOR.gold).text('CLIENT PROFILE', 110, 65)

  // Client name + email — rendered on the white area below the navy bar
  const displayName = (profile.full_name && profile.full_name.trim()) || 'Unnamed Client'
  doc
    .fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(18)
    .text(displayName, 50, 130)
  doc
    .fillColor(COLOR.navyMid).font('Helvetica').fontSize(11)
    .text(profile.email || '', 50, 154)

  // Status badges row
  const badges = [
    {
      label: profile.is_approved ? 'Approved' : 'Pending Approval',
      fg:    profile.is_approved ? '#2D7D5A' : '#C47A3A',
      bg:    profile.is_approved ? '#E5F2EB' : '#F8ECE0',
    },
    {
      label: FILING_LABEL[profile.filing_progress] || profile.filing_progress || '—',
      fg:    COLOR.navyMid,
      bg:    '#EAF1F8',
    },
    {
      label: SERVICE_LABEL[profile.service_type] || profile.service_type || '—',
      fg:    COLOR.goldDk,
      bg:    '#F7EFDC',
    },
  ]

  let x = 50
  const badgeY = 175
  for (const b of badges) {
    const w = doc.widthOfString(b.label) + 18
    doc.save()
      .roundedRect(x, badgeY, w, 18, 0).fill(b.bg)
      .restore()
    doc
      .fillColor(b.fg).font('Helvetica-Bold').fontSize(9)
      .text(b.label, x + 9, badgeY + 5)
    x += w + 6
  }

  doc.y = 215
}

function sectionTitle(doc, title) {
  if (doc.y > doc.page.height - 120) doc.addPage()
  doc.moveDown(0.5)
  doc
    .fillColor(COLOR.gold).font('Helvetica-Bold').fontSize(9)
    .text(title.toUpperCase(), { characterSpacing: 1.2 })
  doc
    .moveTo(50, doc.y + 4).lineTo(doc.page.width - 50, doc.y + 4)
    .lineWidth(0.5).strokeColor(COLOR.line).stroke()
  doc.moveDown(0.6)
}

function row(doc, label, value) {
  if (!value) return
  if (doc.y > doc.page.height - 80) doc.addPage()
  const labelX = 50
  const valueX = 200
  const labelWidth = 140
  const valueWidth = doc.page.width - valueX - 50
  const startY = doc.y

  doc
    .fillColor(COLOR.navyDim).font('Helvetica-Bold').fontSize(8)
    .text(label.toUpperCase(), labelX, startY, { width: labelWidth, characterSpacing: 0.5 })

  doc
    .fillColor(COLOR.navy).font('Helvetica').fontSize(10)
    .text(value, valueX, startY, { width: valueWidth })

  doc.moveDown(0.4)
}

function ownerCard(doc, idx, owner) {
  if (doc.y > doc.page.height - 120) doc.addPage()
  const startY = doc.y
  const boxX = 50, boxW = doc.page.width - 100
  const contentX = boxX + 12, contentW = boxW - 24

  let lines = 1 // header
  if (owner.sin)     lines += 1
  if (owner.dob)     lines += 1
  if (owner.address) lines += 1
  const boxH = 18 + lines * 14

  doc.save()
    .roundedRect(boxX, startY, boxW, boxH, 0).fill('#F8FAFC').strokeColor(COLOR.line).stroke()
    .restore()

  doc.fillColor(COLOR.gold).font('Helvetica-Bold').fontSize(8)
    .text(`OWNER ${idx + 1}`, contentX, startY + 10, { continued: true, characterSpacing: 0.6 })
  doc.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(11)
    .text(`   ${owner.name || '—'}`, { width: contentW, characterSpacing: 0 })

  let y = startY + 28
  if (owner.sin)     { labeledLine(doc, 'SIN',     owner.sin,             contentX, y, contentW); y += 14 }
  if (owner.dob)     { labeledLine(doc, 'DOB',     formatDate(owner.dob), contentX, y, contentW); y += 14 }
  if (owner.address) { labeledLine(doc, 'Address', owner.address,         contentX, y, contentW) }

  doc.y = startY + boxH + 8
}

function labeledLine(doc, label, value, x, y, maxWidth) {
  if (!value) return 0
  doc.fillColor(COLOR.navyDim).font('Helvetica-Bold').fontSize(8)
    .text(`${label.toUpperCase()}`, x, y, { continued: true, characterSpacing: 0.5 })
  doc.fillColor(COLOR.navy).font('Helvetica').fontSize(9)
    .text(`  ${value}`, { width: maxWidth, characterSpacing: 0 })
  return 14
}

function workRow(doc, idx, w) {
  if (doc.y > doc.page.height - 120) doc.addPage()
  const startY = doc.y
  const boxX = 50, boxW = doc.page.width - 100
  const contentX = boxX + 12, contentW = boxW - 24

  // Decide height up-front based on which fields exist
  let lines = 1 // header always
  if (w.job_title)       lines += 1
  if (w.address)         lines += 1
  if (w.from || w.to)    lines += 1
  const boxH = 18 + lines * 14

  doc.save()
    .roundedRect(boxX, startY, boxW, boxH, 0).fill('#F8FAFC').strokeColor(COLOR.line).stroke()
    .restore()

  // Header: "Workplace 1" pill on the left, workplace name on the right
  doc.fillColor(COLOR.gold).font('Helvetica-Bold').fontSize(8)
    .text(`WORKPLACE ${idx + 1}`, contentX, startY + 10, { continued: true, characterSpacing: 0.6 })
  doc.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(11)
    .text(`   ${w.workplace || '—'}`, { width: contentW, characterSpacing: 0 })

  let y = startY + 28
  if (w.job_title) { labeledLine(doc, 'Job Title', w.job_title, contentX, y, contentW); y += 14 }
  if (w.address)   { labeledLine(doc, 'Address',   w.address,   contentX, y, contentW); y += 14 }
  if (w.from || w.to) {
    const range = `${w.from || '?'} - ${w.to || 'present'}`
    labeledLine(doc, 'Dates', range, contentX, y, contentW)
  }

  doc.y = startY + boxH + 8
}

function footer(doc) {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    const y = doc.page.height - 35
    doc
      .fillColor(COLOR.navyDim).font('Helvetica').fontSize(8)
      .text(
        `Finmax Services — Confidential. Page ${i + 1} of ${range.count}. Generated ${new Date().toLocaleDateString()}.`,
        50, y, { width: doc.page.width - 100, align: 'center' }
      )
  }
}

// ─── Public entry — streams a PDF to res ──────────────────────────────────────

export function generateProfilePdf({ profile, form }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })

  // Parse service_data
  let serviceData = {}
  if (profile.service_data) {
    try { serviceData = typeof profile.service_data === 'string' ? JSON.parse(profile.service_data) : profile.service_data }
    catch { serviceData = {} }
  }

  header(doc, profile)

  // Basic info
  sectionTitle(doc, 'Basic Information')
  row(doc, 'Full Name',        profile.full_name)
  row(doc, 'Email',            profile.email)
  row(doc, 'Phone',            profile.phone)
  row(doc, 'Date of Birth',    formatDate(profile.date_of_birth))
  row(doc, 'SIN Number',       profile.sin_number)
  row(doc, 'Filing Status',    profile.filing_status
    ? profile.filing_status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null)
  row(doc, 'Service Type',     SERVICE_LABEL[profile.service_type] || profile.service_type)
  row(doc, 'Filing Progress',  FILING_LABEL[profile.filing_progress] || profile.filing_progress)
  row(doc, 'Member Since',     formatDate(profile.created_at))
  const addr = [
    profile.address,
    profile.city,
    profile.state && profile.zip_code ? `${profile.state} ${profile.zip_code}` : (profile.state || profile.zip_code),
  ].filter(Boolean).join(', ')
  if (addr) row(doc, 'Address', addr)

  // Service-specific fields
  if (form && form.fields && form.fields.length > 0) {
    const filledFields = form.fields.filter(f =>
      serviceData[f.field_key] !== undefined && serviceData[f.field_key] !== null && serviceData[f.field_key] !== ''
    )
    if (filledFields.length > 0) {
      sectionTitle(doc, `${form.label} Details`)
      for (const f of filledFields) {
        row(doc, f.field_label, formatValue(f, serviceData[f.field_key]))
      }
    }
  }

  // Owners
  if (Array.isArray(serviceData.owners) && serviceData.owners.length > 0) {
    sectionTitle(doc, `Owners (${serviceData.owners.length})`)
    serviceData.owners.forEach((o, i) => ownerCard(doc, i, o))
  }

  // Work history
  if (Array.isArray(serviceData.work_history) && serviceData.work_history.length > 0) {
    sectionTitle(doc, `Work History (${serviceData.work_history.length})`)
    serviceData.work_history.forEach((w, i) => workRow(doc, i, w))
  }

  // Notes
  if (profile.notes) {
    sectionTitle(doc, 'Internal Notes')
    doc.fillColor(COLOR.navy).font('Helvetica').fontSize(10)
      .text(profile.notes, { width: doc.page.width - 100 })
  }

  footer(doc)
  doc.end()
  return doc
}
