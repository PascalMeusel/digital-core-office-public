import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'

const dataFile = '.runtime/browser-smoke.sqlite'

for (const path of [dataFile, `${dataFile}-shm`, `${dataFile}-wal`]) {
  rmSync(path, { force: true })
}

const env = {
  ...process.env,
  TIME_TRACKER_DATA: dataFile,
  TIME_TRACKER_BACKUP_DIR: '.runtime/browser-smoke-backups',
  INITIAL_ADMIN_NAME: 'Browser Smoke Admin',
  INITIAL_ADMIN_EMAIL: 'browser-smoke@example.com',
  INITIAL_ADMIN_PASSWORD: 'UseAUnique!Temporary2026',
  INITIAL_ADMIN_MUST_CHANGE_PASSWORD: 'false',
}

const isWindows = process.platform === 'win32'
const command = isWindows ? 'cmd.exe' : 'npm'
const args = isWindows ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev']
const child = spawn(command, args, {
  env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
