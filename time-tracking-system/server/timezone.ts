import { setOrganizationTimezone } from '../shared/dates.ts'
// All server calendar arithmetic uses the organization's business timezone.
// Load this before store/holiday modules initialize, including in CLI commands.
const timezone = process.env.DCO_TIMEZONE?.trim() || process.env.TZ?.trim() || 'Europe/Berlin'
try {
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date())
} catch {
  throw new Error('DCO_TIMEZONE must be a valid IANA timezone, for example Europe/Berlin')
}
process.env.TZ = timezone
setOrganizationTimezone(timezone)
export const organizationTimezone = timezone
