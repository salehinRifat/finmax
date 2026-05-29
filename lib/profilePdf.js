import PDFDocument from 'pdfkit'
import fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOGO_PATH = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'Logo.jpg')

// Finmax brand palette — kept in sync with frontend/tailwind.config.js.
const COLOR = {
  navy:    '#172029',
  navyMid: '#314453',
  navyDim: '#7D929F',
  teal:    '#1F9492',
  tealDk:  '#0E6663',
  line:    '#D5DEE4',
  bg:      '#F3F6F7',
}

function formatDate(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

function formatMoney(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  return `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

const MARITAL_LABEL = {
  single:     'Single',
  married:    'Married',
  divorced:   'Divorced',
  common_law: 'Common Law',
  widowed:    'Widowed',
}

const ORG_TYPE_LABEL = {
  sole_proprietorship: 'Sole Proprietorship',
  incorporation:       'Incorporation',
}

const EDUCATION_LABEL = {
  jsc:       'JSC',
  ssc:       'SSC',
  hsc:       'HSC / Intermediate',
  diploma:   'Diploma',
  bachelors: "Bachelor's / University",
  masters:   "Master's",
  phd:       'PhD',
  other:     'Other',
}

const SELF_EMPLOYED_PLATFORM_LABEL = {
  uberist:  'Uberist',
  doordash: 'Doordash',
  others:   'Others',
}

// ─── Helpers that draw onto the PDFKit doc ───────────────────────────────────

function header(doc, profile) {
  const pageWidth = doc.page.width

  // Navy band
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
    .font('Helvetica').fontSize(10).fillColor(COLOR.teal).text('CLIENT PROFILE', 110, 65)

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
      fg:    COLOR.tealDk,
      bg:    '#E5F1F1',  // soft teal tint that matches the new accent
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
    .fillColor(COLOR.teal).font('Helvetica-Bold').fontSize(9)
    .text(title.toUpperCase(), { characterSpacing: 1.2 })
  doc
    .moveTo(50, doc.y + 4).lineTo(doc.page.width - 50, doc.y + 4)
    .lineWidth(0.5).strokeColor(COLOR.line).stroke()
  doc.moveDown(0.6)
}

function row(doc, label, value) {
  if (value === null || value === undefined || value === '') return
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
    .text(String(value), valueX, startY, { width: valueWidth })

  doc.moveDown(0.4)
}

// Render a tidy card holding key/value rows — used for repeatable records
// like directors, rental properties, and work history entries.
function recordCard(doc, label, idx, title, kvs) {
  if (doc.y > doc.page.height - 120) doc.addPage()
  const startY = doc.y
  const boxX = 50, boxW = doc.page.width - 100
  const contentX = boxX + 12, contentW = boxW - 24

  // Filter out empty lines so we don't reserve height for them
  const lines = kvs.filter(([, v]) => v !== null && v !== undefined && v !== '')
  const boxH = 24 + lines.length * 14 + 4

  doc.save()
    .roundedRect(boxX, startY, boxW, boxH, 0).fill('#F8FAFC').strokeColor(COLOR.line).stroke()
    .restore()

  doc.fillColor(COLOR.teal).font('Helvetica-Bold').fontSize(8)
    .text(`${label.toUpperCase()} ${idx + 1}`, contentX, startY + 10, { continued: true, characterSpacing: 0.6 })
  doc.fillColor(COLOR.navy).font('Helvetica-Bold').fontSize(11)
    .text(`   ${title || '—'}`, { width: contentW, characterSpacing: 0 })

  let y = startY + 28
  for (const [k, v] of lines) {
    doc.fillColor(COLOR.navyDim).font('Helvetica-Bold').fontSize(8)
      .text(k.toUpperCase(), contentX, y, { continued: true, characterSpacing: 0.5 })
    doc.fillColor(COLOR.navy).font('Helvetica').fontSize(9)
      .text(`  ${v}`, { width: contentW, characterSpacing: 0 })
    y += 14
  }

  doc.y = startY + boxH + 8
}

function footer(doc) {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    // The footer y sits BELOW the doc's bottom margin, which PDFKit treats as
    // overflow and pushes the text onto a brand-new page. Temporarily drop
    // the bottom margin to 0 so the draw stays on the intended page, and
    // pass lineBreak:false so a long date can't wrap into a second line.
    const origBottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    const y = doc.page.height - 35
    doc
      .fillColor(COLOR.navyDim).font('Helvetica').fontSize(8)
      .text(
        `Finmax Services — Confidential. Page ${i + 1} of ${range.count}. Generated ${new Date().toLocaleDateString()}.`,
        50, y, { width: doc.page.width - 100, align: 'center', lineBreak: false }
      )
    doc.page.margins.bottom = origBottom
  }
}

// ─── Per-service renderers ────────────────────────────────────────────────────

function renderMaritalRows(doc, data) {
  const status = data?.marital_status
  if (!status) return
  const details = data?.marital_details || {}
  row(doc, 'Marital Status',       MARITAL_LABEL[status] || status)
  row(doc, 'Spouse / Partner',     details.spouse_name || details.partner_name)
  row(doc, 'Spouse DOB',           formatDate(details.spouse_dob))
  row(doc, 'Date of Marriage',     formatDate(details.marriage_date))
  row(doc, 'Date of Divorce',      formatDate(details.divorce_date))
  row(doc, 'Relationship Started', formatDate(details.relationship_date))
  row(doc, 'Spouse Passing',       formatDate(details.spouse_death_date))
}

function renderPersonalTax(doc, profile, data) {
  sectionTitle(doc, 'Tax Details')
  row(doc, 'SIN Number', profile.sin_number)

  renderMaritalRows(doc, data)

  const inc = data?.income || {}
  const enabled = ['salary', 'self_employed', 'rental', 'others'].filter(k => inc[k]?.selected)
  if (enabled.length > 0) {
    sectionTitle(doc, 'Source of Income')
    if (inc.salary?.selected) {
      row(doc, 'Salary income',        formatMoney(inc.salary.amount))
    }
    if (inc.self_employed?.selected) {
      const se = inc.self_employed
      row(doc, 'Self-employed platform',    SELF_EMPLOYED_PLATFORM_LABEL[se.platform] || se.platform)
      row(doc, 'Self-employed income',      formatMoney(se.amount))
      row(doc, 'Self-employed description', se.description)
      if (se.file?.file_name) {
        row(doc, 'Self-employed form',
          `${se.file.file_name} (uploaded ${formatDate(se.file.uploaded_at) || '—'}) — view in client portal`)
      }
    }
    if (inc.rental?.selected && Array.isArray(inc.rental.properties) && inc.rental.properties.length) {
      inc.rental.properties.forEach((p, i) => recordCard(doc, 'Rental', i, p.address, [
        ['Income',            formatMoney(p.income)],
        ['Mortgage Interest', p.mortgage_interest != null && p.mortgage_interest !== '' ? `${p.mortgage_interest}%` : null],
        ['Property Tax',      formatMoney(p.property_tax)],
        ['Management Fee',    formatMoney(p.mgmt_fee)],
        ['Insurance',         formatMoney(p.insurance)],
        ['Utilities',         formatMoney(p.utilities)],
      ]))
    }
    if (inc.others?.selected && Array.isArray(inc.others.items) && inc.others.items.length) {
      inc.others.items.forEach((it, i) => recordCard(doc, 'Other Income', i, it.name, [
        ['Income', formatMoney(it.amount)],
      ]))
    }
  }

  const expenses = Array.isArray(data?.expenses) ? data.expenses.filter(e => e.name || e.amount) : []
  if (expenses.length) {
    sectionTitle(doc, `Expenses (${expenses.length})`)
    expenses.forEach((e, i) => recordCard(doc, 'Expense', i, e.name, [
      ['Amount', formatMoney(e.amount)],
    ]))
  }
}

function renderDirectors(doc, data) {
  const list = Array.isArray(data?.directors) ? data.directors.filter(d => d.name || d.dob || d.address) : []
  if (!list.length) return
  sectionTitle(doc, `Directors / Owners (${list.length})`)
  list.forEach((d, i) => recordCard(doc, 'Director', i, d.name, [
    ['Date of Birth', formatDate(d.dob)],
    ['Address',       d.address],
  ]))
}

function renderBusinessTax(doc, _profile, data) {
  const hasDetails = data?.business_name || data?.cra_business_number || data?.date_of_incorporation || data?.industry || data?.business_address
  if (hasDetails) {
    sectionTitle(doc, 'Business Details')
    row(doc, 'Business Name',         data.business_name)
    row(doc, 'CRA Business Number',   data.cra_business_number)
    row(doc, 'Date of Incorporation', formatDate(data.date_of_incorporation))
    row(doc, 'Industry',              data.industry)
    row(doc, 'Business Address',      data.business_address)
  }
  renderDirectors(doc, data)
}

function renderBusinessReg(doc, profile, data) {
  if (data?.proposed_business_name || data?.business_address) {
    sectionTitle(doc, 'Business Details')
    row(doc, 'Proposed Business Name', data.proposed_business_name)
    row(doc, 'Business Address',       data.business_address)
  }
  if (data?.org_type) {
    sectionTitle(doc, 'Business Type')
    row(doc, 'Organisation Type', ORG_TYPE_LABEL[data.org_type] || data.org_type)
    if (data.org_type === 'sole_proprietorship') {
      row(doc, 'SIN Number', profile.sin_number)
    }
  }
  renderDirectors(doc, data)
}

function renderWorkPermit(doc, profile, data) {
  if (data?.date_of_entry || profile.sin_number) {
    sectionTitle(doc, 'Immigration Details')
    row(doc, 'Date of Entry in Canada', formatDate(data.date_of_entry))
    row(doc, 'SIN Number',              profile.sin_number)
  }
  if (data?.marital_status) {
    sectionTitle(doc, 'Marital Status')
    renderMaritalRows(doc, data)
  }
  const cur = data?.current_workplace || {}
  if (cur.name || cur.address || cur.from) {
    sectionTitle(doc, 'Current Workplace')
    row(doc, 'Workplace', cur.name)
    row(doc, 'Address',   cur.address)
    row(doc, 'From',      cur.from)
  }
  const history = Array.isArray(data?.work_history)
    ? data.work_history.filter(w => w.workplace || w.city || w.from || w.to)
    : []
  if (history.length) {
    sectionTitle(doc, `Work History (${history.length})`)
    history.forEach((w, i) => recordCard(doc, 'Role', i, w.workplace, [
      ['City',  w.city],
      ['Dates', (w.from || w.to) ? `${w.from || '?'} – ${w.to || 'present'}` : null],
    ]))
  }
  const edu = data?.education || {}
  if (edu.highest_level || edu.institution_name || edu.graduation) {
    sectionTitle(doc, 'Education')
    row(doc, 'Highest Level',  EDUCATION_LABEL[edu.highest_level] || edu.highest_level)
    row(doc, 'Institution',    edu.institution_name)
    row(doc, 'Graduation',     edu.graduation)
  }
}

const SERVICE_RENDERERS = {
  personal_tax: renderPersonalTax,
  business_tax: renderBusinessTax,
  business_reg: renderBusinessReg,
  work_permit:  renderWorkPermit,
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

  // Basic info — universal fields the client filled in the Personal
  // Information section of their profile form
  sectionTitle(doc, 'Personal Information')
  row(doc, 'First Name',       profile.first_name)
  row(doc, 'Middle Name',      profile.middle_name)
  row(doc, 'Last Name',        profile.last_name)
  row(doc, 'Date of Birth',    formatDate(profile.date_of_birth))
  row(doc, 'Phone',            profile.phone)
  row(doc, 'Email',            profile.email)
  row(doc, 'Alternate Email',  profile.alt_email)
  const addr = [
    profile.address,
    profile.city,
    profile.state && profile.zip_code ? `${profile.state} ${profile.zip_code}` : (profile.state || profile.zip_code),
    profile.country,
  ].filter(Boolean).join(', ')
  if (addr) row(doc, 'Address', addr)
  row(doc, 'Filing Status',   profile.filing_status
    ? profile.filing_status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null)
  row(doc, 'Service Type',    SERVICE_LABEL[profile.service_type] || profile.service_type)
  row(doc, 'Filing Progress', FILING_LABEL[profile.filing_progress] || profile.filing_progress)
  row(doc, 'Member Since',    formatDate(profile.created_at))

  // Built-in service blocks render their own structured sections; both
  // built-in and custom forms can then also have admin-defined extra fields
  // dumped underneath. For built-ins we skip seeded fields (those back the
  // hardcoded blocks above) so the same value isn't printed twice.
  const render = SERVICE_RENDERERS[profile.service_type]
  if (render) {
    render(doc, profile, serviceData)
  }

  if (form && Array.isArray(form.fields) && form.fields.length > 0) {
    const isBuiltinForm = !!form.is_builtin
    const filledFields = form.fields.filter(f =>
      (!isBuiltinForm || !f.is_builtin) &&
      serviceData[f.field_key] !== undefined &&
      serviceData[f.field_key] !== null &&
      serviceData[f.field_key] !== ''
    )
    if (filledFields.length > 0) {
      sectionTitle(doc, isBuiltinForm ? 'Additional Questions' : `${form.label} Details`)
      for (const f of filledFields) {
        row(doc, f.field_label, formatValue(f, serviceData[f.field_key]))
      }
    }
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
