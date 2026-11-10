import { randomBytes } from 'node:crypto'
import { CoreAuthError, type CoreIdentity } from '../../packages/core-client/index.ts'
import { addAudit, makeStoredUser, readDatabase, writeDatabase } from './store.ts'

export function provisionCoreUser(identity: CoreIdentity) {
  const database = readDatabase()
  let user = database.users.find((candidate) => candidate.coreUserId === identity.id)
  if (!user) {
    const legacy = database.users.find((candidate) => candidate.email.toLowerCase() === identity.email.toLowerCase())
    if (legacy?.coreUserId && legacy.coreUserId !== identity.id) throw new CoreAuthError(409, 'This email belongs to a different linked account. Contact an administrator.')
    user = legacy
  }
  const role = identity.moduleRole === 'admin' ? 'admin' : 'employee'
  const created = !user
  if (!user) {
    user = makeStoredUser(identity.name, identity.email, role, randomBytes(48).toString('hex'))
    database.users.push(user)
  }
  const changed = created || user.coreUserId !== identity.id || user.name !== identity.name || user.email !== identity.email.toLowerCase() || user.role !== role || user.active !== identity.active || user.mustChangePassword !== identity.mustChangePassword
  Object.assign(user, { coreUserId: identity.id, name: identity.name, email: identity.email.toLowerCase(), role, active: identity.active, mustChangePassword: identity.mustChangePassword })
  if (changed) {
    addAudit(database, user.id, created ? 'core_profile_created' : 'core_profile_synchronized', 'user', user.id)
    writeDatabase(database)
  }
  return user
}
