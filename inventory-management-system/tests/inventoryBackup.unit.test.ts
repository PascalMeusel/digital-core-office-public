import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

test('legacy encrypted Inventory backups round-trip nested attachments and reject in-place force restores', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dco-inventory-backup-test-'))
  const moduleDirectory = fileURLToPath(new URL('../', import.meta.url))
  const sourceDirectory = join(temporary, 'source')
  const databasePath = join(sourceDirectory, 'inventory.sqlite')
  const media = join(sourceDirectory, 'media', 'delivery-notes')
  mkdirSync(media, { recursive: true })
  const attachment = Buffer.from('%PDF-1.7\nLegacy delivery note\n%%EOF')
  writeFileSync(join(media, 'receipt.pdf'), attachment)
  const keyFile = join(temporary, 'backup.key')
  writeFileSync(keyFile, randomBytes(32).toString('base64'))
  const source = new DatabaseSync(databasePath)
  source.exec('PRAGMA journal_mode=WAL; CREATE TABLE receipts(id TEXT); INSERT INTO receipts VALUES (\'received-in-wal\');')
  const command = (arguments_: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/inventoryBackup.ts', ...arguments_, '--key-file', keyFile], { cwd: moduleDirectory, encoding: 'utf8' })
  try {
    const backup = JSON.parse(command(['--backup', '--database', databasePath, '--output-dir', join(temporary, 'backups')])) as { backup: string }
    const restoredDatabase = join(temporary, 'restored', 'inventory.sqlite')
    command(['--restore', '--input', backup.backup, '--database', restoredDatabase])
    assert.deepEqual(readFileSync(join(temporary, 'restored', 'media', 'delivery-notes', 'receipt.pdf')), attachment)
    const restored = new DatabaseSync(restoredDatabase, { readOnly: true })
    try { assert.equal((restored.prepare('SELECT id FROM receipts').get() as { id: string }).id, 'received-in-wal') } finally { restored.close() }
    const force = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/inventoryBackup.ts', '--restore', '--input', backup.backup, '--database', databasePath, '--force', '--key-file', keyFile], { cwd: moduleDirectory, encoding: 'utf8' })
    assert.notEqual(force.status, 0)
    assert.match(force.stderr, /In-place --force restore is not supported/)
    assert.equal((source.prepare('SELECT id FROM receipts').get() as { id: string }).id, 'received-in-wal')
  } finally {
    source.close()
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    rmSync(temporary, { recursive: true, force: true })
  }
})
