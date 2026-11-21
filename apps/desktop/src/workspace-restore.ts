import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { inspectWorkspaceBackupFile, type BackupManifest } from '../../../packages/storage/src/index.js'

const JOURNAL = 'restore-journal.json'
const LEGACY_PREFIX = 'workspace.sqlite3.restore-previous-'
const TOKEN = /^[a-zA-Z0-9_-]{1,100}$/u
const SHA256 = /^[a-f0-9]{64}$/u
export type RestoreRecoveryAction = 'rollback' | 'retry'
export type RestorePhase = 'transaction-created' | 'old-snapshotted' | 'new-snapshotted' | 'prepared' | 'legacy-archived' | 'install-copied' | 'wal-removed' | 'shm-removed' | 'target-removed' | 'target-installed' | 'target-verified' | 'journal-removed'
type PhaseHook = (phase: RestorePhase) => void
interface Journal {
  version: 1
  workspace: string
  id: string
  oldSha256: string | null
  newSha256: string | null
  legacyName: string | null
  legacyUnverified?: boolean
}
export interface PendingWorkspaceRestore { kind: 'journal' | 'legacy' | 'preparing'; canRollback: boolean; canRetry: boolean; hasInvalidAnchor: boolean }

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
function directory(workspace: string): string { return join(resolve(workspace), '.writing-agent') }
function databasePath(workspace: string): string { return join(directory(workspace), 'workspace.sqlite3') }
function journalPath(workspace: string): string { return join(directory(workspace), JOURNAL) }
function transactionPath(workspace: string, id: string): string { return join(directory(workspace), `restore-recovery-${id}`) }
function snapshotPath(workspace: string, journal: Journal, side: 'old' | 'new'): string {
  return join(transactionPath(workspace, journal.id), `${side}.sqlite3`)
}
function regularFile(path: string): void {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('RESTORE_RECOVERY_INVALID')
}
function safeDirectory(path: string): void {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) fail('RESTORE_RECOVERY_INVALID')
}
function digest(path: string): string {
  regularFile(path)
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const fd = openSync(path, 'r')
  try {
    let bytes: number
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
function flush(path: string): void {
  const fd = openSync(path, 'r+')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function flushDirectory(path: string): void {
  // Node cannot fsync directory handles on Windows. Files are flushed there;
  // process-crash recovery is tested, physical power-loss durability is not claimed.
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function verify(path: string, expected: string): void {
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`)) fail('RESTORE_RECOVERY_INVALID')
  regularFile(path)
  const inspection = inspectWorkspaceBackupFile(path)
  if (!inspection.ok || !inspection.supported) fail('RESTORE_RECOVERY_INVALID')
  // Inspection must not have changed the snapshot (e.g. due to unexpected WAL).
  if (digest(path) !== expected || existsSync(`${path}-wal`)) fail('RESTORE_RECOVERY_INVALID')
}
function readJournal(workspace: string): Journal {
  safeDirectory(directory(workspace))
  const path = journalPath(workspace)
  regularFile(path)
  if (statSync(path).size > 8192) fail('RESTORE_RECOVERY_INVALID')
  let value: Journal
  try { value = JSON.parse(readFileSync(path, 'utf8')) as Journal } catch { return fail('RESTORE_RECOVERY_INVALID') }
  if (!value || value.version !== 1 || value.workspace !== resolve(workspace) || typeof value.id !== 'string' || !TOKEN.test(value.id)
    || !(value.oldSha256 === null || typeof value.oldSha256 === 'string' && SHA256.test(value.oldSha256))
    || !(value.newSha256 === null || typeof value.newSha256 === 'string' && SHA256.test(value.newSha256))
    || !(value.legacyUnverified === undefined || typeof value.legacyUnverified === 'boolean')
    || !(value.legacyName === null || typeof value.legacyName === 'string' && value.legacyName.startsWith(LEGACY_PREFIX)
      && TOKEN.test(value.legacyName.slice(LEGACY_PREFIX.length)))) fail('RESTORE_RECOVERY_INVALID')
  safeDirectory(transactionPath(workspace, value.id))
  return value
}
function verifyAnchor(workspace: string, value: Journal, side: 'old' | 'new'): void {
  const sha256 = side === 'old' ? value.oldSha256 : value.newSha256
  if (sha256 === null) fail('RESTORE_RECOVERY_UNAVAILABLE')
  verify(snapshotPath(workspace, value, side), sha256)
}
function anchorAvailable(workspace: string, journal: Journal, side: 'old' | 'new'): boolean {
  try { verifyAnchor(workspace, journal, side); return true }
  catch { return false } // Availability is surfaced explicitly by the recovery dialog.
}
function legacyFiles(workspace: string): string[] {
  const root = directory(workspace)
  safeDirectory(root)
  return existsSync(root) ? readdirSync(root).filter(name => name.startsWith(LEGACY_PREFIX)
    && !name.endsWith('-wal') && !name.endsWith('-shm')) : []
}
function unfinishedTransactions(workspace: string): string[] {
  const root = directory(workspace)
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => name.startsWith('restore-recovery-')).filter(name => {
    const transaction = join(root, name)
    safeDirectory(transaction)
    const receipt = join(transaction, 'completed.json')
    if (!existsSync(receipt)) return true
    regularFile(receipt)
    if (statSync(receipt).size > 8192) fail('RESTORE_RECOVERY_INVALID')
    let completed: { version?: unknown; sha256?: unknown }
    try { completed = JSON.parse(readFileSync(receipt, 'utf8')) as typeof completed }
    catch { return fail('RESTORE_RECOVERY_INVALID') }
    // A damaged receipt may belong to a completed restore's only safety copy.
    // It must never be mistaken for disposable, unpublished preparation.
    if (!completed || completed.version !== 1 || typeof completed.sha256 !== 'string' || !SHA256.test(completed.sha256)) fail('RESTORE_RECOVERY_INVALID')
    return false
  }).map(name => join(root, name))
}
/** Must run before any ordinary storage opener; missing live DB is not evidence of a fresh workspace. */
export function inspectPendingWorkspaceRestore(workspace: string): PendingWorkspaceRestore | null {
  safeDirectory(directory(workspace))
  if (existsSync(journalPath(workspace))) {
    const journal = readJournal(workspace)
    const canRollback = anchorAvailable(workspace, journal, 'old')
    const canRetry = anchorAvailable(workspace, journal, 'new')
    return { kind: journal.legacyName === null ? 'journal' : 'legacy', canRollback, canRetry,
      hasInvalidAnchor: journal.legacyUnverified === true || journal.oldSha256 !== null && !canRollback || journal.newSha256 !== null && !canRetry }
  }
  const legacy = legacyFiles(workspace)
  if (legacy.length === 0) {
    if (unfinishedTransactions(workspace).length === 0) return null
    const live = existsSync(databasePath(workspace)) ? inspectWorkspaceBackupFile(databasePath(workspace)) : null
    return { kind: 'preparing', canRollback: live?.ok === true && live.supported, canRetry: false, hasInvalidAnchor: false }
  }
  const live = existsSync(databasePath(workspace)) ? inspectWorkspaceBackupFile(databasePath(workspace)) : null
  return { kind: 'legacy', canRollback: legacy.length === 1,
    canRetry: legacy.length === 1 && live?.ok === true && live.supported, hasInvalidAnchor: false }
}
export function assertNoPendingWorkspaceRestore(workspace: string): void {
  // Ordinary openers only check markers. Hashing potentially multi-GB recovery
  // images belongs to explicit recovery inspection and installation.
  safeDirectory(directory(workspace))
  if (existsSync(journalPath(workspace)) || legacyFiles(workspace).length > 0 || unfinishedTransactions(workspace).length > 0) fail('RESTORE_RECOVERY_REQUIRED')
}
function publishJournal(workspace: string, journal: Journal): void {
  const path = journalPath(workspace)
  if (existsSync(path)) fail('RESTORE_RECOVERY_REQUIRED')
  const temporary = join(transactionPath(workspace, journal.id), 'journal.ready')
  writeFileSync(temporary, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
  flush(temporary)
  renameSync(temporary, path)
  flush(path)
  flushDirectory(directory(workspace))
}
async function snapshot(source: string, path: string): Promise<BackupManifest> {
  const inspection = inspectWorkspaceBackupFile(source)
  if (!inspection.ok) throw Object.assign(new Error(inspection.code), { code: inspection.code })
  if (!inspection.supported) fail('SCHEMA_UNSUPPORTED')
  if (existsSync(path)) fail('RESTORE_RECOVERY_INVALID')
  const reader = new DatabaseSync(source, { readOnly: true, timeout: 5000 })
  try { await backup(reader, path) } finally { reader.close() }
  // Standalone recovery images must never depend on WAL sidecars.
  const database = new DatabaseSync(path)
  try { database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;') } finally { database.close() }
  flush(path)
  flushDirectory(dirname(path))
  const sha256 = digest(path)
  verify(path, sha256)
  return { path, sha256, sizeBytes: statSync(path).size, schemaVersion: inspection.schemaVersion, createdAt: new Date().toISOString() }
}
function newTransaction(workspace: string, id: string): string {
  if (!TOKEN.test(id)) fail('RESTORE_RECOVERY_INVALID')
  const path = transactionPath(workspace, id)
  mkdirSync(path) // Never reuse or overwrite an existing recovery anchor.
  flushDirectory(directory(workspace))
  return path
}

function cleanupInstalledSnapshot(workspace: string, journal: Journal, side: 'old' | 'new'): void {
  const path = snapshotPath(workspace, journal, side)
  // Remove only verified, explicitly owned staging files. Keep the other anchor
  // as a safety backup (especially a newer live database displaced by legacy rollback).
  try {
    verifyAnchor(workspace, journal, side)
    rmSync(path)
    const legacyTemporary = join(transactionPath(workspace, journal.id), 'legacy-source.sqlite3')
    for (const suffix of ['', '-wal', '-shm']) {
      const temporary = `${legacyTemporary}${suffix}`
      if (existsSync(temporary)) { regularFile(temporary); rmSync(temporary) }
    }
    flushDirectory(transactionPath(workspace, journal.id))
  } catch (cause) { throw Object.assign(new Error('RESTORE_CLEANUP_FAILED', { cause }), { code: 'RESTORE_CLEANUP_FAILED' }) }
}

function cleanupUnpublishedTransaction(transaction: string): void {
  // Only these files can have been created by preparation; never recursively
  // remove a directory or follow an unexpected link introduced by another actor.
  const owned = new Set(['old.sqlite3', 'new.sqlite3', 'journal.ready', 'legacy-source.sqlite3', 'legacy-current.sqlite3']
    .flatMap(name => ['', '-wal', '-shm', '-journal'].map(suffix => `${name}${suffix}`)))
  const files = readdirSync(transaction)
  // Check the complete directory before deleting anything. A receipt or unknown
  // file makes this an uncertain recovery site, even if some names look familiar.
  for (const file of files) {
    if (!owned.has(file)) fail('RESTORE_RECOVERY_INVALID')
    regularFile(join(transaction, file))
  }
  for (const file of files) rmSync(join(transaction, file))
  rmdirSync(transaction)
  flushDirectory(dirname(transaction))
}

function archiveUnpublishedTransactions(workspace: string): void {
  const root = directory(workspace)
  // This operates only before a journal exists, while the original live/legacy
  // files still exist. Preserve the entire uncertain directory, including files
  // from older versions that the current implementation cannot classify.
  const transactions = unfinishedTransactions(workspace)
  for (const transaction of transactions) {
    if (dirname(resolve(transaction)) !== resolve(root) || !basename(transaction).startsWith('restore-recovery-')) fail('RESTORE_RECOVERY_INVALID')
    safeDirectory(transaction)
    const archive = join(root, `restore-evidence-${randomUUID()}`)
    if (existsSync(archive)) fail('RESTORE_RECOVERY_INVALID')
    renameSync(transaction, archive)
    flushDirectory(root)
  }
}

/** Replayable: neither recovery anchor is consumed. The journal is removed only after verification. */
function install(workspace: string, journal: Journal, action: RestoreRecoveryAction, onPhase?: PhaseHook): BackupManifest {
  const sha256 = action === 'rollback' ? journal.oldSha256 : journal.newSha256
  if (sha256 === null) fail('RESTORE_RECOVERY_UNAVAILABLE')
  const source = snapshotPath(workspace, journal, action === 'rollback' ? 'old' : 'new')
  verifyAnchor(workspace, journal, action === 'rollback' ? 'old' : 'new')
  const transaction = transactionPath(workspace, journal.id)
  // Legacy evidence is archived only once the verified rollback image and journal exist.
  if (journal.legacyName !== null) {
    for (const suffix of ['', '-wal', '-shm']) {
      const parked = join(directory(workspace), `${journal.legacyName}${suffix}`)
      if (existsSync(parked)) {
        regularFile(parked)
        const archive = join(transaction, `legacy-original${suffix}`)
        if (existsSync(archive)) fail('RESTORE_RECOVERY_INVALID')
        renameSync(parked, archive)
      }
    }
    onPhase?.('legacy-archived')
  }
  const temporary = join(transaction, 'install.sqlite3')
  if (existsSync(temporary)) { regularFile(temporary); rmSync(temporary) }
  copyFileSync(source, temporary)
  flush(temporary)
  verify(temporary, sha256)
  onPhase?.('install-copied')
  const target = databasePath(workspace)
  // Both the main DB and its sidecars may be half-swapped after a process kill.
  // Keep the journal through every deletion so startup cannot create an empty DB.
  for (const [suffix, phase] of [['-wal', 'wal-removed'], ['-shm', 'shm-removed'], ['', 'target-removed']] as const) {
    const path = `${target}${suffix}`
    if (existsSync(path)) { regularFile(path); rmSync(path) }
    onPhase?.(phase)
  }
  renameSync(temporary, target)
  flush(target)
  flushDirectory(directory(workspace))
  onPhase?.('target-installed')
  verify(target, sha256)
  onPhase?.('target-verified')
  const receipt = join(transaction, 'completed.ready')
  if (existsSync(receipt)) regularFile(receipt)
  if (existsSync(join(transaction, 'completed.json'))) regularFile(join(transaction, 'completed.json'))
  writeFileSync(receipt, JSON.stringify({ version: 1, sha256 }), { mode: 0o600 })
  flush(receipt)
  renameSync(receipt, join(transaction, 'completed.json'))
  flushDirectory(transaction)
  // A completed receipt distinguishes retained backups from interrupted preparation.
  rmSync(journalPath(workspace))
  flushDirectory(directory(workspace))
  onPhase?.('journal-removed')
  cleanupInstalledSnapshot(workspace, journal, action === 'rollback' ? 'old' : 'new')
  const inspection = inspectWorkspaceBackupFile(target)
  if (!inspection.ok) fail('RESTORE_RECOVERY_INVALID')
  return { path: target, sha256, sizeBytes: statSync(target).size, schemaVersion: inspection.schemaVersion, createdAt: new Date().toISOString() }
}

export async function recoverPendingWorkspaceRestore(input: {
  workspacePath: string; action: RestoreRecoveryAction; onPhase?: PhaseHook
}): Promise<BackupManifest & { warningCode?: string }> {
  const workspace = resolve(input.workspacePath)
  if (!existsSync(journalPath(workspace))) {
    const legacy = legacyFiles(workspace)
    if (legacy.length === 0) {
      if (input.action !== 'rollback' || unfinishedTransactions(workspace).length === 0) fail('RESTORE_RECOVERY_UNAVAILABLE')
      const live = inspectWorkspaceBackupFile(databasePath(workspace))
      if (!live.ok || !live.supported) fail('RESTORE_RECOVERY_INVALID')
      archiveUnpublishedTransactions(workspace)
      return { path: databasePath(workspace), sha256: digest(databasePath(workspace)), sizeBytes: statSync(databasePath(workspace)).size,
        schemaVersion: live.schemaVersion, createdAt: new Date().toISOString() }
    }
    if (legacy.length !== 1) fail('RESTORE_RECOVERY_UNAVAILABLE')
    const name = legacy[0]!
    if (!TOKEN.test(name.slice(LEGACY_PREFIX.length))) fail('RESTORE_RECOVERY_INVALID')
    const parked = join(directory(workspace), name)
    regularFile(parked)
    // Unpublished legacy attempts never changed either original database.
    archiveUnpublishedTransactions(workspace)
    const id = randomUUID()
    const transaction = newTransaction(workspace, id)
    // Old versions renamed only the main file. A crash before sidecar removal can
    // leave the original committed WAL at the live basename. Read a private copy
    // of that complete set; never mutate the only legacy evidence during inspection.
    const legacySource = join(transaction, 'legacy-source.sqlite3')
    copyFileSync(parked, legacySource)
    flush(legacySource)
    const parkedWal = `${parked}-wal`
    const liveWal = `${databasePath(workspace)}-wal`
    if (existsSync(parkedWal) && !existsSync(databasePath(workspace)) && existsSync(liveWal)) fail('RESTORE_RECOVERY_INVALID')
    const wal = existsSync(parkedWal) ? parkedWal : !existsSync(databasePath(workspace)) && existsSync(liveWal) ? liveWal : null
    if (wal !== null) { regularFile(wal); copyFileSync(wal, `${legacySource}-wal`); flush(`${legacySource}-wal`) }
    // If a newer live workspace exists, preserve its committed WAL as well before
    // offering rollback. The retry action explicitly means keep this current data.
    let live: BackupManifest | null = null
    let legacyUnverified = false
    if (existsSync(databasePath(workspace))) {
      try { live = await snapshot(databasePath(workspace), join(transaction, 'new.sqlite3')) }
      catch (error) {
        if (input.action === 'retry') throw error
        // A damaged current DB must not disable a verified old rollback, but its
        // original bytes (including committed WAL) must be retained for diagnosis.
        for (const suffix of ['', '-wal', '-shm']) {
          const current = `${databasePath(workspace)}${suffix}`
          if (!existsSync(current)) continue
          regularFile(current)
          const saved = join(transaction, `legacy-current.sqlite3${suffix}`)
          copyFileSync(current, saved)
          flush(saved)
          if (digest(saved) !== digest(current)) fail('RESTORE_RECOVERY_INVALID')
        }
        legacyUnverified = true
      }
    }
    let old: BackupManifest | null = null
    try { old = await snapshot(legacySource, join(transaction, 'old.sqlite3')) }
    catch (error) { if (input.action === 'rollback' || live === null) throw error; legacyUnverified = true }
    if (input.action === 'retry' && live === null) fail('RESTORE_RECOVERY_UNAVAILABLE')
    publishJournal(workspace, { version: 1, workspace, id, oldSha256: old?.sha256 ?? null, newSha256: live?.sha256 ?? null, legacyName: name, legacyUnverified })
    input.onPhase?.('prepared')
  }
  const journal = readJournal(workspace)
  const result = install(workspace, journal, input.action, input.onPhase)
  return journal.legacyName !== null && (journal.oldSha256 === null || journal.legacyUnverified)
    ? { ...result, warningCode: 'RESTORE_LEGACY_ANCHOR_UNVERIFIED' } : result
}

export async function replaceWorkspaceDatabaseFromBackup(input: {
  readonly workspacePath: string; readonly backupPath: string; readonly idFactory?: () => string; readonly onPhase?: PhaseHook
  /** Runs with the preparation marker already present, before reading or replacing the live database. */
  readonly prepareLiveDatabase?: () => Promise<void>
}): Promise<BackupManifest> {
  const workspace = resolve(input.workspacePath)
  assertNoPendingWorkspaceRestore(workspace)
  const target = databasePath(workspace)
  const source = resolve(input.backupPath)
  if (!existsSync(target)) fail('RESTORE_TARGET_MISSING')
  if (source === target) fail('RESTORE_SOURCE_IS_TARGET')
  regularFile(target)
  const id = (input.idFactory ?? randomUUID)()
  const transaction = newTransaction(workspace, id)
  input.onPhase?.('transaction-created')
  let journal: Journal
  try {
    const inspection = inspectWorkspaceBackupFile(source)
    if (!inspection.ok) throw Object.assign(new Error(inspection.message), { code: inspection.code })
    if (!inspection.supported) fail('SCHEMA_UNSUPPORTED')
    regularFile(source)
    await input.prepareLiveDatabase?.()
    const old = await snapshot(target, join(transaction, 'old.sqlite3'))
    input.onPhase?.('old-snapshotted')
    const replacement = await snapshot(source, join(transaction, 'new.sqlite3'))
    journal = { version: 1, workspace, id, oldSha256: old.sha256, newSha256: replacement.sha256, legacyName: null }
    publishJournal(workspace, journal)
    input.onPhase?.('new-snapshotted')
  } catch (error) {
    if (!existsSync(journalPath(workspace))) {
      try { cleanupUnpublishedTransaction(transaction) }
      catch (cause) { throw Object.assign(new Error('RESTORE_PREPARATION_CLEANUP_FAILED', { cause }), { code: 'RESTORE_PREPARATION_CLEANUP_FAILED' }) }
    }
    throw error
  }
  input.onPhase?.('prepared')
  // On failure leave evidence and the startup gate intact, never silently roll back.
  return install(workspace, journal, 'retry', input.onPhase)
}
