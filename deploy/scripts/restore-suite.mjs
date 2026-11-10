import { restoreSuiteBackup, parseArguments, isDirectExecution } from './suite-backup-lib.mjs'

export { restoreSuiteBackup } from './suite-backup-lib.mjs'

if (isDirectExecution(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    console.log(JSON.stringify(await restoreSuiteBackup({ bundle: options.bundle || options.input, target: options.target, keyFile: options['key-file'] || process.env.DCO_BACKUP_KEY_FILE })))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
