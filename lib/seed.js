import { v4 as uuid } from 'uuid'
import { pool, query, queryOne } from './db.js'

// ─── Default categories per service type ──────────────────────────────────────

const DEFAULT_GENERAL_ITEMS = [
  { title: 'Government-issued ID',     required: 1, description: 'Driver\'s license, passport, or other photo ID' },
  { title: 'Previous year tax return', required: 0, description: null },
]

const SERVICE_CATEGORIES = [
  {
    serviceType: 'personal_tax',
    name:        'Personal Tax Documents',
    description: 'Tax slips required for personal income tax filing',
    orderIndex:  1,
    items: [
      { title: 'T4 — Statement of Remuneration Paid',         required: 1 },
      { title: 'T5 — Statement of Investment Income',         required: 0 },
      { title: 'T3 — Statement of Trust Income Allocations',  required: 0 },
      { title: 'T5008 — Statement of Securities Transactions',required: 0 },
      { title: 'T5007 — Statement of Benefits',               required: 0 },
      { title: 'T2202 — Tuition and Enrolment Certificate',   required: 0 },
    ],
  },
  {
    serviceType: 'business_tax',
    name:        'Business Tax Documents',
    description: 'Corporate filing materials',
    orderIndex:  2,
    items: [
      { title: 'Previous year T2 — Corporation Income Tax Return', required: 1 },
    ],
  },
  {
    serviceType: 'work_permit',
    name:        'Work Permit Documents',
    description: 'Documents required for work permit application',
    orderIndex:  3,
    items: [
      { title: 'Medical Form',                       required: 1 },
      { title: 'Passport',                           required: 1 },
      { title: 'Digital Photo (50 × 70 mm)',         required: 1 },
      { title: 'Previous Work Permit',               required: 0 },
    ],
  },
]

async function ensureCategory({ name, description, isGeneral, serviceType, orderIndex, items }) {
  // Idempotent: only create if a category with the same name doesn't exist.
  const existing = await queryOne(
    `SELECT id FROM checklist_categories WHERE name = ? LIMIT 1`,
    [name]
  )
  if (existing) return existing.id

  const id = uuid()
  await pool.execute(
    `INSERT INTO checklist_categories (id, name, description, is_general, service_type, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, description, isGeneral ? 1 : 0, serviceType, orderIndex]
  )
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    await pool.execute(
      `INSERT INTO category_items (id, category_id, title, description, required, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), id, it.title, it.description ?? null, it.required, i]
    )
  }
  return id
}

// Idempotent — safe to call on every backend boot.
export async function ensureGeneralCategory() {
  await ensureCategory({
    name:        'General',
    description: 'Required from every client',
    isGeneral:   true,
    serviceType: null,
    orderIndex:  0,
    items:       DEFAULT_GENERAL_ITEMS,
  })
  for (const cat of SERVICE_CATEGORIES) {
    await ensureCategory({
      name:        cat.name,
      description: cat.description,
      isGeneral:   false,
      serviceType: cat.serviceType,
      orderIndex:  cat.orderIndex,
      items:       cat.items,
    })
  }
  await relabelExistingChecklistItems()
}

// One-time migration: items copied from service-typed categories were
// previously labeled 'general'. Match each item by title against
// category_items and re-stamp the label.
async function relabelExistingChecklistItems() {
  const rows = await query(`
    SELECT ci.id, ci.title, ci.category, cc.is_general, cc.service_type, cc.name AS cat_name
    FROM checklist_items ci
    JOIN category_items cat ON LOWER(cat.title) = LOWER(ci.title)
    JOIN checklist_categories cc ON cc.id = cat.category_id
  `)
  let updated = 0
  for (const r of rows) {
    const newLabel = labelFor({ is_general: r.is_general, service_type: r.service_type, name: r.cat_name })
    if (newLabel && newLabel.toLowerCase() !== (r.category || '').toLowerCase()) {
      await pool.execute(`UPDATE checklist_items SET category = ? WHERE id = ?`, [newLabel, r.id])
      updated++
    }
  }
}

// ─── Copying category items into a user's personal checklist ──────────────────

// Friendly label used for the checklist_items.category column when copying
// from a source category. Falls back to the category's own name.
const SERVICE_LABEL = {
  personal_tax: 'Personal Tax',
  business_tax: 'Business Tax',
  business_reg: 'Business Registration',
  work_permit:  'Work Permit',
}

function labelFor(cat) {
  if (!cat) return 'General'
  if (cat.is_general) return 'General'
  if (cat.service_type && SERVICE_LABEL[cat.service_type]) return SERVICE_LABEL[cat.service_type]
  return cat.name
}

async function copyCategoryItemsToUser(categoryId, userId, createdBy) {
  if (!categoryId) return 0
  const parent = await queryOne(
    `SELECT name, is_general, service_type FROM checklist_categories WHERE id = ?`,
    [categoryId]
  )
  if (!parent) return 0

  const items = await query(
    `SELECT title, description, required, order_index FROM category_items WHERE category_id = ? ORDER BY order_index`,
    [categoryId]
  )
  if (!items.length) return 0

  const label = labelFor(parent)

  const existing = await query(
    `SELECT title FROM checklist_items WHERE user_id = ?`,
    [userId]
  )
  const existingTitles = new Set(existing.map(i => i.title.toLowerCase()))
  const baseIndex = existing.length

  let added = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (existingTitles.has(it.title.toLowerCase())) continue
    await pool.execute(
      `INSERT INTO checklist_items (id, user_id, title, description, category, required, order_index, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), userId, it.title, it.description, label, it.required, baseIndex + i, createdBy]
    )
    added++
    existingTitles.add(it.title.toLowerCase())
  }
  return added
}

// Copy the General category PLUS the category(ies) matching the user's
// service_type. Returns the total number of items added (after dedup).
export async function copyDefaultItemsToUser(userId, createdBy) {
  const profile = await queryOne(`SELECT service_type FROM profiles WHERE id = ?`, [userId])
  const serviceType = profile?.service_type || null

  // General category
  const general = await queryOne(
    `SELECT id FROM checklist_categories WHERE is_general = 1 LIMIT 1`
  )
  let total = await copyCategoryItemsToUser(general?.id, userId, createdBy)

  // Service-specific categories (may be multiple if admin added more)
  if (serviceType) {
    const serviceCats = await query(
      `SELECT id FROM checklist_categories WHERE service_type = ? AND (is_general = 0 OR is_general IS NULL)`,
      [serviceType]
    )
    for (const cat of serviceCats) {
      total += await copyCategoryItemsToUser(cat.id, userId, createdBy)
    }
  }
  return total
}

// Backwards-compat alias — older callers (apply-to-all manual sync) still use this.
export async function copyGeneralItemsToUser(userId, createdBy) {
  return copyDefaultItemsToUser(userId, createdBy)
}
