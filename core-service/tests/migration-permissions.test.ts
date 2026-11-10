import assert from 'node:assert/strict'
import { pbkdf2Sync, scryptSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { authenticate, closeConnection, connection, createSession, importInventoryUsers, importTimeUsers, listUsers, saveUser } from '../server/core.ts'

test('migration preserves source roles once, without expanding suite authority or reviving managed accounts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dco-migration-permissions-'))
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`))
  const inventoryPath = join(directory, 'inventory.sqlite')
  const inventory = new DatabaseSync(inventoryPath)
  inventory.exec(`CREATE TABLE inventory_users(id TEXT PRIMARY KEY,name TEXT,email TEXT,role TEXT,active INTEGER,mustChangePassword INTEGER);
    CREATE TABLE inventory_user_credentials(userId TEXT PRIMARY KEY,passwordHash TEXT,passwordSalt TEXT,passwordAlgorithm TEXT);`)
  const timePath = join(directory, 'time.json')
  const password = 'Existing-time-password-2026!'
  const salt = 'time-test-salt'
  const passwordHash = pbkdf2Sync(password, salt, 310_000, 32, 'sha256').toString('hex')
  const timeUser = (id: string, role = 'employee') => ({id,name:id,email:`${id}@example.com`,role,active:true,mustChangePassword:false,passwordSalt:salt,passwordHash})
  const users = [timeUser('owner', 'admin'),timeUser('buyer'),timeUser('late'),timeUser('inactive')]
  writeFileSync(timePath, JSON.stringify({version:1,source:'time-tracking-system',users}))
  process.env.DCO_CORE_DATA = join(directory, 'core.sqlite')
  closeConnection()
  try {
    importTimeUsers(timePath)
    assert.deepEqual(listUsers().find(user=>user.id==='buyer')?.memberships, [{moduleId:'time',role:'employee',active:true}])
    inventory.prepare('INSERT INTO inventory_users VALUES(?,?,?,?,?,0)').run('module-buyer','Buyer','buyer@example.com','buyer',1)
    inventory.prepare('INSERT INTO inventory_users VALUES(?,?,?,?,?,0)').run('module-inactive','Inactive','inactive@example.com','receiver',0)
    assert.equal(importInventoryUsers(inventoryPath).membershipsImported,2)
    const memberships = (id: string) => listUsers().find(user=>user.id===id)!.memberships
    assert.equal(memberships('buyer').find(m=>m.moduleId==='inventory')?.role,'buyer')
    assert.equal(memberships('inactive').find(m=>m.moduleId==='inventory')?.active,false)
    assert.equal(listUsers().find(user=>user.id==='inactive')?.active,true)
    inventory.prepare("UPDATE inventory_users SET role='admin',active=1").run()
    assert.equal(importInventoryUsers(inventoryPath).membershipsImported,0)
    importTimeUsers(timePath)
    assert.equal(memberships('buyer').find(m=>m.moduleId==='inventory')?.role,'buyer')
    assert.equal(memberships('inactive').find(m=>m.moduleId==='inventory')?.active,false)
    assert.equal(authenticate('buyer@example.com',password)?.role,'employee')
    createSession('late')
    inventory.prepare('INSERT INTO inventory_users VALUES(?,?,?,?,?,0)').run('module-late','Late','late@example.com','admin',1)
    importInventoryUsers(inventoryPath)
    assert.equal(memberships('late').some(m=>m.moduleId==='inventory'),false)
    saveUser('owner',{active:false,memberships:[{moduleId:'time',role:'employee',active:false}]},'buyer')
    importInventoryUsers(inventoryPath);importTimeUsers(timePath)
    assert.equal(listUsers().find(user=>user.id==='buyer')?.active,false)
    assert.equal(memberships('buyer').some(m=>m.moduleId==='inventory'),false)
    inventory.prepare('INSERT INTO inventory_users VALUES(?,?,?,?,?,0)').run('module-admin','Module Admin','module-admin@example.com','admin',1)
    const inventorySalt = 'inventory-test-salt'
    const inventoryHash = scryptSync(password,inventorySalt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString('base64url')
    inventory.prepare('INSERT INTO inventory_user_credentials VALUES(?,?,?,?)').run('module-admin',inventoryHash,inventorySalt,'inventory-scrypt-v1')
    // Reusing another module's local ID must never grant permissions to that identity.
    inventory.prepare('INSERT INTO inventory_users VALUES(?,?,?,?,?,0)').run('owner','Wrong Identity','different@example.com','admin',1)
    const imported = importInventoryUsers(inventoryPath)
    assert.equal(imported.inserted,1);assert.equal(imported.skipped,1)
    assert.equal(authenticate('module-admin@example.com',password)?.role,'employee')
    assert.deepEqual(memberships('module-admin'),[{moduleId:'inventory',role:'admin',active:true}])
    assert.equal(memberships('owner').some(m=>m.moduleId==='inventory'),false)
    assert.equal((connection().prepare('SELECT managed FROM core_users WHERE id=?').get('late') as {managed:number}).managed,1)
  } finally {
    inventory.close();closeConnection();delete process.env.DCO_CORE_DATA
    rmSync(directory,{recursive:true,force:true})
  }
})
