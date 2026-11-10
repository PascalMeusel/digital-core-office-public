import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArguments, isDirectExecution } from './suite-backup-lib.mjs'

export function releaseRetentionPlan({ releases, current, keep = 5, protectedPaths = [] }) {
  if (!Number.isInteger(keep) || keep < 3) throw new Error('Retain at least three releases.')
  const root = realpathSync(releases)
  const active = realpathSync(current)
  if (resolve(active, '..') !== root) throw new Error('Current release is outside the release directory.')
  const candidates = readdirSync(root).filter(name => /^20\d{6}-company-r\d+(?:-[a-z0-9-]+)?$/.test(name))
    .map(name => {
      const path = join(root, name)
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('Invalid release directory.')
      return { path, number: Number(/-r(\d+)/.exec(name)[1]) }
    }).sort((a, b) => b.number - a.number)
  const preserved = new Set([active, ...candidates.slice(0, keep).map(item => item.path), ...protectedPaths.map(path => realpathSync(path))])
  return { root, current, active, preserved: candidates.filter(item => preserved.has(item.path)).map(item => item.path), obsolete: candidates.filter(item => !preserved.has(item.path)).map(item => item.path) }
}

export function archiveObsoleteReleases(plan, archiveDirectory) {
  const archiveRoot = resolve(archiveDirectory)
  if (archiveRoot === plan.root || archiveRoot.startsWith(plan.root + '/')) throw new Error('Archives must be outside releases.')
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 })
  if (realpathSync(archiveRoot) !== archiveRoot) throw new Error('Archive directory may not contain symlinks.')
  for (const path of plan.obsolete) {
    // Recheck every absolute target immediately before archiving and removal.
    if (resolve(path, '..') !== plan.root || realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) throw new Error('Unsafe release removal target.')
    if (path === realpathSync(plan.current)) throw new Error('A deployment changed the current release; run retention again.')
    if (process.platform === 'linux') for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      let cwd
      try { cwd = realpathSync(`/proc/${pid}/cwd`) } catch { continue }
      if (cwd === path || cwd.startsWith(path + '/')) throw new Error('A running process still uses this release; run retention again.')
    }
    const archive = join(archiveRoot, basename(path) + '.tar.gz')
    if (existsSync(archive)) throw new Error('Archive already exists; verify it before manually retrying.')
    const temporary = archive + '.tmp'
    execFileSync('tar', ['-czf', temporary, '--exclude=node_modules', '--exclude=dist', '--exclude=.git', '-C', plan.root, basename(path)])
    execFileSync('tar', ['-tzf', temporary], { stdio: 'ignore' })
    renameSync(temporary, archive)
    rmSync(path, { recursive: true })
  }
  return { archived: plan.obsolete.length, preserved: plan.preserved.length }
}

if (isDirectExecution(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  try {
    const protectedPaths = []
    // Old services may still be executing from their former release after a partial rollout.
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try { const cwd = realpathSync(`/proc/${pid}/cwd`); const match = /^(\/opt\/digital-core-office\/releases\/[^/]+)(?:\/|$)/.exec(cwd); if (match) protectedPaths.push(match[1]) } catch {}
    }
    const plan = releaseRetentionPlan({ releases: options.releases || '/opt/digital-core-office/releases', current: options.current || '/opt/digital-core-office/current', keep: Number(options.keep || 5), protectedPaths })
    console.log(JSON.stringify(plan))
    if (options.apply === 'true') console.log(JSON.stringify(archiveObsoleteReleases(plan, options.archives || '/var/backups/digital-core-office/releases')))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
