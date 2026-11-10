import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(import.meta.dirname, '..')
const allowedRootFiles = new Set(['README.md', 'LICENSE.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.dockerignore'])
const allowedDirectories = new Set(['core-service', 'time-tracking-system', 'inventory-management-system', 'agile-project-management-prototype', 'packages', 'android-app', 'deploy', 'docs', 'legal', 'scripts', '.github'])
// Operational records may contain employee attendance or customer information.
// New documentation is private until explicitly reviewed for distribution.
const publicDocs = new Set(['calendar-sharing.md', 'dashboard-design.md', 'day-resolution.md', 'day-review.md', 'overtime-policy.md', 'request-approval.md', 'digital-core-office-three-system-plan.md', 'zeitguru-evaluation.md'])
const excluded = [
  /(^|\/)(?:node_modules|dist|build|coverage|playwright-report|test-results|\.runtime|\.gradle|\.git|\.idea|\.vite|\.codex-attachments|artifacts|output|tmp|secrets)(\/|$)/,
  /(^|\/)\.env(?!\.example$|\.[^/]+\.example$)(?:\..*)?$/, /(?:^|\/)local\.properties$/,
  /^deploy\/(?:private-licenses|private-review|review-data|backups)\//,
  /^deploy\/migration\/(?!README\.md$)/,
  /^deploy\/licenses\/(?!README\.md$|license-public\.pem$)/,
  /^deploy\/scripts\/(?:.*play-review.*|create-review-credentials|seed-review-environment|set-suite-admin)\.mjs$/,
  /^android-app\/store-listing\/(?:play-review-instructions|play-console-decisions|release-artifact-provenance|release-checklist)\.md$/,
  /^android-app\/store-listing\/assets\/(?:reviewer-|screenshots\/)/,
  /^inventory-management-system\/docs\//,
  /^inventory-management-system\/public\/inventory-media\//,
  /^inventory-management-system\/server\/reference\/inventorySource\.json$/,
  /^inventory-management-system\/scripts\/prepare_inventory_assets\.py$/,
  /(?:^|\/)server\/(?:data|backups)\//,
  /\.(?:sqlite(?:-.*)?|db|tgz|tar|gz|zip|7z|aab|apk|jks|keystore|p12|pfx|log)$/i,
  /(?:^|\/).*private.*\.(?:pem|key)$/i,
]
const suspiciousContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
]
const binaryExtensions = /\.(?:png|jpg|jpeg|webp|ico|woff2?|ttf|jar)$/i

export function isPublicPath(path) {
  const normalized = path.replaceAll('\\', '/')
  const first = normalized.split('/')[0]
  if (!allowedRootFiles.has(normalized) && !allowedDirectories.has(first)) return false
  if (first === 'docs' && !publicDocs.has(normalized.slice(5))) return false
  return !excluded.some((pattern) => pattern.test(normalized))
}

export function preparePublicRelease(root, requestedTarget, initializeGit = false) {
  root = realpathSync(root)
  const target = resolve(requestedTarget)
  const relation = relative(root, target)
  if (target === root || (!relation.startsWith(`..${sep}`) && relation !== '..')) throw new Error('The public-release target must be outside this working repository.')
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || readdirSync(target).length) throw new Error('Use a new empty target directory without symlinks.')
  }
  let parent = dirname(target)
  while (!existsSync(parent)) parent = dirname(parent)
  const physicalParent = realpathSync(parent)
  if (physicalParent === root || physicalParent.startsWith(`${root}${sep}`)) throw new Error('The target parent must be outside this working repository.')
  if (!existsSync(resolve(root, '.gitignore')) || !readFileSync(resolve(root, '.gitignore'), 'utf8').trim()) throw new Error('A repository .gitignore is required.')

  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
  const files = []
  const problems = []
  for (const path of paths.filter(isPublicPath)) {
    const source = resolve(root, path)
    if (!existsSync(source)) continue
    const info = lstatSync(source)
    if (info.isSymbolicLink() || !realpathSync(source).startsWith(`${root}${sep}`)) { problems.push(`${path}: symlinks and external paths are not release inputs`); continue }
    if (!info.isFile()) continue
    if (info.size > 10 * 1024 * 1024) { problems.push(`${path}: exceeds 10 MiB`); continue }
    const content = readFileSync(source)
    if (!binaryExtensions.test(path)) {
      if (content.includes(0)) { problems.push(`${path}: unexpected binary content`); continue }
      if (suspiciousContent.some((pattern) => pattern.test(content.toString('utf8')))) { problems.push(`${path}: resembles embedded secret material`); continue }
    } else if (path.endsWith('.jar') && path !== 'android-app/gradle/wrapper/gradle-wrapper.jar') {
      problems.push(`${path}: unapproved binary archive`); continue
    }
    files.push(path)
  }
  if (problems.length) throw new Error(`Public-release safety checks failed:\n${problems.map((item) => `- ${item}`).join('\n')}`)
  mkdirSync(target, { recursive: true })
  for (const path of files) {
    const destination = resolve(target, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(resolve(root, path), destination)
  }
  if (initializeGit) {
    execFileSync('git', ['init'], { cwd: target, stdio: 'inherit' })
    execFileSync('git', ['add', '--all'], { cwd: target, stdio: 'inherit' })
  }
  return { copied: files.length, target }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/preparePublicRelease.mjs <empty-target-directory> [--init-git]')
    const result = preparePublicRelease(sourceRoot, process.argv[2], process.argv.includes('--init-git'))
    console.log(`Prepared ${result.copied} public files in ${result.target}.`)
    console.log('Review the exported files and complete the recorded legal and store release requirements before publication.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
