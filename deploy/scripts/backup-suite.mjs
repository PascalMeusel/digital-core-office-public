import { createSuiteBackup, parseArguments, isDirectExecution } from './suite-backup-lib.mjs'

export { createSuiteBackup } from './suite-backup-lib.mjs'

if (isDirectExecution(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    console.log(JSON.stringify(await createSuiteBackup({
      dataRoot: options['data-root'] || '/data', outputDirectory: options.output || options['backup-dir'],
      modules: options.modules ?? process.env.DCO_ENABLED_MODULES,
      keyFile: options['key-file'] || process.env.DCO_BACKUP_KEY_FILE,
      configFile: options['config-file'], retainDays: options['retain-days'],
    })))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
