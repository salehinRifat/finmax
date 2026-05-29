import { pool, query } from './db.js'
import { encryptSensitive, isEncrypted } from './crypto.js'

// Idempotent schema bumps applied at boot so existing databases pick up
// new columns/tables without a manual phpMyAdmin step.
export async function applyMigrations() {
  await addProfileColumn('two_factor_enabled', 'TINYINT(1) NOT NULL DEFAULT 0')
  const addedFirst  = await addProfileColumn('first_name',  'VARCHAR(120) DEFAULT NULL')
  const addedMiddle = await addProfileColumn('middle_name', 'VARCHAR(120) DEFAULT NULL')
  const addedLast   = await addProfileColumn('last_name',   'VARCHAR(120) DEFAULT NULL')
  if (addedFirst || addedMiddle || addedLast) await backfillNameSplit()
  await addProfileColumn('country',        "VARCHAR(80) DEFAULT NULL")
  await addProfileColumn('alt_email',      'VARCHAR(255) DEFAULT NULL')
  await addProfileColumn('payment_status', "VARCHAR(10) NOT NULL DEFAULT 'due'")
  await ensureAuthCodesTable()
  await ensureProfileFilesTable()
  await expandSinColumn()
  await encryptPlaintextSins()
}

// Encrypted SIN payloads are ~52 base64 chars after the iv+tag overhead.
// Bump the column to 200 so we have headroom for future encrypted formats.
async function expandSinColumn() {
  const cols = await query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiles' AND COLUMN_NAME = 'sin_number'`
  )
  const len = cols[0]?.len ?? 0
  if (len >= 200) return
  await pool.execute(`ALTER TABLE profiles MODIFY sin_number VARCHAR(200) DEFAULT NULL`)
}

// One-time backfill: any SIN that was stored as plaintext (pre-encryption
// deployment) gets encrypted in place. Idempotent — only touches rows whose
// current value isn't already an encrypted payload.
async function encryptPlaintextSins() {
  const rows = await query(
    `SELECT id, sin_number FROM profiles
     WHERE sin_number IS NOT NULL AND sin_number <> ''`
  )
  for (const r of rows) {
    if (isEncrypted(r.sin_number)) continue
    const enc = encryptSensitive(r.sin_number)
    await pool.execute(`UPDATE profiles SET sin_number = ? WHERE id = ?`, [enc, r.id])
  }
}

async function addProfileColumn(name, ddl) {
  const cols = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiles' AND COLUMN_NAME = ?`,
    [name]
  )
  if (cols.length) return false
  await pool.execute(`ALTER TABLE profiles ADD COLUMN ${name} ${ddl}`)
  return true
}

// Best-effort split of existing full_name into first/middle/last so accounts
// created before the split still have usable values. Only runs once, right
// after the new columns are added, and only against rows where the targets
// are still NULL (so manual edits aren't overwritten).
async function backfillNameSplit() {
  const rows = await query(
    `SELECT id, full_name FROM profiles
     WHERE full_name IS NOT NULL AND TRIM(full_name) <> ''
       AND first_name IS NULL AND last_name IS NULL`
  )
  for (const r of rows) {
    const parts = String(r.full_name).trim().split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    let first = '', middle = '', last = ''
    if (parts.length === 1)      { first = parts[0] }
    else if (parts.length === 2) { first = parts[0]; last = parts[1] }
    else                          { first = parts[0]; last = parts[parts.length - 1]; middle = parts.slice(1, -1).join(' ') }
    await pool.execute(
      `UPDATE profiles SET first_name = ?, middle_name = ?, last_name = ? WHERE id = ?`,
      [first || null, middle || null, last || null, r.id]
    )
  }
}

async function ensureProfileFilesTable() {
  // Attachments uploaded from the client's profile form (Uberist/Doordash
  // forms, etc.). Separate from `documents` because they aren't tied to a
  // checklist item and don't go through the approve/reject workflow.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS profile_files (
      id          CHAR(36)     NOT NULL PRIMARY KEY,
      user_id     CHAR(36)     NOT NULL,
      purpose     VARCHAR(40)  NOT NULL,
      file_name   VARCHAR(255) NOT NULL,
      file_path   VARCHAR(500) NOT NULL,
      file_size   BIGINT       DEFAULT NULL,
      file_type   VARCHAR(100) DEFAULT NULL,
      uploaded_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_profile_files_user (user_id, purpose),
      CONSTRAINT fk_profile_files_user FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

async function ensureAuthCodesTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id            CHAR(36)     NOT NULL PRIMARY KEY,
      user_id       CHAR(36)     NOT NULL,
      purpose       VARCHAR(30)  NOT NULL,
      code_hash     VARCHAR(255) NOT NULL,
      attempts      INT          NOT NULL DEFAULT 0,
      expires_at    DATETIME     NOT NULL,
      consumed_at   DATETIME     DEFAULT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auth_codes_user (user_id, purpose),
      CONSTRAINT fk_auth_codes_user FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}
