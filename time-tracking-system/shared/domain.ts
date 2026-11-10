import type { ZeitguruStatus } from './zeitguru.ts'
import type { ZeitguruAccountingContexts } from './timeAccounting.ts'

export type Role = 'admin' | 'employee'

export type ClockAction = 'start_work' | 'start_break' | 'stop_break' | 'stop_work'
export type ClockStatus = 'off_work' | 'working' | 'on_break'
export type WorkLocation = 'office' | 'homeoffice' | 'remote' | 'customer' | 'business_trip'
export type RequestType =
  | 'vacation'
  | 'overtime_payout'
  | 'overtime_time_off'
  | 'time_correction'
  | 'sick_leave'
  | 'child_sick_leave'
  | 'custom'
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'undone'
export type AbsenceType = 'vacation' | 'overtime_time_off' | 'sick_leave' | 'child_sick_leave'
export type HolidaySource = 'template' | 'custom'
export type HolidayOverrideType = 'custom' | 'disabled'
export type LicensePlan = 'paid' | 'free_grant'
export type LicenseStatus = 'community' | 'licensed' | 'over_limit' | 'invalid' | 'expired' | 'missing_public_key'

export interface EmploymentTerm {
  id: string
  effectiveFrom: string
  expectedWeeklyMinutes: number
  yearlyVacationDays: number
  createdAt: string
}

export interface User {
  id: string
  name: string
  email: string
  role: Role
  expectedWeeklyMinutes: number
  yearlyVacationDays: number
  balanceAdjustmentMinutes: number
  vacationAdjustmentDays: number
  trackingStartDate: string
  employmentTerms: EmploymentTerm[]
  calendarAccessUserIds: string[]
  responsibleAdminUserId?: string
  active: boolean
  mustChangePassword: boolean
}

export interface UserInvitation {
  id: string
  userId: string
  email: string
  role: Role
  createdBy: string
  createdAt: string
  expiresAt: string
  acceptedAt?: string
}

export interface CalendarGroup {
  id: string
  name: string
  memberUserIds: string[]
  createdAt: string
}

export type CalDavSyncStatus = 'never' | 'success' | 'error'

export interface CalDavAccount {
  id: string
  userId: string
  name: string
  serverUrl: string
  username: string
  calendarUrl?: string
  calendarName?: string
  shareEventTitles: boolean
  syncEnabled: boolean
  passwordConfigured: boolean
  lastSyncAt?: string
  lastSyncStatus: CalDavSyncStatus
  lastSyncError?: string
  createdAt: string
  updatedAt: string
}

export interface ExternalCalendarEvent {
  id: string
  userId: string
  accountId: string
  externalId: string
  title: string
  startAt: string
  endAt: string
  isAllDay: boolean
  busy: boolean
  createdAt: string
  updatedAt: string
}

export interface CustomCalendarEvent {
  id: string
  userId: string
  title: string
  description?: string
  date: string
  startTime?: string
  endTime?: string
  isAllDay: boolean
  shareWithCalendarUsers: boolean
  createdAt: string
  updatedAt: string
}

export interface BreakSegment {
  id: string
  startedAt: string
  stoppedAt?: string
}

export interface TimeEntry {
  id: string
  userId: string
  date: string
  startedAt: string
  stoppedAt?: string
  breaks: BreakSegment[]
  manualBreakMinutes?: number
  workLocation?: WorkLocation
  source: 'clock' | 'approved_correction' | 'imported_csv' | 'zeitguru'
  /** Read-only projection of preserved history; never used as the native clock. */
  zeitguru?: { workedMinutes: number; creditedMinutes: number | null; approved: boolean | null; readOnly: true; batchId: string }
  note?: string
  requestId?: string
  importBatchId?: string
  createdAt: string
  updatedAt: string
}

export type DayIssueRule =
  | 'missing_day'
  | 'unclosed_entry'
  | 'invalid_entry'
  | 'overlapping_entries'
  | 'automatic_zero_hour_close'
  | 'schedule_variance'
  | 'insufficient_break'
  | 'daily_eight_hour_warning'
  | 'daily_ten_hour_limit'
  | 'insufficient_rest'
  | 'sunday_or_holiday_work'
  | 'compensation_period'
  | 'zeitguru_history_review'
  | 'zeitguru_local_correction'
  | 'zeitguru_import_reconstruction'

export type DayIssueSeverity = 'error' | 'warning' | 'info'
export type DayIssueCategory = 'data' | 'policy' | 'compliance'

export interface DayIssueSuggestion {
  action: 'time_correction' | 'absence_request' | 'admin_review' | 'zeitguru_history'
  labelEn: string
  labelDe: string
  draft?: Partial<{
    type: RequestType
    correctionDate: string
    proposedStartTime: string
    proposedEndTime: string
    proposedBreakMinutes: string
    startDate: string
    endDate: string
    reason: string
    reviewProposal: boolean
  }>
}

export interface DayIssue {
  initialImportReview?: boolean
  /** Consecutive missing dates grouped for one range request in the review UI. */
  relatedDates?: string[]
  source?: 'zeitguru'
  id: string
  userId: string
  date: string
  rule: DayIssueRule
  severity: DayIssueSeverity
  category: DayIssueCategory
  titleEn: string
  titleDe: string
  messageEn: string
  messageDe: string
  actualMinutes?: number
  expectedMinutes?: number
  suggestions: DayIssueSuggestion[]
}

export interface AbsenceDay {
  id: string
  userId: string
  date: string
  type: AbsenceType
  requestId?: string
  label: string
  createdAt: string
}

export interface RequestItem {
  id: string
  userId: string
  type: RequestType
  status: RequestStatus
  startDate?: string
  endDate?: string
  minutes?: number
  /** Approved deductions are recorded per business date and reversed by undo. */
  balanceEffects?: Array<{ date: string; minutes: number }>
  correctionDate?: string
  proposedStartTime?: string
  proposedEndTime?: string
  proposedBreakMinutes?: number
  customTitle?: string
  doctorNoteName?: string
  doctorNoteDataUrl?: string
  reason: string
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  adminNote?: string
  undoneAt?: string
  undoneBy?: string
}

export interface Holiday {
  id: string
  date: string
  name: string
  source: HolidaySource
  freePercent: number
}

export interface HolidayOverride {
  id: string
  date: string
  name: string
  type: HolidayOverrideType
  freePercent: number
  createdBy: string
  createdAt: string
}

export interface HolidaySettings {
  country: string
  state?: string
  region?: string
  language: string
  updatedAt?: string
  updatedBy?: string
}

export interface HolidayTemplateOption {
  code: string
  name: string
}

export interface HolidayTemplateOptions {
  countries: HolidayTemplateOption[]
  states: HolidayTemplateOption[]
  regions: HolidayTemplateOption[]
}

export interface MailServerSettings {
  host: string
  port: number
  secure: boolean
  user: string
  fromAddress: string
  passwordConfigured: boolean
  updatedAt: string
  updatedBy: string
}

export interface LicenseDetails {
  licenseId: string
  holderName: string
  contactEmail: string
  plan: LicensePlan
  activeUserLimit: number
  issuedAt: string
  validUntil?: string
  notes?: string
  updatedAt?: string
  updatedBy?: string
}

export interface LicenseState {
  status: LicenseStatus
  valid: boolean
  canAddUsers: boolean
  licenseConfigured: boolean
  activeUsers: number
  freeUserLimit: number
  effectiveUserLimit: number
  message: string
  details?: LicenseDetails
}

export interface NotificationItem {
  id: string
  userId: string
  title: string
  message: string
  read: boolean
  createdAt: string
  linkType?: 'request' | 'calendar' | 'time'
  linkId?: string
}

export interface ImportBatch {
  id: string
  userId: string
  importedBy: string
  fileName: string
  importedRows: number
  skippedRows: number
  errors: string[]
  createdAt: string
}

export interface BackupInfo {
  dataFile: string
  backupDir: string
  lastWeeklyBackup?: string
  nextAutomaticCheck: string
}

export interface PeriodTotals {
  workedMinutes: number
  expectedMinutes: number
  plusMinusMinutes: number
}

export interface VacationBalance {
  yearlyDays: number
  usedDays: number
  remainingDays: number
}

export interface UserSummary {
  balanceReviewRequired?: boolean
  userId: string
  week: PeriodTotals
  month: PeriodTotals
  year: PeriodTotals
  vacation: VacationBalance
}

export interface StatePayload {
  /** Server UTC time when this state was generated; used to synchronize live displays. */
  serverTime?: string
  overtimePolicy?: import('./overtimePolicy.ts').OvertimePolicyState
  zeitguru?: ZeitguruStatus
  zeitguruAccounting?: ZeitguruAccountingContexts
  coreManaged?: boolean
  readOnly?: boolean
  organizationTimezone?: string
  currentUser: User
  users: User[]
  visibleCalendarUsers: User[]
  shareableCalendarUsers: User[]
  calendarGroups: CalendarGroup[]
  calDavAccounts: CalDavAccount[]
  externalCalendarEvents: ExternalCalendarEvent[]
  customCalendarEvents: CustomCalendarEvent[]
  timeEntries: TimeEntry[]
  adminTimeEntries?: TimeEntry[]
  absences: AbsenceDay[]
  holidays: Holiday[]
  holidayOverrides: HolidayOverride[]
  holidaySettings: HolidaySettings
  holidayTemplateOptions: HolidayTemplateOptions
  requests: RequestItem[]
  notifications: NotificationItem[]
  importBatches: ImportBatch[]
  userInvitations: UserInvitation[]
  backup: BackupInfo
  mailServerSettings?: MailServerSettings
  licenseState?: LicenseState
  summaries: UserSummary[]
  clockStatus: ClockStatus
  clockStatuses: Record<string, ClockStatus>
  clockLocations: Record<string, WorkLocation | undefined>
  todayEntry?: TimeEntry
  dayIssues: DayIssue[]
}

export interface LoginResponse {
  token: string
}
