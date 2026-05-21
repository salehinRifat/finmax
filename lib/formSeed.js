import { v4 as uuid } from 'uuid'
import { pool, queryOne } from './db.js'

// Built-in service definitions and their fields. These are seeded once; admins
// can later edit them via /admin/forms (mark them not built-in to allow delete).
const BUILTIN_FORMS = [
  {
    form_key:    'personal_tax',
    label:       'Personal Tax',
    description: 'Filed by individuals',
    order_index: 1,
    fields: [
      { field_key: 'marital_status',     field_label: 'Marital Status',  field_type: 'select', required: 0,
        field_options: { options: [
          { value: 'single',   label: 'Single' },
          { value: 'married',  label: 'Married' },
          { value: 'divorced', label: 'Divorced' },
          { value: 'widowed',  label: 'Widowed' },
        ] } },
      { field_key: 'source_of_income',   field_label: 'Source of Income', field_type: 'select', required: 0,
        field_options: { options: [
          { value: 'salary',        label: 'Salary' },
          { value: 'self_employed', label: 'Self-Employed' },
        ] } },
      { field_key: 'spouse_name',        field_label: 'Spouse Name',         field_type: 'text', required: 0 },
      { field_key: 'spouse_dob',         field_label: 'Spouse Date of Birth', field_type: 'date', required: 0 },
      { field_key: 'date_of_marriage',   field_label: 'Date of Marriage',    field_type: 'date', required: 0 },
      { field_key: 'date_of_divorce',    field_label: 'Date of Divorce',     field_type: 'date', required: 0 },
    ],
  },
  {
    form_key:    'business_tax',
    label:       'Business Tax',
    description: 'Corporate / T2 filing',
    order_index: 2,
    fields: [
      { field_key: 'business_name',         field_label: 'Business Name',         field_type: 'text', required: 1 },
      { field_key: 'cra_business_number',   field_label: 'CRA Business Number',   field_type: 'text', required: 1 },
      { field_key: 'date_of_incorporation', field_label: 'Date of Incorporation', field_type: 'date', required: 0 },
      { field_key: 'industry',              field_label: 'Industry',              field_type: 'text', required: 0 },
      { field_key: 'business_address',      field_label: 'Business Address',      field_type: 'text', required: 1 },
    ],
  },
  {
    form_key:    'business_reg',
    label:       'Business Registration',
    description: 'Start a new business',
    order_index: 3,
    fields: [
      { field_key: 'proposed_business_name', field_label: 'Proposed Business Name', field_type: 'text', required: 1 },
      { field_key: 'business_address',       field_label: 'Business Address',       field_type: 'text', required: 1 },
    ],
  },
  {
    form_key:    'work_permit',
    label:       'Work Permit',
    description: 'Immigration paperwork',
    order_index: 4,
    fields: [
      { field_key: 'marital_status',       field_label: 'Marital Status',         field_type: 'select', required: 0,
        field_options: { options: [
          { value: 'single',   label: 'Single' },
          { value: 'married',  label: 'Married' },
          { value: 'divorced', label: 'Divorced' },
          { value: 'widowed',  label: 'Widowed' },
        ] } },
      { field_key: 'date_of_entry_canada', field_label: 'Date of Entry in Canada', field_type: 'date', required: 0 },
      { field_key: 'spouse_name',          field_label: 'Spouse Name',             field_type: 'text', required: 0 },
      { field_key: 'spouse_dob',           field_label: 'Spouse Date of Birth',    field_type: 'date', required: 0 },
      { field_key: 'date_of_marriage',     field_label: 'Date of Marriage',        field_type: 'date', required: 0 },
    ],
  },
]

// Idempotent — safe to call on every backend boot. Only inserts missing rows.
export async function ensureBuiltinForms() {
  for (const form of BUILTIN_FORMS) {
    const existing = await queryOne(
      `SELECT id FROM form_definitions WHERE form_key = ?`,
      [form.form_key]
    )
    if (!existing) {
      await pool.execute(
        `INSERT INTO form_definitions (id, form_key, label, description, is_builtin, order_index) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), form.form_key, form.label, form.description, 1, form.order_index]
      )
    }
    for (let i = 0; i < form.fields.length; i++) {
      const f = form.fields[i]
      const fieldExists = await queryOne(
        `SELECT id FROM form_fields WHERE form_key = ? AND field_key = ?`,
        [form.form_key, f.field_key]
      )
      if (!fieldExists) {
        await pool.execute(
          `INSERT INTO form_fields (id, form_key, field_key, field_label, field_type, field_options, required, order_index, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuid(), form.form_key, f.field_key, f.field_label, f.field_type,
            f.field_options ? JSON.stringify(f.field_options) : null,
            f.required ? 1 : 0, i, 1,
          ]
        )
      }
    }
  }
}
