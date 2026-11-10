import { SuiteAdminLink, PasswordInput } from '@digital-core-office/suite-ui'
import {
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Database,
  Download,
  Eye,
  EyeOff,
  Languages,
  LayoutGrid,
  LogIn,
  LogOut,
  Mail,
  MapPin,
  Moon,
  Pencil,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Timer,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { isDefinitiveActionRejection, syncRetryDelay } from './syncRecovery'
import {
  SuiteLoadingScreen,
  SuiteShellHeader,
  readSuiteLanguage,
  readSuiteTheme,
  suiteLanguageStorageKey,
  suiteThemeStorageKey,
  writeSuiteLanguage,
  writeSuiteTheme,
  type SuiteNavItem,
  type SuiteProductDefinition,
  type SuiteProductTone,
} from '@digital-core-office/suite-ui'
import '@digital-core-office/suite-ui/styles.css'
import './App.css'
import { serverClock } from './serverClock.ts'
import { useDisclosureMotion } from './useDisclosureMotion.ts'
import { CustomCalendarEventModal } from './CalendarEventEditor.tsx'
import { CalendarDayItems, CalendarDayAgenda } from './CalendarDayItems.tsx'
import { CalendarKindIcon } from './CalendarKindIcon.tsx'
import { ZeitguruPanel } from './ZeitguruPanel.tsx'
import { ZeitguruAccountingOverview } from './ZeitguruHistoryPanel.tsx'
import { DayReviewPanel as DayIssuesPanel } from './DayReviewPanel.tsx'
import { CalendarSharingPanel } from './CalendarSharingPanel.tsx'

import { ApprovalQueue } from './ApprovalQueue.tsx'
import { OvertimePolicyPanel } from './OvertimePolicyPanel.tsx'
import type { ZeitguruApi, ZeitguruOperationSummary, ZeitguruStatus } from '../shared/zeitguru.ts'
import type { ZeitguruHistoryResult } from '../shared/zeitguruHistory.ts'
import { accountingDay, periodTotalsWithAccounting } from '../shared/timeAccounting.ts'
import type {
  CalendarGroup,
  ClockAction,
  ClockStatus,
  DayIssue,
  DayIssueSuggestion,
  AbsenceType,
  Holiday,
  HolidayOverrideType,
  HolidaySettings,
  HolidayTemplateOptions,
  LicensePlan,
  LicenseState,
  MailServerSettings,
  RequestItem,
  RequestType,
  Role,
  StatePayload,
  TimeEntry,
  User,
  UserInvitation,
  UserSummary,
  WorkLocation,
} from '../shared/domain.ts'
import {
  addDays,
  businessDateKey,
  businessTimeMinutes,
  isoFromDateAndTime,
  organizationTimezone,
  setOrganizationTimezone,
  clampDateRange,
  dateKeysBetween,
  endOfMonth,
  endOfWeek,
  endOfYear,
  formatDecimalHours,
  isSensibleDateKey,
  isWeekend,
  parseDateKey,
  pad2,
  sensibleDateBounds,
  startOfMonth,
  startOfWeek,
  startOfYear,
  toDateKey,
} from '../shared/dates.ts'
import { balanceDeductionsForRange } from '../shared/balances.ts'
import { currentEmploymentTerm, employmentTermsFor, termForDate } from '../shared/terms.ts'

const appBasePath = import.meta.env.BASE_URL
const androidApkHref = `${appBasePath}downloads/arbeitszeitbuero-android-arm64.apk`
const configuredApiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const apiBase =
  configuredApiBase || (import.meta.env.PROD ? appBasePath.replace(/\/$/, '') : 'http://localhost:4177')
const forcedSimpleMode = import.meta.env.VITE_SIMPLE_MODE === 'true'
const packagedMobileBuild = import.meta.env.VITE_MOBILE_APP === 'true'
const packagedMobileBackendMissing = packagedMobileBuild && !configuredApiBase
const authTokenStorageKey = 'time-tracker-token'
const inventorySystemUrl = (import.meta.env.VITE_INVENTORY_URL ?? 'http://localhost:4187').replace(/\/+$/, '')
const agileProjectManagementUrl = (import.meta.env.VITE_AGILE_URL ?? 'http://localhost:4197').replace(/\/+$/, '')
const configuredCoreOfficeUrl = (import.meta.env.VITE_CORE_URL ?? '').trim()
const coreOfficeUrl = configuredCoreOfficeUrl ? configuredCoreOfficeUrl.replace(/\/+$/, '') || '/' : ''
const coreCookieSession = 'core-cookie-session'
const browserCoreSession = Boolean(coreOfficeUrl) && !packagedMobileBuild
const enabledSuiteModules = new Set(
  String(import.meta.env.VITE_ENABLED_MODULES ?? 'time,inventory,agile').split(',').map((value) => value.trim()),
)
const isEmbeddedSuiteWorkspace = new URLSearchParams(window.location.search).get('embedded') === '1' && window.self !== window.top
function notifyCoreSessionInvalidated() {
  if (isEmbeddedSuiteWorkspace) window.parent.postMessage({ type: 'dco:session-invalidated' }, window.location.origin)
}
const requestDraftStoragePrefix = 'arbeitszeitbuero-request-draft:'
const requestDraftTypes: RequestType[] = [
  'vacation',
  'overtime_payout',
  'overtime_time_off',
  'time_correction',
  'sick_leave',
  'child_sick_leave',
  'custom',
]

type RequestFormDraft = {
  reviewProposal: boolean
  targetUserId: string
  targetUserName: string
  type: RequestType
  startDate: string
  endDate: string
  minutes: string
  customTitle: string
  correctionDate: string
  proposedStartTime: string
  proposedEndTime: string
  proposedBreakMinutes: string
  reason: string
}

function requestDraftStorageKey(userId: string) {
  return `${requestDraftStoragePrefix}${userId}`
}

function requestDraftString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function readRequestFormDraft(storageKey?: string): Partial<RequestFormDraft> | undefined {
  if (!storageKey || typeof window === 'undefined') {
    return undefined
  }

  try {
    const rawDraft = window.sessionStorage.getItem(storageKey)
    if (!rawDraft) {
      return undefined
    }

    const parsed = JSON.parse(rawDraft)
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }

    const record = parsed as Record<string, unknown>
    const draft: Partial<RequestFormDraft> = {
      reviewProposal: record.reviewProposal===true,
      targetUserId: requestDraftString(record.targetUserId),
      targetUserName: requestDraftString(record.targetUserName),
      startDate: requestDraftString(record.startDate),
      endDate: requestDraftString(record.endDate),
      minutes: requestDraftString(record.minutes),
      customTitle: requestDraftString(record.customTitle),
      correctionDate: requestDraftString(record.correctionDate),
      proposedStartTime: requestDraftString(record.proposedStartTime),
      proposedEndTime: requestDraftString(record.proposedEndTime),
      proposedBreakMinutes: requestDraftString(record.proposedBreakMinutes),
      reason: requestDraftString(record.reason),
    }

    if (requestDraftTypes.includes(record.type as RequestType)) {
      draft.type = record.type as RequestType
    }

    return draft
  } catch {
    return undefined
  }
}

function writeRequestFormDraft(storageKey: string, draft: Partial<RequestFormDraft>) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(draft))
  } catch {
    // Storage can be unavailable in private or restricted browser modes.
  }
}

function clearRequestFormDraft(storageKey?: string) {
  if (!storageKey || typeof window === 'undefined') {
    return
  }

  try {
    window.sessionStorage.removeItem(storageKey)
  } catch {
    // Storage can be unavailable in private or restricted browser modes.
  }
}

type Tab =
  | 'dashboard'
  | 'calendar'
  | 'requests'
  | 'adminCalendar'
  | 'adminUsers'
  | 'adminGroups'
  | 'adminFreeDays'
  | 'adminSettings'
type Language = 'en' | 'de'
type Theme = 'light' | 'dark'
type TimeExportPeriod = 'day' | 'week' | 'month' | 'year' | 'all'
type CalendarViewMode = 'day' | 'week' | 'month'
type WorkOverviewPeriod = 'day' | 'week' | 'month'
type DateFieldSelectionMode = CalendarViewMode | 'year'
type MutationResult = Promise<boolean>
type TimeCsvExportResult = { url: string; filename: string } | { error: string }
type TimeCsvExport = (userId: string, period: TimeExportPeriod, date: string, onResult?: (result: TimeCsvExportResult) => void) => MutationResult
type SelectOption = {
  value: string
  label: string
  disabled?: boolean
}

const allowedDoctorNoteTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const maxDoctorNoteBytes = 2 * 1024 * 1024

const translations = {
  en: {
    appName: 'Digital Core Office Time',
    dashboard: 'Dashboard',
    calendar: 'Calendar',
    requests: 'Requests',
    adminCalendarTab: 'Admin calendar',
    admin: 'Admin',
    users: 'Users',
    freeDays: 'Free Days',
    settings: 'Settings',
    signOut: 'Sign out',
    signIn: 'Sign in',
    switchToDarkMode: 'Switch to dark mode',
    switchToLightMode: 'Switch to light mode',
    switchSystems: 'Switch systems',
    inventorySystem: 'Inventory',
    agileProjectManagement: 'Agile',
    openInventorySystem: 'Open Inventory Management',
    openAgileProjectManagement: 'Open Agile Project Management',
    register: 'Register',
    createAccount: 'Create account',
    alreadyRegistered: 'Use existing account',
    name: 'Name',
    email: 'Email',
    password: 'Password',
    confirmPassword: 'Confirm password',
    showPassword: 'Show',
    hidePassword: 'Hide',
    stayLoggedIn: 'Stay logged in',
    forgotPasswordReset: 'Forgot your password? Reset it',
    resetPasswordTitle: 'Reset password',
    resetPasswordIntro: 'Enter the email address for your account. If it exists, you will receive a reset link.',
    resetPasswordEmailSent: 'If an active account exists for this email address, a reset link was sent.',
    sendResetLink: 'Send reset link',
    backToLogin: 'Back to login',
    setNewPassword: 'Set new password',
    resetLinkInvalid: 'This reset link is invalid, expired, or already used.',
    safePasswordHint: 'At least 12 characters with uppercase, lowercase, number, symbol, and no name/email words.',
    numericFieldsRequired: 'Please fill all numeric fields with valid numbers.',
    dateOutOfRange: 'Please choose a date between {min} and {max}.',
    weeklyHoursRequired: 'Weekly hours must be greater than 0.',
    invitationRequired: 'Registration requires an invitation from an admin.',
    completeInviteTitle: 'Complete invitation',
    invitationIntro: 'Set a safe password for the email address that was invited.',
    invitedEmailLocked: 'Invited email',
    inviteExpiresAt: 'Invite expires',
    createPassword: 'Create password',
    changePasswordTitle: 'Change password',
    forcedPasswordChangeIntro: 'Set a new safe password before continuing.',
    currentPassword: 'Current password',
    newPassword: 'New password',
    saveNewPassword: 'Save new password',
    savingChanges: 'Saving...',
    changesSaved: 'Saved',
    clockSaved: 'Saved in DCO',
    downloadAndroidApp: 'Download Android app',
    mobileBackendMissingTitle: 'Backend URL missing',
    mobileBackendMissingBody: 'This mobile build was created without a backend URL. Rebuild it with VITE_API_URL set to the HTTPS server.',
    backendSynced: 'Synced with backend',
    backendSyncing: 'Syncing with backend...',
    backendSyncLost: 'Backend sync lost. Clocking is disabled until the app reconnects.',
    reconnectNow: 'Reconnect now',
    sessionUnavailable: 'Connection unavailable',
    sessionCheckFailed: 'Your sign-in could not be checked. Check your connection and try again.',
    backendSyncStale: 'Backend state is stale. Clocking is disabled until the next sync.',
    lastBackendSync: 'Last sync',
    invalidInvite: 'This invitation is invalid, expired, or already used.',
    demoAdmin: 'Admin demo',
    demoEmployee: 'Employee demo',
    offWork: 'Off work',
    working: 'Working',
    onBreak: 'On break',
    startWork: 'Start Work',
    startBreak: 'Start Break',
    stopBreak: 'Stop Break',
    stopWork: 'Stop Work',
    confirmClockOutTitle: 'Stop work?',
    confirmClockOutBody: 'This will clock you out and close the current work entry.',
    clockRunning: 'Tracked work time',
    workedToday: 'Worked today',
    clockedInAt: 'Clocked in at',
    breakTaken: 'Break taken',
    workLocation: 'Work location',
    officeLocation: 'In office',
    homeofficeLocation: 'In homeoffice',
    remoteLocation: 'Remote',
    customerLocation: 'At customer site',
    businessTripLocation: 'Business trip',
    timeBalance: 'Overtime',
    legacyBalanceReview: 'Historical overtime approvals need reconciliation before payroll. Please contact an administrator.',
    workedTime: 'Worked time',
    workTimePeriod: 'Timeframe',
    chooseWorkDate: 'Choose period',
    selectedRange: 'Selected range',
    balanceToday: 'Overtime Today',
    closedWorked: 'Closed work',
    referenceDate: 'Reference date',
    expected: 'Expected',
    balance: 'Overtime',
    clockLog: 'Time Log',
    when: 'When',
    noClockEvents: 'No clock actions yet.',
    previousDay: 'Previous day',
    nextDay: 'Next day',
    chooseLogDate: 'Choose log date',
    previousPeriod: 'Previous period',
    nextPeriod: 'Next period',
    chooseCalendarDate: 'Choose calendar date',
    calendarViewMode: 'Calendar view',
    exportCalendar: 'Export calendar',
    day: 'Day',
    week: 'Week',
    month: 'Month',
    year: 'Year',
    allTime: 'Entire time',
    vacation: 'Vacation',
    used: 'used',
    notifications: 'Notifications',
    noUnread: 'No unread notifications.',
    thisMonth: 'This Month',
    calendarAccess: 'Calendar Access',
    saveAccess: 'Save Access',
    customCalendarEvents: 'Own calendar events',
    newCalendarEvent: 'New calendar event',
    eventTitle: 'Title',
    eventDescription: 'Description',
    allDayEvent: 'All-day event',
    shareEventWithCalendarUsers: 'Share with people who can see my calendar',
    sharedEvent: 'Shared',
    privateEvent: 'Private',
    saveEvent: 'Save event',
    updateEvent: 'Update event',
    editEvent: 'Edit event',
    deleteEvent: 'Delete event',
    noCustomCalendarEvents: 'No own calendar events yet.',
    customEventLegend: 'Own calendar event',
    adminWorkCalendar: 'Admin work calendar',
    allEmployees: 'All employees',
    groupFilter: 'Group',
    noEmployeesInSelection: 'No employees in this selection.',
    runningNow: 'running',
    clockedIn: 'Clocked in',
    adminWorkReport: 'Work report',
    reportUsers: 'Users in report',
    searchUsers: 'Search users',
    selectVisibleUsers: 'Select shown',
    clearSelection: 'Clear',
    selectedUsersCount: '{count} selected',
    worked: 'Worked',
    breaks: 'Breaks',
    entries: 'Entries',
    total: 'Total',
    noReportUsersSelected: 'Select at least one user to show the report.',
    groups: 'Groups',
    newGroup: 'New group',
    groupName: 'Group name',
    groupMembers: 'Members',
    createGroup: 'Create group',
    editGroup: 'Edit group',
    saveGroup: 'Save group',
    deleteGroup: 'Delete group',
    confirmGroupChangeTitle: 'Save group changes?',
    confirmGroupChangeBody: 'Changing group members affects who can share calendars with whom.',
    confirmDeleteGroupTitle: 'Delete group?',
    confirmDeleteGroupBody: 'Members will lose this group connection for calendar sharing.',
    noShareableCalendarUsers: 'No group members available.',
    calDavSync: 'CalDAV sync',
    calDavName: 'Connection name',
    calDavServerUrl: 'Server URL',
    calDavCalendarUrl: 'Calendar URL (optional)',
    calDavUsername: 'Username',
    calDavPassword: 'App password',
    calDavPasswordPlaceholder: 'Leave blank to keep saved password',
    shareCalDavTitles: 'Share event titles with coworkers',
    syncEnabled: 'Sync enabled',
    addCalDavAccount: 'Add CalDAV calendar',
    saveCalDavAccount: 'Save CalDAV calendar',
    syncNow: 'Sync now',
    deleteCalDavAccount: 'Delete CalDAV calendar',
    noCalDavAccounts: 'No external calendars connected.',
    calDavHint: 'External meetings are shown as availability blockers only. They never count as worked time.',
    calDavPrivacyHint: 'Coworkers see Busy unless you allow titles.',
    lastSync: 'Last sync',
    neverSynced: 'Never synced',
    busyLegend: 'External busy block',
    busy: 'Busy',
    allDay: 'All day',
    newRequest: 'New Request',
    allRequests: 'All Requests',
    myRequests: 'My Requests',
    myApprovedRequests: 'Approved requests',
    noApprovedRequests: 'No approved requests yet.',
    noRequests: 'No requests yet.',
    requestTimeframe: 'Request timeframe',
    requestFrom: 'From',
    requestTo: 'To',
    showAllRequests: 'Show all',
    shownRequests: 'Shown requests',
    currentWeek: 'Current week',
    allStatuses: 'All statuses',
    requestStatusFilter: 'Status',
    includeOpenRequests: 'Always show open requests',
    adminRequestOverview: 'Request overview',
    ownRequestView: 'Own request',
    adminRequestView: 'Admin view',
    requestSubmittedAt: 'Submitted',
    requestDecisionAt: 'Decision',
    requestPeriod: 'Period',
    upcomingRequests: 'Upcoming',
    openRequests: 'Open',
    type: 'Type',
    overtimePayout: 'Overtime payout',
    overtimeTimeOff: 'Overtime time off',
    timeCorrection: 'Time correction',
    sickLeave: 'Sick leave',
    childSickLeave: 'Child sick',
    customRequest: 'Custom request',
    customRequestSubject: 'Subject',
    customRequestSubjectRequired: 'Please enter a subject for the custom request.',
    doctorNote: 'Doctor note',
    doctorNoteAttached: 'Doctor note attached',
    downloadDoctorNote: 'Open doctor note',
    doctorNoteFileInvalid: 'Please upload a PDF, PNG, JPG, or WebP file up to 2 MB.',
    date: 'Date',
    start: 'Start',
    end: 'End',
    breakMinutes: 'Break minutes',
    startDate: 'Start date',
    endDate: 'End date',
    minutes: 'Minutes',
    reason: 'Reason',
    submitRequest: 'Submit Request',
    updateRequest: 'Update request',
    editRequest: 'Edit request',
    withdrawRequest: 'Withdraw request',
    confirmWithdrawRequestTitle: 'Withdraw request?',
    confirmWithdrawRequestBody: 'This marks your pending request as withdrawn. Admins will no longer be able to approve it.',
    hours: 'hours',
    employeeSettings: 'Employee Settings',
    inviteNewUser: 'Invite new user',
    sendInvite: 'Create user and send invite',
    inviteEmailSent: 'Invite email sent',
    userRole: 'Role',
    startingTerms: 'Starting terms',
    initialBalances: 'Initial overtime and vacation',
    pendingInvites: 'Pending invites',
    noPendingInvites: 'No pending invites.',
    acceptedInvites: 'Accepted invites',
    confirmInviteTitle: 'Create user and send invite?',
    confirmInviteBody: 'This creates the user, links the email address, and sends an invitation to set the password.',
    cancelInvite: 'Cancel invite',
    confirmCancelInviteTitle: 'Cancel invite?',
    confirmCancelInviteBody: 'This removes the pending invitation and frees the email address so it can be invited again later.',
    selectEmployee: 'Select user',
    selectedEmployee: 'Selected user',
    noEmployeeSelected: 'No user selected.',
    employmentTerms: 'Employment terms',
    currentTerms: 'Term history',
    appliesSince: 'Applies since',
    effectiveFrom: 'Effective from',
    currentSettings: 'Current settings',
    editTerms: 'Edit terms',
    editAdjustments: 'Edit overtime',
    editResponsibleAdmin: 'Edit responsible admin',
    permissions: 'Permissions',
    editPermissions: 'Edit permissions',
    currentRole: 'Current role',
    confirmRoleTitle: 'Save role change?',
    confirmRoleBody: 'This changes which administrative functions this user can access.',
    removeUser: 'Remove user',
    removeUserDangerTitle: 'Remove user',
    confirmRemoveUserTitle: 'Remove this user?',
    confirmRemoveUserBody: 'This deactivates the account and removes calendar sharing and group membership. Historical time data is kept for records.',
    exportBeforeRemove: 'Export all time data before removing',
    removeWithoutExport: 'Remove without export',
    saveImportantChange: 'Save important change',
    confirmEmploymentTermTitle: 'Save employment terms?',
    confirmEmploymentTermBody: 'This changes expected work time or vacation entitlement from the selected date and affects calculations for that period.',
    confirmAdjustmentTitle: 'Save overtime override?',
    confirmAdjustmentBody: 'This overwrites the current vacation or overtime for this year. Use it only for imports or corrections.',
    confirmResponsibleAdminTitle: 'Save responsible admin?',
    confirmResponsibleAdminBody: 'Future request emails for this employee will follow this assignment.',
    weeklyHours: 'Weekly hours',
    vacationDays: 'Vacation days',
    currentVacationRemainingDays: 'Current remaining vacation',
    currentBalanceHours: 'Current overtime',
    responsibleAdmin: 'Responsible admin',
    allAdminsFallback: 'All admins',
    save: 'Save',
    holidayTemplates: 'Holiday templates',
    holidayCountry: 'Country',
    holidayState: 'State',
    holidayRegion: 'Region',
    holidayTemplateLanguage: 'Holiday language',
    saveHolidayTemplate: 'Save holiday template',
    noHolidayState: 'Country-wide',
    noHolidayRegion: 'No region',
    templatePublicHolidays: 'Template public holidays',
    manualHolidayHint: 'Manual changes are applied on top of the selected template.',
    holidayName: 'Name',
    holidayFreePercent: 'Free percentage (%)',
    action: 'Action',
    addHoliday: 'Add holiday',
    disableHoliday: 'Disable holiday date',
    editHoliday: 'Edit holiday',
    manualHoliday: 'Manual holiday',
    manualHolidayChanges: 'Manual changes',
    noHolidayOverrides: 'No manual changes yet.',
    cancelEdit: 'Cancel edit',
    removeHolidayChange: 'Remove change',
    apply: 'Apply',
    csvImport: 'CSV Import',
    csvExport: 'CSV Export',
    exportFor: 'Export for',
    exportPeriod: 'Period',
    exportCsv: 'Export CSV',
    employee: 'Employee',
    fileName: 'File name',
    csvContent: 'CSV content',
    importCsv: 'Import CSV',
    recentImports: 'Recent imports',
    noImports: 'No imports yet.',
    imported: 'imported',
    skipped: 'skipped',
    backup: 'Backups',
    dataFile: 'Data file',
    backupFolder: 'Backup folder',
    lastBackup: 'Last weekly backup',
    createBackup: 'Create weekly backup',
    mailServer: 'Mail server',
    noMailServer: 'No mail server configured. Emails use the environment fallback or are logged only.',
    smtpHost: 'SMTP host',
    smtpPort: 'SMTP port',
    smtpSecure: 'TLS/SSL',
    smtpUser: 'SMTP user',
    smtpPassword: 'SMTP password',
    smtpFrom: 'From address',
    passwordSaved: 'Password saved',
    passwordPlaceholder: 'Leave blank to keep saved password',
    saveMailServer: 'Save mail server',
    testMailServer: 'Send test email',
    deleteMailServer: 'Delete mail server',
    confirmDeleteMailServerTitle: 'Delete mail server?',
    confirmDeleteMailServerBody: 'Invites, request notifications, and approval emails depend on this configuration. Delete it only if you are replacing it or using an environment fallback.',
    license: 'License',
    licenseStatus: 'License status',
    activeUsers: 'Active users',
    activeUserLimit: 'Active user limit',
    freeUserLimit: 'Free user limit',
    licenseKey: 'License key',
    licenseKeyPlaceholder: 'Paste signed license key',
    licenseKeyRequired: 'Paste a license key before saving.',
    saveLicense: 'Save license',
    deleteLicense: 'Delete license',
    noLicenseConfigured: 'No license key configured. Community use is allowed up to 10 active users.',
    paidLicense: 'Paid license',
    freeGrantLicense: 'Free grant',
    communityLicenseStatus: 'Community use',
    licensedStatus: 'Licensed',
    overLimitStatus: 'Over limit',
    invalidLicenseStatus: 'Invalid license',
    expiredLicenseStatus: 'Expired license',
    missingPublicKeyStatus: 'Server public key missing',
    holder: 'Holder',
    contact: 'Contact',
    plan: 'Plan',
    issuedAt: 'Issued at',
    validUntil: 'Valid until',
    licenseMessage: 'Message',
    confirmDeleteLicenseTitle: 'Delete license?',
    confirmDeleteLicenseBody: 'Without this license the app falls back to the free 10 active-user limit. Keep the key if the company is above that limit.',
    saveSettings: 'Save settings',
    confirm: 'Confirm',
    cancel: 'Cancel',
    noneYet: 'None yet',
    pending: 'pending',
    approved: 'approved',
    rejected: 'rejected',
    undone: 'undone',
    approvedActions: 'Approved Actions',
    noApprovedActions: 'No approved actions for this user.',
    undoApproval: 'Undo approval',
    confirmUndoApprovalTitle: 'Undo approval?',
    confirmUndoApprovalBody: 'This removes the applied calendar or time-entry effect and marks the request as undone.',
    approvedAt: 'Approved at',
    approvedBy: 'Approved by',
    calendarLegend: 'Legend',
    publicHolidayLegend: 'Public holiday',
    vacationLegend: 'Approved vacation',
    sickLeaveLegend: 'Sick leave',
    timeOffLegend: 'Overtime time off',
  },
  de: {
    appName: 'Digital Core Office Zeit',
    dashboard: 'Übersicht',
    calendar: 'Kalender',
    requests: 'Anträge',
    adminCalendarTab: 'Admin-Kalender',
    admin: 'Admin',
    users: 'Benutzer',
    freeDays: 'Freie Tage',
    settings: 'Einstellungen',
    signOut: 'Abmelden',
    signIn: 'Einloggen',
    switchToDarkMode: 'Dunkelmodus aktivieren',
    switchToLightMode: 'Hellmodus aktivieren',
    switchSystems: 'System wechseln',
    inventorySystem: 'Inventar',
    agileProjectManagement: 'Agile',
    openInventorySystem: 'Inventarverwaltung oeffnen',
    openAgileProjectManagement: 'Agiles Projektmanagement oeffnen',
    register: 'Registrieren',
    createAccount: 'Konto erstellen',
    alreadyRegistered: 'Bestehendes Konto nutzen',
    name: 'Name',
    email: 'E-Mail',
    password: 'Passwort',
    confirmPassword: 'Passwort bestätigen',
    showPassword: 'Anzeigen',
    hidePassword: 'Ausblenden',
    stayLoggedIn: 'Eingeloggt bleiben',
    forgotPasswordReset: 'Passwort vergessen? Zurücksetzen',
    resetPasswordTitle: 'Passwort zurücksetzen',
    resetPasswordIntro: 'Gib die E-Mail-Adresse deines Kontos ein. Falls es existiert, erhältst du einen Link zum Zurücksetzen.',
    resetPasswordEmailSent: 'Falls ein aktives Konto für diese E-Mail-Adresse existiert, wurde ein Link zum Zurücksetzen gesendet.',
    sendResetLink: 'Link senden',
    backToLogin: 'Zurück zum Login',
    setNewPassword: 'Neues Passwort setzen',
    resetLinkInvalid: 'Dieser Link zum Zurücksetzen ist ungültig, abgelaufen oder bereits genutzt.',
    safePasswordHint: 'Mindestens 12 Zeichen mit Groß-/Kleinbuchstaben, Zahl, Symbol und ohne Name/E-Mail.',
    numericFieldsRequired: 'Bitte fülle alle Zahlenfelder mit gültigen Zahlen aus.',
    dateOutOfRange: 'Bitte wähle ein Datum zwischen {min} und {max}.',
    weeklyHoursRequired: 'Wochenstunden müssen größer als 0 sein.',
    invitationRequired: 'Registrierung benötigt eine Einladung durch einen Admin.',
    completeInviteTitle: 'Einladung abschließen',
    invitationIntro: 'Lege ein sicheres Passwort für die eingeladene E-Mail-Adresse fest.',
    invitedEmailLocked: 'Eingeladene E-Mail',
    inviteExpiresAt: 'Einladung gültig bis',
    createPassword: 'Passwort erstellen',
    changePasswordTitle: 'Passwort ändern',
    forcedPasswordChangeIntro: 'Lege ein neues sicheres Passwort fest, bevor du fortfährst.',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    saveNewPassword: 'Neues Passwort speichern',
    savingChanges: 'Speichern...',
    changesSaved: 'Gespeichert',
    clockSaved: 'In DCO gespeichert',
    downloadAndroidApp: 'Android-App herunterladen',
    mobileBackendMissingTitle: 'Backend-URL fehlt',
    mobileBackendMissingBody: 'Diese mobile App wurde ohne Backend-URL erstellt. Baue sie mit gesetzter VITE_API_URL zur HTTPS-Serveradresse neu.',
    backendSynced: 'Mit Backend synchronisiert',
    backendSyncing: 'Synchronisiere mit Backend...',
    backendSyncLost: 'Backend-Sync verloren. Stempeln ist deaktiviert, bis die App wieder verbunden ist.',
    reconnectNow: 'Jetzt neu verbinden',
    sessionUnavailable: 'Verbindung nicht verfügbar',
    sessionCheckFailed: 'Deine Anmeldung konnte nicht geprüft werden. Prüfe deine Verbindung und versuche es erneut.',
    backendSyncStale: 'Backend-Stand ist veraltet. Stempeln ist deaktiviert bis zur nächsten Synchronisierung.',
    lastBackendSync: 'Letzter Sync',
    invalidInvite: 'Diese Einladung ist ungültig, abgelaufen oder bereits genutzt.',
    demoAdmin: 'Admin Demo',
    demoEmployee: 'Mitarbeiter Demo',
    offWork: 'Nicht eingestempelt',
    working: 'Arbeit läuft',
    onBreak: 'In Pause',
    startWork: 'Arbeit starten',
    startBreak: 'Pause starten',
    stopBreak: 'Pause beenden',
    stopWork: 'Arbeit beenden',
    confirmClockOutTitle: 'Arbeit beenden?',
    confirmClockOutBody: 'Dadurch wirst du ausgestempelt und der aktuelle Arbeitseintrag wird geschlossen.',
    clockRunning: 'Erfasste Arbeitszeit',
    workedToday: 'Heute gearbeitet',
    clockedInAt: 'Eingestempelt um',
    breakTaken: 'Pause genommen',
    workLocation: 'Arbeitsort',
    officeLocation: 'Im Büro',
    homeofficeLocation: 'Im Homeoffice',
    remoteLocation: 'Remote',
    customerLocation: 'Beim Kunden',
    businessTripLocation: 'Auf Dienstreise',
    timeBalance: 'Überstunden',
    legacyBalanceReview: 'Frühere Überstundenfreigaben müssen vor der Abrechnung geprüft werden. Bitte wende dich an die Administration.',
    workedTime: 'Arbeitszeit',
    workTimePeriod: 'Zeitraum',
    chooseWorkDate: 'Zeitraum wählen',
    selectedRange: 'Ausgewählter Zeitraum',
    balanceToday: 'Überstunden heute',
    closedWorked: 'Abgeschlossene Arbeit',
    referenceDate: 'Bezugsdatum',
    expected: 'Soll',
    balance: 'Überstunden',
    clockLog: 'Zeitprotokoll',
    when: 'Zeitpunkt',
    noClockEvents: 'Noch keine Zeitaktionen.',
    previousDay: 'Vorheriger Tag',
    nextDay: 'Nächster Tag',
    chooseLogDate: 'Protokolldatum wählen',
    previousPeriod: 'Vorheriger Zeitraum',
    nextPeriod: 'Nächster Zeitraum',
    chooseCalendarDate: 'Kalenderdatum wählen',
    calendarViewMode: 'Kalenderansicht',
    exportCalendar: 'Kalender exportieren',
    day: 'Tag',
    week: 'Woche',
    month: 'Monat',
    year: 'Jahr',
    allTime: 'Gesamter Zeitraum',
    vacation: 'Urlaub',
    used: 'genutzt',
    notifications: 'Benachrichtigungen',
    noUnread: 'Keine ungelesenen Benachrichtigungen.',
    thisMonth: 'Dieser Monat',
    calendarAccess: 'Kalenderfreigabe',
    saveAccess: 'Freigabe speichern',
    customCalendarEvents: 'Eigene Kalendertermine',
    newCalendarEvent: 'Neuer Kalendertermin',
    eventTitle: 'Titel',
    eventDescription: 'Beschreibung',
    allDayEvent: 'Ganztägiger Termin',
    shareEventWithCalendarUsers: 'Mit Personen teilen, die meinen Kalender sehen dürfen',
    sharedEvent: 'Geteilt',
    privateEvent: 'Privat',
    saveEvent: 'Termin speichern',
    updateEvent: 'Termin aktualisieren',
    editEvent: 'Termin bearbeiten',
    deleteEvent: 'Termin löschen',
    noCustomCalendarEvents: 'Noch keine eigenen Kalendertermine.',
    customEventLegend: 'Eigener Kalendertermin',
    adminWorkCalendar: 'Admin-Arbeitskalender',
    allEmployees: 'Alle Mitarbeiter',
    groupFilter: 'Gruppe',
    noEmployeesInSelection: 'Keine Mitarbeiter in dieser Auswahl.',
    runningNow: 'läuft',
    clockedIn: 'Eingestempelt',
    adminWorkReport: 'Arbeitsbericht',
    reportUsers: 'Benutzer im Bericht',
    searchUsers: 'Benutzer suchen',
    selectVisibleUsers: 'Angezeigte auswählen',
    clearSelection: 'Auswahl leeren',
    selectedUsersCount: '{count} ausgewählt',
    worked: 'Gearbeitet',
    breaks: 'Pausen',
    entries: 'Einträge',
    total: 'Gesamt',
    noReportUsersSelected: 'Wähle mindestens einen Benutzer aus, um den Bericht anzuzeigen.',
    groups: 'Gruppen',
    newGroup: 'Neue Gruppe',
    groupName: 'Gruppenname',
    groupMembers: 'Mitglieder',
    createGroup: 'Gruppe erstellen',
    editGroup: 'Gruppe bearbeiten',
    saveGroup: 'Gruppe speichern',
    deleteGroup: 'Gruppe löschen',
    confirmGroupChangeTitle: 'Gruppenänderungen speichern?',
    confirmGroupChangeBody: 'Änderungen an Gruppenmitgliedern beeinflussen, wer Kalender mit wem teilen kann.',
    confirmDeleteGroupTitle: 'Gruppe löschen?',
    confirmDeleteGroupBody: 'Mitglieder verlieren diese Gruppenverbindung für die Kalenderfreigabe.',
    noShareableCalendarUsers: 'Keine Gruppenmitglieder verfügbar.',
    calDavSync: 'CalDAV-Sync',
    calDavName: 'Verbindungsname',
    calDavServerUrl: 'Server-URL',
    calDavCalendarUrl: 'Kalender-URL (optional)',
    calDavUsername: 'Benutzername',
    calDavPassword: 'App-Passwort',
    calDavPasswordPlaceholder: 'Leer lassen, um das gespeicherte Passwort zu behalten',
    shareCalDavTitles: 'Termintitel mit Kollegen teilen',
    syncEnabled: 'Sync aktiv',
    addCalDavAccount: 'CalDAV-Kalender hinzufügen',
    saveCalDavAccount: 'CalDAV-Kalender speichern',
    syncNow: 'Jetzt synchronisieren',
    deleteCalDavAccount: 'CalDAV-Kalender löschen',
    noCalDavAccounts: 'Keine externen Kalender verbunden.',
    calDavHint: 'Externe Termine werden nur als Verfügbarkeitsblocker angezeigt. Sie zählen nie als Arbeitszeit.',
    calDavPrivacyHint: 'Kollegen sehen „Beschäftigt“, außer du gibst Titel frei.',
    lastSync: 'Letzter Sync',
    neverSynced: 'Noch nie synchronisiert',
    busyLegend: 'Externer Terminblocker',
    busy: 'Beschäftigt',
    allDay: 'Ganztägig',
    newRequest: 'Neuer Antrag',
    allRequests: 'Alle Anträge',
    myRequests: 'Meine Anträge',
    myApprovedRequests: 'Genehmigte Anträge',
    noApprovedRequests: 'Noch keine genehmigten Anträge.',
    noRequests: 'Noch keine Anträge.',
    requestTimeframe: 'Antragszeitraum',
    requestFrom: 'Von',
    requestTo: 'Bis',
    showAllRequests: 'Alle anzeigen',
    shownRequests: 'Angezeigte Anträge',
    currentWeek: 'Aktuelle Woche',
    allStatuses: 'Alle Status',
    requestStatusFilter: 'Status',
    includeOpenRequests: 'Offene Anträge immer anzeigen',
    adminRequestOverview: 'Antragsübersicht',
    ownRequestView: 'Eigener Antrag',
    adminRequestView: 'Admin-Ansicht',
    requestSubmittedAt: 'Eingereicht',
    requestDecisionAt: 'Entscheidung',
    requestPeriod: 'Zeitraum',
    upcomingRequests: 'Bevorstehend',
    openRequests: 'Offen',
    type: 'Typ',
    overtimePayout: 'Überstunden auszahlen',
    overtimeTimeOff: 'Überstunden Ausgleich',
    timeCorrection: 'Zeitkorrektur',
    sickLeave: 'Krankmeldung',
    childSickLeave: 'Kind krank',
    customRequest: 'Freier Antrag',
    customRequestSubject: 'Betreff',
    customRequestSubjectRequired: 'Bitte gib einen Betreff für den freien Antrag ein.',
    doctorNote: 'Ärztliche Bescheinigung',
    doctorNoteAttached: 'Ärztliche Bescheinigung angehängt',
    downloadDoctorNote: 'Bescheinigung öffnen',
    doctorNoteFileInvalid: 'Bitte lade eine PDF-, PNG-, JPG- oder WebP-Datei bis 2 MB hoch.',
    date: 'Datum',
    start: 'Start',
    end: 'Ende',
    breakMinutes: 'Pausenminuten',
    startDate: 'Startdatum',
    endDate: 'Enddatum',
    minutes: 'Minuten',
    reason: 'Begründung',
    submitRequest: 'Antrag senden',
    updateRequest: 'Antrag aktualisieren',
    editRequest: 'Antrag bearbeiten',
    withdrawRequest: 'Antrag zurücknehmen',
    confirmWithdrawRequestTitle: 'Antrag zurücknehmen?',
    confirmWithdrawRequestBody: 'Dadurch wird dein offener Antrag als zurückgenommen markiert. Admins können ihn danach nicht mehr genehmigen.',
    hours: 'Stunden',
    employeeSettings: 'Mitarbeiter-Einstellungen',
    inviteNewUser: 'Neuen Benutzer einladen',
    sendInvite: 'Benutzer erstellen und Einladung senden',
    inviteEmailSent: 'Einladungs-E-Mail gesendet',
    userRole: 'Rolle',
    startingTerms: 'Startbedingungen',
    initialBalances: 'Startwerte für Überstunden und Urlaub',
    pendingInvites: 'Offene Einladungen',
    noPendingInvites: 'Keine offenen Einladungen.',
    acceptedInvites: 'Angenommene Einladungen',
    confirmInviteTitle: 'Benutzer erstellen und Einladung senden?',
    confirmInviteBody: 'Dadurch wird der Benutzer erstellt, die E-Mail-Adresse verknüpft und eine Einladung zum Festlegen des Passworts gesendet.',
    cancelInvite: 'Einladung abbrechen',
    confirmCancelInviteTitle: 'Einladung abbrechen?',
    confirmCancelInviteBody: 'Dadurch wird die offene Einladung entfernt und die E-Mail-Adresse kann später erneut eingeladen werden.',
    selectEmployee: 'Benutzer auswählen',
    selectedEmployee: 'Ausgewählter Benutzer',
    noEmployeeSelected: 'Kein Benutzer ausgewählt.',
    employmentTerms: 'Arbeitsbedingungen',
    currentTerms: 'Verlauf der Bedingungen',
    appliesSince: 'Gültig seit',
    effectiveFrom: 'Gültig ab',
    currentSettings: 'Aktuelle Einstellungen',
    editTerms: 'Bedingungen bearbeiten',
    editAdjustments: 'Überstunden bearbeiten',
    editResponsibleAdmin: 'Zuständigen Admin bearbeiten',
    permissions: 'Berechtigungen',
    editPermissions: 'Berechtigungen bearbeiten',
    currentRole: 'Aktuelle Rolle',
    confirmRoleTitle: 'Rollenänderung speichern?',
    confirmRoleBody: 'Das ändert, auf welche Admin-Funktionen dieser Benutzer zugreifen kann.',
    removeUser: 'Benutzer entfernen',
    removeUserDangerTitle: 'Benutzer entfernen',
    confirmRemoveUserTitle: 'Diesen Benutzer entfernen?',
    confirmRemoveUserBody: 'Das deaktiviert das Konto und entfernt Kalenderfreigaben und Gruppenmitgliedschaften. Historische Zeitdaten bleiben für Nachweise erhalten.',
    exportBeforeRemove: 'Alle Zeitdaten vor dem Entfernen exportieren',
    removeWithoutExport: 'Ohne Export entfernen',
    saveImportantChange: 'Wichtige Änderung speichern',
    confirmEmploymentTermTitle: 'Arbeitsbedingungen speichern?',
    confirmEmploymentTermBody: 'Das ändert Soll-Arbeitszeit oder Urlaubsanspruch ab dem gewählten Datum und beeinflusst die Berechnung für diesen Zeitraum.',
    confirmAdjustmentTitle: 'Überstunden-Überschreibung speichern?',
    confirmAdjustmentBody: 'Das überschreibt den aktuellen Urlaub oder die Überstunden für dieses Jahr. Nutze es nur für Importe oder Korrekturen.',
    confirmResponsibleAdminTitle: 'Zuständigen Admin speichern?',
    confirmResponsibleAdminBody: 'Künftige Antrags-E-Mails für diesen Mitarbeiter folgen dieser Zuordnung.',
    weeklyHours: 'Wochenstunden',
    vacationDays: 'Urlaubstage',
    currentVacationRemainingDays: 'Aktuell verbleibende Urlaubstage',
    currentBalanceHours: 'Aktuelle Überstunden',
    responsibleAdmin: 'Zuständiger Admin',
    allAdminsFallback: 'Alle Admins',
    save: 'Speichern',
    holidayTemplates: 'Feiertagsvorlagen',
    holidayCountry: 'Land',
    holidayState: 'Bundesland / Staat',
    holidayRegion: 'Region',
    holidayTemplateLanguage: 'Feiertagssprache',
    saveHolidayTemplate: 'Feiertagsvorlage speichern',
    noHolidayState: 'Landesweit',
    noHolidayRegion: 'Keine Region',
    templatePublicHolidays: 'Feiertage aus Vorlage',
    manualHolidayHint: 'Manuelle Änderungen werden zusätzlich zur gewählten Vorlage angewendet.',
    holidayName: 'Name',
    holidayFreePercent: 'Freier Anteil (%)',
    action: 'Aktion',
    addHoliday: 'Feiertag hinzufügen',
    disableHoliday: 'Feiertag deaktivieren',
    editHoliday: 'Feiertag bearbeiten',
    manualHoliday: 'Manueller Feiertag',
    manualHolidayChanges: 'Manuelle Änderungen',
    noHolidayOverrides: 'Noch keine manuellen Änderungen.',
    cancelEdit: 'Bearbeitung abbrechen',
    removeHolidayChange: 'Änderung entfernen',
    apply: 'Anwenden',
    csvImport: 'CSV Import',
    csvExport: 'CSV Export',
    exportFor: 'Export für',
    exportPeriod: 'Zeitraum',
    exportCsv: 'CSV exportieren',
    employee: 'Mitarbeiter',
    fileName: 'Dateiname',
    csvContent: 'CSV Inhalt',
    importCsv: 'CSV importieren',
    recentImports: 'Letzte Importe',
    noImports: 'Noch keine Importe.',
    imported: 'importiert',
    skipped: 'übersprungen',
    backup: 'Backups',
    dataFile: 'Datenbankdatei',
    backupFolder: 'Backup-Ordner',
    lastBackup: 'Letztes Wochenbackup',
    createBackup: 'Wochenbackup erstellen',
    mailServer: 'Mailserver',
    noMailServer: 'Kein Mailserver konfiguriert. E-Mails nutzen den Umgebungs-Fallback oder werden nur protokolliert.',
    smtpHost: 'SMTP Host',
    smtpPort: 'SMTP Port',
    smtpSecure: 'TLS/SSL',
    smtpUser: 'SMTP Benutzer',
    smtpPassword: 'SMTP Passwort',
    smtpFrom: 'Absenderadresse',
    passwordSaved: 'Passwort gespeichert',
    passwordPlaceholder: 'Leer lassen, um das gespeicherte Passwort zu behalten',
    saveMailServer: 'Mailserver speichern',
    testMailServer: 'Test-E-Mail senden',
    deleteMailServer: 'Mailserver löschen',
    confirmDeleteMailServerTitle: 'Mailserver löschen?',
    confirmDeleteMailServerBody: 'Einladungen, Antragsbenachrichtigungen und Genehmigungs-E-Mails hängen von dieser Konfiguration ab. Lösche sie nur, wenn du sie ersetzt oder einen Umgebungs-Fallback nutzt.',
    license: 'Lizenz',
    licenseStatus: 'Lizenzstatus',
    activeUsers: 'Aktive Benutzer',
    activeUserLimit: 'Limit aktiver Benutzer',
    freeUserLimit: 'Kostenloses Benutzerlimit',
    licenseKey: 'Lizenzschlüssel',
    licenseKeyPlaceholder: 'Signierten Lizenzschlüssel einfügen',
    licenseKeyRequired: 'Bitte füge vor dem Speichern einen Lizenzschlüssel ein.',
    saveLicense: 'Lizenz speichern',
    deleteLicense: 'Lizenz löschen',
    noLicenseConfigured: 'Kein Lizenzschlüssel konfiguriert. Die Community-Nutzung ist bis 10 aktive Benutzer erlaubt.',
    paidLicense: 'Bezahlte Lizenz',
    freeGrantLicense: 'Kostenfreie Sonderlizenz',
    communityLicenseStatus: 'Community-Nutzung',
    licensedStatus: 'Lizenziert',
    overLimitStatus: 'Über dem Limit',
    invalidLicenseStatus: 'Ungültige Lizenz',
    expiredLicenseStatus: 'Abgelaufene Lizenz',
    missingPublicKeyStatus: 'Öffentlicher Serverschlüssel fehlt',
    holder: 'Lizenznehmer',
    contact: 'Kontakt',
    plan: 'Tarif',
    issuedAt: 'Ausgestellt am',
    validUntil: 'Gültig bis',
    licenseMessage: 'Meldung',
    confirmDeleteLicenseTitle: 'Lizenz löschen?',
    confirmDeleteLicenseBody: 'Ohne diese Lizenz fällt die App auf das kostenlose Limit von 10 aktiven Benutzern zurück. Behalte den Schlüssel, wenn die Firma darüber liegt.',
    saveSettings: 'Einstellungen speichern',
    confirm: 'Bestätigen',
    cancel: 'Abbrechen',
    noneYet: 'Noch keines',
    pending: 'offen',
    approved: 'genehmigt',
    rejected: 'abgelehnt',
    undone: 'zurückgenommen',
    approvedActions: 'Genehmigte Aktionen',
    noApprovedActions: 'Keine genehmigten Aktionen für diese Person.',
    undoApproval: 'Genehmigung rückgängig machen',
    confirmUndoApprovalTitle: 'Genehmigung rückgängig machen?',
    confirmUndoApprovalBody: 'Dadurch wird die angewendete Kalender- oder Zeiterfassungswirkung entfernt und der Antrag als zurückgenommen markiert.',
    approvedAt: 'Genehmigt am',
    approvedBy: 'Genehmigt von',
    calendarLegend: 'Legende',
    publicHolidayLegend: 'Feiertag',
    vacationLegend: 'Genehmigter Urlaub',
    sickLeaveLegend: 'Krankmeldung',
    timeOffLegend: 'Überstunden Ausgleich',
  },
}

type T = typeof translations.en

function sensibleDateRangeMessage(t: T, language: Language) {
  const bounds = sensibleDateBounds()
  return t.dateOutOfRange
    .replace('{min}', formatDateKey(bounds.min, language))
    .replace('{max}', formatDateKey(bounds.max, language))
}

interface ApiError {
  message: string
}

interface ClockActivityEvent {
  id: string
  action: ClockAction
  at: string
}

interface InvitationPreview {
  name: string
  email: string
  role: Role
  expiresAt: string
}

interface PasswordResetPreview {
  name: string
  email: string
  expiresAt: string
}

function classNames(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(' ')
}

function DigitalCoreOfficeLogo({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" focusable="false" height={size} viewBox="0 0 48 48" width={size}>
      <rect fill="currentColor" height="48" opacity="0.14" rx="10" width="48" />
      <path d="M12 17.5 24 10l12 7.5v13L24 38l-12-7.5z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="3" />
      <path d="M24 10v28M12 17.5l12 7.2 12-7.2M12 30.5l12-7 12 7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
      <circle cx="24" cy="24" fill="currentColor" r="3.2" />
    </svg>
  )
}

function AppSelect({
  value,
  options,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: string
  options: SelectOption[]
  disabled?: boolean
  ariaLabel?: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const selectedOption = options.find((option) => option.value === value) ?? options.find((option) => !option.disabled) ?? options[0]

  useEffect(() => {
    if (!open) {
      return undefined
    }

    function closeIfOutside(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    window.addEventListener('pointerdown', closeIfOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeIfOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (disabled) {
      setOpen(false)
    }
  }, [disabled])

  return (
    <div className="app-select" ref={wrapperRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="app-select-button"
        disabled={disabled}
        type="button"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedOption?.label ?? ''}</span>
        <ChevronRight className={open ? 'app-select-chevron open' : 'app-select-chevron'} size={16} />
      </button>
      {open && (
        <div className="app-select-menu" role="listbox">
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className={option.value === value ? 'selected' : ''}
              disabled={option.disabled}
              key={option.value}
              role="option"
              type="button"
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DateField({
  value,
  language,
  disabled,
  min,
  max,
  selectionMode = 'day',
  title,
  ariaLabel,
  onChange,
}: {
  value: string
  language: Language
  disabled?: boolean
  min?: string
  max?: string
  selectionMode?: DateFieldSelectionMode
  title?: string
  ariaLabel?: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => dateFieldDisplayValue(value, language, selectionMode))
  const [visibleMonth, setVisibleMonth] = useState(() => monthKeyForDate(value))
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const inputId = useId()
  const days = useMemo(() => buildCalendarDays(parseDateKey(visibleMonth)), [visibleMonth])
  const visibleDate = parseDateKey(visibleMonth)
  const monthTitle =
    selectionMode === 'year'
      ? yearRangeTitle(visibleDate.getFullYear())
      : selectionMode === 'month'
      ? String(visibleDate.getFullYear())
      : currentMonthTitle(visibleDate, language)
  const monthOptions = useMemo(() => monthsForYear(visibleDate.getFullYear()), [visibleDate])
  const yearOptions = useMemo(() => yearsForPanel(visibleDate.getFullYear()), [visibleDate])

  useEffect(() => {
    setDraft(dateFieldDisplayValue(value, language, selectionMode))
  }, [language, selectionMode, value])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    setVisibleMonth(panelKeyForDateField(value, selectionMode))

    function closeIfOutside(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setDraft(dateFieldDisplayValue(value, language, selectionMode))
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        setDraft(dateFieldDisplayValue(value, language, selectionMode))
      }
    }

    window.addEventListener('pointerdown', closeIfOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeIfOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [language, open, selectionMode, value])

  function commitDraft() {
    const parsed = parseDateFieldInput(draft, selectionMode)
    if (parsed && (!min || parsed >= min) && (!max || parsed <= max)) {
      onChange(parsed)
      setDraft(dateFieldDisplayValue(parsed, language, selectionMode))
      setVisibleMonth(panelKeyForDateField(parsed, selectionMode))
      return
    }
    setDraft(dateFieldDisplayValue(value, language, selectionMode))
  }

  function chooseDate(dateKey: string) {
    const normalized = normalizeDateFieldValue(dateKey, selectionMode)
    if ((min && normalized < min) || (max && normalized > max)) {
      return
    }
    onChange(normalized)
    setDraft(dateFieldDisplayValue(normalized, language, selectionMode))
    setOpen(false)
  }

  function chooseMonth(dateKey: string) {
    const normalized = normalizeDateFieldValue(dateKey, 'month')
    if ((min && normalized < min) || (max && normalized > max)) {
      return
    }
    onChange(normalized)
    setDraft(dateFieldDisplayValue(normalized, language, selectionMode))
    setOpen(false)
  }

  function chooseYear(dateKey: string) {
    const normalized = normalizeDateFieldValue(dateKey, 'year')
    if ((min && normalized < min) || (max && normalized > max)) {
      return
    }
    onChange(normalized)
    setDraft(dateFieldDisplayValue(normalized, language, selectionMode))
    setOpen(false)
  }

  return (
    <div className={classNames('date-field', `date-field-${selectionMode}`)} ref={wrapperRef}>
      <input
        aria-label={ariaLabel}
        disabled={disabled}
        id={inputId}
        inputMode="numeric"
        lang={localeFor(language)}
        placeholder={dateFieldPlaceholder(language, selectionMode)}
        title={title}
        value={draft}
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitDraft()
            setOpen(false)
          }
          if (event.key === 'Escape') {
            setOpen(false)
            setDraft(dateFieldDisplayValue(value, language, selectionMode))
          }
        }}
      />
      <button
        aria-controls={`${inputId}-calendar`}
        aria-expanded={open}
        className="date-field-button"
        disabled={disabled}
        title={title}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={16} />
      </button>
      {open && (
        <div className="date-picker-popover" id={`${inputId}-calendar`}>
          <div className="date-picker-header">
            <button
              className="icon-button"
              title={dateFieldNavigationTitle(selectionMode, language, -1)}
              type="button"
              onClick={() => setVisibleMonth((current) => shiftDateFieldPanel(current, selectionMode, -1))}
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{monthTitle}</strong>
            <button
              className="icon-button"
              title={dateFieldNavigationTitle(selectionMode, language, 1)}
              type="button"
              onClick={() => setVisibleMonth((current) => shiftDateFieldPanel(current, selectionMode, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {selectionMode === 'year' ? (
            <div className="date-picker-year-grid">
              {yearOptions.map((dateKey) => {
                const parsed = parseDateKey(dateKey)
                const selected = normalizeDateFieldValue(value, 'year') === dateKey
                const blocked = Boolean((min && dateKey < min) || (max && dateKey > max))
                return (
                  <button
                    className={classNames('date-picker-year', selected && 'selected')}
                    disabled={blocked}
                    key={dateKey}
                    type="button"
                    onClick={() => chooseYear(dateKey)}
                  >
                    {parsed.getFullYear()}
                  </button>
                )
              })}
            </div>
          ) : selectionMode === 'month' ? (
            <div className="date-picker-month-grid">
              {monthOptions.map((dateKey) => {
                const parsed = parseDateKey(dateKey)
                const selected = monthKeyForDate(value) === dateKey
                const blocked = Boolean((min && dateKey < min) || (max && dateKey > max))
                return (
                  <button
                    className={classNames('date-picker-month', selected && 'selected')}
                    disabled={blocked}
                    key={dateKey}
                    type="button"
                    onClick={() => chooseMonth(dateKey)}
                  >
                    {parsed.toLocaleDateString(localeFor(language), { month: 'short' })}
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <div className="date-picker-weekdays">
                {weekdayHeadersForMode('month', days, language).map((weekday) => (
                  <span key={weekday}>{weekday}</span>
                ))}
              </div>
              <div className="date-picker-grid">
                {days.map((dateKey) => {
                  const parsed = parseDateKey(dateKey)
                  const isCurrentMonth = parsed.getMonth() === parseDateKey(visibleMonth).getMonth()
                  const isSelected = dateKey === value
                  const selectedWeek = selectionMode === 'week' && normalizeDateFieldValue(dateKey, 'week') === normalizeDateFieldValue(value, 'week')
                  const normalized = normalizeDateFieldValue(dateKey, selectionMode)
                  const blocked = Boolean((min && normalized < min) || (max && normalized > max))
                  return (
                    <button
                      className={classNames(
                        'date-picker-day',
                        !isCurrentMonth && 'outside',
                        isSelected && 'selected',
                        selectedWeek && 'selected-week',
                      )}
                      disabled={blocked}
                      key={dateKey}
                      type="button"
                      onClick={() => chooseDate(dateKey)}
                    >
                      {parsed.getDate()}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PasswordField({
  label,
  value,
  autoComplete,
  disabled,
  t,
  onChange,
}: {
  label: string
  value: string
  autoComplete?: string
  disabled?: boolean
  t: T
  onChange: (value: string) => void
}) {
  const [visible, setVisible] = useState(false)
  const inputId = useId()
  return (
    <div className="password-field">
      <label htmlFor={inputId}>{label}</label>
      <span className="password-input-wrap">
        <input
          autoComplete={autoComplete}
          disabled={disabled}
          id={inputId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          type={visible ? 'text' : 'password'}
        />
        <button
          aria-label={visible ? t.hidePassword : t.showPassword}
          className="password-visibility-button"
          title={visible ? t.hidePassword : t.showPassword}
          type="button"
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
    </div>
  )
}

function formatShownNumber(value: number) {
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })
}

function numberInputValue(value: number) {
  return Number.isFinite(value) ? String(Number(value.toFixed(2))) : ''
}

function parseDecimalInput(value: string) {
  const normalized = value.trim().replace(',', '.')
  if (normalized.length === 0) {
    return undefined
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) {
    return undefined
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1])
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1]
}

function requestLabel(type: RequestType, t: T) {
  const labels: Record<RequestType, string> = {
    vacation: t.vacation,
    overtime_payout: t.overtimePayout,
    overtime_time_off: t.overtimeTimeOff,
    time_correction: t.timeCorrection,
    sick_leave: t.sickLeave,
    child_sick_leave: t.childSickLeave,
    custom: t.customRequest,
  }
  return labels[type]
}

function requestTitle(request: RequestItem, t: T) {
  return request.type === 'custom' && request.customTitle ? request.customTitle : requestLabel(request.type, t)
}

function absenceLabel(type: AbsenceType, t: T) {
  const labels: Record<AbsenceType, string> = {
    vacation: t.vacation,
    overtime_time_off: t.overtimeTimeOff,
    sick_leave: t.sickLeave,
    child_sick_leave: t.childSickLeave,
  }
  return labels[type]
}

function licenseStatusLabel(state: LicenseState, t: T) {
  const labels: Record<LicenseState['status'], string> = {
    community: t.communityLicenseStatus,
    licensed: t.licensedStatus,
    over_limit: t.overLimitStatus,
    invalid: t.invalidLicenseStatus,
    expired: t.expiredLicenseStatus,
    missing_public_key: t.missingPublicKeyStatus,
  }
  return labels[state.status]
}

function licensePlanLabel(plan: LicensePlan | undefined, t: T) {
  if (plan === 'free_grant') {
    return t.freeGrantLicense
  }
  return t.paidLicense
}

function dateOnlyLabel(value: string | undefined) {
  return value ? value.slice(0, 10) : ''
}

function displayDateOnlyLabel(value: string | undefined, language: Language) {
  return value ? formatDateKey(dateOnlyLabel(value), language) : ''
}

function requestDateDetail(request: RequestItem, language: Language) {
  if (request.startDate && request.endDate) {
    return formatDateRange(request.startDate, request.endDate, language)
  }
  if (request.correctionDate) {
    return formatDateKey(request.correctionDate, language)
  }
  if (request.minutes) {
    return `${formatDecimalHours(request.minutes)} h`
  }
  return ''
}

function requestDateRange(request: RequestItem) {
  if (request.startDate && request.endDate) {
    return [request.startDate, request.endDate] as const
  }
  const date = (request.correctionDate ?? dateOnlyLabel(request.decidedAt)) || dateOnlyLabel(request.createdAt)
  return [date, date] as const
}

function requestOverlapsDateRange(request: RequestItem, fromDate: string, toDate: string) {
  const [rangeStart, rangeEnd] = requestDateRange(request)
  const filterStart = fromDate && toDate && fromDate > toDate ? toDate : fromDate
  const filterEnd = fromDate && toDate && fromDate > toDate ? fromDate : toDate

  if (!filterStart && !filterEnd) {
    return true
  }
  if (filterStart && rangeEnd < filterStart) {
    return false
  }
  if (filterEnd && rangeStart > filterEnd) {
    return false
  }
  return true
}

function requestPrimaryDate(request: RequestItem) {
  return (request.startDate ?? request.correctionDate ?? dateOnlyLabel(request.decidedAt)) || dateOnlyLabel(request.createdAt)
}

function requestSubmittedDate(request: RequestItem, language: Language) {
  return formatDateTime(request.createdAt, language)
}

function requestSortValue(request: RequestItem) {
  return requestPrimaryDate(request) || dateOnlyLabel(request.createdAt)
}

function sortRequestsForAdmin(left: RequestItem, right: RequestItem) {
  if (left.status === 'pending' && right.status !== 'pending') {
    return -1
  }
  if (right.status === 'pending' && left.status !== 'pending') {
    return 1
  }
  if (left.status === 'pending' && right.status === 'pending') {
    return left.createdAt.localeCompare(right.createdAt)
  }

  const leftValue = requestSortValue(left)
  const rightValue = requestSortValue(right)
  return leftValue.localeCompare(rightValue) || right.createdAt.localeCompare(left.createdAt)
}

function displayUserName(user: User | undefined) {
  if (!user) {
    return ''
  }

  const trailingRole = user.role === 'employee' ? /\s+(Employee|Mitarbeiter)$/i : /\s+(Admin|Administrator)$/i
  const cleanedName = user.name.replace(trailingRole, '').trim()
  return cleanedName || user.name
}

function clockLabel(status: ClockStatus, t: T) {
  if (status === 'working') {
    return t.working
  }
  if (status === 'on_break') {
    return t.onBreak
  }
  return t.offWork
}

function workLocationLabel(location: WorkLocation | undefined, t: T) {
  const labels: Record<WorkLocation, string> = {
    office: t.officeLocation,
    homeoffice: t.homeofficeLocation,
    remote: t.remoteLocation,
    customer: t.customerLocation,
    business_trip: t.businessTripLocation,
  }
  return location ? labels[location] : ''
}

function workLocationOptions(t: T): SelectOption[] {
  const locations: WorkLocation[] = ['office', 'homeoffice', 'remote', 'customer', 'business_trip']
  return locations.map((location) => ({ value: location, label: workLocationLabel(location, t) }))
}

function isWorkLocation(value: string | null): value is WorkLocation {
  return value === 'office' || value === 'homeoffice' || value === 'remote' || value === 'customer' || value === 'business_trip'
}

function clockStatusWithLocation(status: ClockStatus, location: WorkLocation | undefined, t: T) {
  const locationLabel = visibleClockStatus(status) ? workLocationLabel(location, t) : ''
  return [clockLabel(status, t), locationLabel].filter(Boolean).join(' · ')
}

function holidayDisplayName(holiday: Holiday, language: Language) {
  void language
  return holiday.name
}

function holidayDisplayLabel(holiday: Holiday, language: Language) {
  const name = holidayDisplayName(holiday, language)
  return holiday.freePercent === 100 ? name : `${name} (${formatShownNumber(holiday.freePercent)}%)`
}

function durationBetweenMs(startedAt: string, stoppedAt: string | undefined, now: Date) {
  const start = new Date(startedAt).getTime()
  const stop = stoppedAt ? new Date(stoppedAt).getTime() : now.getTime()
  return Math.max(0, stop - start)
}

function entryElapsedMs(entry: TimeEntry | undefined, now: Date) {
  if (!entry) {
    return 0
  }

  return durationBetweenMs(entry.startedAt, entry.stoppedAt, now)
}

function entryBreakMs(entry: TimeEntry | undefined, now: Date) {
  if (!entry) {
    return 0
  }

  const trackedBreakMs = entry.breaks.reduce(
    (total, segment) => total + durationBetweenMs(segment.startedAt, segment.stoppedAt, now),
    0,
  )
  return trackedBreakMs + (entry.manualBreakMinutes ?? 0) * 60_000
}

function entryWorkedMs(entry: TimeEntry | undefined, now: Date) {
  if (!entry) {
    return 0
  }

  if (entry.source === 'zeitguru' && entry.zeitguru) return entry.zeitguru.workedMinutes * 60_000
  return Math.max(0, entryElapsedMs(entry, now) - entryBreakMs(entry, now))
}

function workedMsForEntries(entries: TimeEntry[], userId: string, startDate: string, endDate: string, now: Date) {
  return entries
    .filter((entry) => entry.userId === userId && entry.date >= startDate && entry.date <= endDate)
    .reduce((total, entry) => total + entryWorkedMs(entry, now), 0)
}

function breakMsForEntries(entries: TimeEntry[], userId: string, startDate: string, endDate: string, now: Date) {
  return entries
    .filter((entry) => entry.userId === userId && entry.date >= startDate && entry.date <= endDate)
    .reduce((total, entry) => total + entryBreakMs(entry, now), 0)
}

function closedWorkedMsForEntries(entries: TimeEntry[], userId: string, startDate: string, endDate: string) {
  return entries
    .filter((entry) => entry.userId === userId && entry.date >= startDate && entry.date <= endDate && entry.stoppedAt)
    .reduce((total, entry) => total + entryWorkedMs(entry, new Date(entry.stoppedAt!)), 0)
}

function periodViewTotals(state: StatePayload, user: User, entries: TimeEntry[], start: string, end: string, now: Date) {
  const context = state.zeitguruAccounting?.[user.id]
  if (!context) {
    const workedMs = workedMsForEntries(entries, user.id, start, end, now)
    const expectedMs = expectedMsForRange(user, state.absences, state.holidays, start, end)
    return { workedMs, expectedMs, balanceMs: workedMs - expectedMs - balanceDeductionsForRange(state.requests, user.id, start, end) * 60_000 }
  }
  const totals = periodTotalsWithAccounting(user, entries, state.absences, state.holidays, start, end, context, { now, requests: state.requests })
  // Only live native work outside preserved source days can extend a period preview.
  const liveMs = entries.filter(entry => entry.userId === user.id && entry.source !== 'zeitguru' && !entry.stoppedAt && entry.date >= start && entry.date <= end && !accountingDay(context, entry.date))
    .reduce((sum, entry) => sum + entryWorkedMs(entry, now), 0)
  return { workedMs: totals.workedMinutes * 60_000 + liveMs, expectedMs: totals.expectedMinutes * 60_000, balanceMs: totals.plusMinusMinutes * 60_000 + liveMs }
}

function freePercentToFraction(percent: number | undefined) {
  if (!Number.isFinite(percent)) {
    return 1
  }
  return Math.min(1, Math.max(0, Number(percent) / 100))
}

function expectedMsForRange(
  user: User,
  absences: StatePayload['absences'],
  holidays: Holiday[],
  startDate: string,
  endDate: string,
  options: { entriesForClosedTodayCheck?: TimeEntry[] } = {},
) {
  const effectiveStartDate = user.trackingStartDate && user.trackingStartDate > startDate ? user.trackingStartDate : startDate
  if (effectiveStartDate > endDate) {
    return 0
  }

  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]))
  const absenceDates = new Set(
    absences
      .filter((absence) => absence.userId === user.id && absence.date >= effectiveStartDate && absence.date <= endDate)
      .map((absence) => absence.date),
  )
  const closedEntryDates = options.entriesForClosedTodayCheck
    ? new Set(
        options.entriesForClosedTodayCheck
          .filter((entry) => entry.userId === user.id && entry.stoppedAt && entry.date >= effectiveStartDate && entry.date <= endDate)
          .map((entry) => entry.date),
      )
    : undefined
  const today = closedEntryDates ? businessDateKey() : undefined

  return dateKeysBetween(effectiveStartDate, endDate).reduce((total, date) => {
    if (isWeekend(date) || absenceDates.has(date)) {
      return total
    }
    if (date === today && !closedEntryDates?.has(date)) {
      return total
    }

    const dailyMs = (termForDate(user, date).expectedWeeklyMinutes / 5) * 60_000
    const holiday = holidayByDate.get(date)
    const expectedFraction = holiday ? 1 - freePercentToFraction(holiday.freePercent) : 1
    return total + dailyMs * expectedFraction
  }, 0)
}

function workOverviewDateRange(period: WorkOverviewPeriod, dateKey: string) {
  const reference = parseDateKey(dateKey)
  if (period === 'week') {
    return clampDateRange(startOfWeek(reference), endOfWeek(reference))
  }
  if (period === 'month') {
    return clampDateRange(startOfMonth(reference), endOfMonth(reference))
  }
  return [dateKey, dateKey] as const
}

function shiftWorkOverviewDate(dateKey: string, period: WorkOverviewPeriod, direction: -1 | 1) {
  const date = parseDateKey(dateKey)
  if (period === 'month') {
    date.setMonth(date.getMonth() + direction)
  } else {
    date.setDate(date.getDate() + (period === 'week' ? 7 : 1) * direction)
  }
  return toDateKey(date)
}

function vacationUsedDaysForYear(user: User, absences: StatePayload['absences'], holidays: Holiday[], year: number) {
  const counted = new Set<string>()
  const holidayByDate = new Map(holidays.map((holiday) => [holiday.date, holiday]))
  return absences.reduce((total, absence) => {
    if (absence.userId !== user.id || absence.type !== 'vacation' || !absence.date.startsWith(`${year}-`) || isWeekend(absence.date)) {
      return total
    }

    if (counted.has(absence.date)) return total
    counted.add(absence.date)
    const holiday = holidayByDate.get(absence.date)
    return total + (holiday ? 1 - freePercentToFraction(holiday.freePercent) : 1)
  }, 0)
}

function clockActivityEventsForEntries(entries: TimeEntry[], userId: string) {
  const events: ClockActivityEvent[] = []

  for (const entry of entries.filter((candidate) => candidate.userId === userId && candidate.source !== 'zeitguru')) {
    events.push({ id: `${entry.id}-start`, action: 'start_work', at: entry.startedAt })

    for (const segment of entry.breaks) {
      events.push({ id: `${entry.id}-${segment.id}-start`, action: 'start_break', at: segment.startedAt })
      if (segment.stoppedAt) {
        events.push({ id: `${entry.id}-${segment.id}-stop`, action: 'stop_break', at: segment.stoppedAt })
      }
    }

    if (entry.stoppedAt) {
      events.push({ id: `${entry.id}-stop`, action: 'stop_work', at: entry.stoppedAt })
    }
  }

  return events.sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
}

function clockActivityDateKey(event: ClockActivityEvent) {
  return businessDateKey(new Date(event.at))
}

function clockActionLabel(action: ClockAction, t: T) {
  const labels: Record<ClockAction, string> = {
    start_work: t.startWork,
    start_break: t.startBreak,
    stop_break: t.stopBreak,
    stop_work: t.stopWork,
  }
  return labels[action]
}

function ClockActionIcon({ action, size = 18 }: { action: ClockAction; size?: number }) {
  if (action === 'start_break') {
    return <Coffee size={size} />
  }
  if (action === 'stop_break') {
    return <BriefcaseBusiness size={size} />
  }
  if (action === 'stop_work') {
    return <LogOut size={size} />
  }
  return <BriefcaseBusiness size={size} />
}

function ClockStatusIcon({ status, size = 16 }: { status: ClockStatus; size?: number }) {
  if (status === 'on_break') {
    return <Coffee size={size} />
  }
  if (status === 'working') {
    return <BriefcaseBusiness size={size} />
  }
  return <Timer size={size} />
}

function ClockActionButton({
  action,
  className,
  disabled,
  t,
  onClick,
}: {
  action: ClockAction
  className: string
  disabled: boolean
  t: T
  onClick: () => void
}) {
  const label = clockActionLabel(action, t)
  return (
    <button
      aria-label={label}
      disabled={disabled}
      className={classNames(className, 'clock-action-button', action)}
      title={label}
      type="button"
      onClick={onClick}
    >
      <ClockActionIcon action={action} size={24} />
      <span>{label}</span>
    </button>
  )
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`
}

function formatSignedDuration(milliseconds: number) {
  return `${milliseconds >= 0 ? '+' : '-'}${formatDuration(Math.abs(milliseconds))}`
}

function formatDateTime(value: string, language: Language) {
  return new Date(value).toLocaleString(localeFor(language), {
    timeZone: organizationTimezone(),
    dateStyle: 'short',
    timeStyle: 'medium',
  })
}

function formatDateKey(value: string | undefined, language: Language) {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat(localeFor(language), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(parseDateKey(value))
}

function formatDateRange(startDate: string | undefined, endDate: string | undefined, language: Language) {
  if (startDate && endDate) {
    return startDate === endDate ? formatDateKey(startDate, language) : `${formatDateKey(startDate, language)} - ${formatDateKey(endDate, language)}`
  }
  return startDate ? formatDateKey(startDate, language) : endDate ? formatDateKey(endDate, language) : ''
}

function parseDisplayDateInput(value: string) {
  const trimmed = value.trim()
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  const dayFirstMatch = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  const match = isoMatch
    ? { year: Number(isoMatch[1]), month: Number(isoMatch[2]), day: Number(isoMatch[3]) }
    : dayFirstMatch
      ? { year: Number(dayFirstMatch[3]), month: Number(dayFirstMatch[2]), day: Number(dayFirstMatch[1]) }
      : undefined

  if (!match || match.month < 1 || match.month > 12 || match.day < 1 || match.day > 31) {
    return undefined
  }

  const date = new Date(match.year, match.month - 1, match.day)
  if (date.getFullYear() !== match.year || date.getMonth() !== match.month - 1 || date.getDate() !== match.day) {
    return undefined
  }
  return toDateKey(date)
}

function parseMonthInput(value: string) {
  const trimmed = value.trim()
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})$/)
  const numericMatch = trimmed.match(/^(\d{1,2})[./-](\d{4})$/)
  const match = isoMatch
    ? { year: Number(isoMatch[1]), month: Number(isoMatch[2]) }
    : numericMatch
      ? { year: Number(numericMatch[2]), month: Number(numericMatch[1]) }
      : undefined

  if (!match || match.month < 1 || match.month > 12) {
    return undefined
  }

  return toDateKey(new Date(match.year, match.month - 1, 1))
}

function parseYearInput(value: string) {
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{4})$/)
  if (!match) {
    return undefined
  }

  return toDateKey(new Date(Number(match[1]), 0, 1))
}

function normalizeDateFieldValue(dateKey: string, mode: DateFieldSelectionMode) {
  const parsed = parseDateKey(dateKey)
  if (mode === 'year') {
    return toDateKey(new Date(parsed.getFullYear(), 0, 1))
  }
  if (mode === 'month') {
    return toDateKey(new Date(parsed.getFullYear(), parsed.getMonth(), 1))
  }
  if (mode === 'week') {
    return toDateKey(startOfWeek(parsed))
  }
  return dateKey
}

function parseDateFieldInput(value: string, mode: DateFieldSelectionMode) {
  if (mode === 'year') {
    return parseYearInput(value)
  }
  if (mode === 'month') {
    return parseMonthInput(value)
  }
  const parsed = parseDisplayDateInput(value)
  return parsed ? normalizeDateFieldValue(parsed, mode) : undefined
}

function dateFieldDisplayValue(value: string, language: Language, mode: DateFieldSelectionMode) {
  if (mode === 'year') {
    return String(parseDateKey(value).getFullYear())
  }
  if (mode === 'month') {
    return currentMonthTitle(parseDateKey(value), language)
  }
  if (mode === 'week') {
    return calendarPeriodTitle('week', value, language)
  }
  return formatDateKey(value, language)
}

function dateFieldPlaceholder(language: Language, mode: DateFieldSelectionMode) {
  if (mode === 'year') {
    return language === 'de' ? 'JJJJ' : 'YYYY'
  }
  if (mode === 'month') {
    return language === 'de' ? 'MM.JJJJ' : 'MM/YYYY'
  }
  return language === 'de' ? 'TT.MM.JJJJ' : 'DD/MM/YYYY'
}

function useLiveNow(enabled: boolean) {
  const [now, setNow] = useState(() => serverClock.now())

  useEffect(() => {
    const update = () => setNow(serverClock.now())
    const unsubscribe = serverClock.subscribe(update)
    update()
    const interval = enabled ? window.setInterval(update, 1000) : undefined
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(interval)
      unsubscribe()
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [enabled])

  return now
}

function localeFor(language: Language) {
  return language === 'de' ? 'de-DE' : 'en-GB'
}

function currentMonthTitle(date: Date, language: Language) {
  return date.toLocaleDateString(localeFor(language), { month: 'long', year: 'numeric' })
}

function monthKeyForDate(dateKey: string) {
  const parsed = parseDisplayDateInput(dateKey) ?? businessDateKey()
  const date = parseDateKey(parsed)
  return toDateKey(new Date(date.getFullYear(), date.getMonth(), 1))
}

function yearPanelStart(year: number) {
  return year - 5
}

function yearRangeTitle(year: number) {
  const start = yearPanelStart(year)
  return `${start} - ${start + 11}`
}

function yearsForPanel(year: number) {
  const start = yearPanelStart(year)
  return Array.from({ length: 12 }, (_, index) => toDateKey(new Date(start + index, 0, 1)))
}

function shiftMonthKey(dateKey: string, direction: number) {
  const date = parseDateKey(monthKeyForDate(dateKey))
  return toDateKey(new Date(date.getFullYear(), date.getMonth() + direction, 1))
}

function panelKeyForDateField(dateKey: string, mode: DateFieldSelectionMode) {
  if (mode === 'year') {
    const date = parseDateKey(dateKey)
    return toDateKey(new Date(date.getFullYear(), 0, 1))
  }
  if (mode === 'month') {
    const date = parseDateKey(monthKeyForDate(dateKey))
    return toDateKey(new Date(date.getFullYear(), 0, 1))
  }
  return monthKeyForDate(dateKey)
}

function shiftDateFieldPanel(dateKey: string, mode: DateFieldSelectionMode, direction: number) {
  if (mode === 'year') {
    const date = parseDateKey(panelKeyForDateField(dateKey, mode))
    return toDateKey(new Date(date.getFullYear() + direction * 12, 0, 1))
  }
  if (mode === 'month') {
    const date = parseDateKey(panelKeyForDateField(dateKey, mode))
    return toDateKey(new Date(date.getFullYear() + direction, 0, 1))
  }
  return shiftMonthKey(dateKey, direction)
}

function monthsForYear(year: number) {
  return Array.from({ length: 12 }, (_, month) => toDateKey(new Date(year, month, 1)))
}

function dateFieldNavigationTitle(mode: DateFieldSelectionMode, language: Language, direction: -1 | 1) {
  if (mode === 'year') {
    return language === 'de'
      ? direction < 0
        ? 'Vorherige Jahre'
        : 'Nächste Jahre'
      : direction < 0
        ? 'Previous years'
        : 'Next years'
  }
  if (mode === 'month') {
    return language === 'de'
      ? direction < 0
        ? 'Vorheriges Jahr'
        : 'Nächstes Jahr'
      : direction < 0
        ? 'Previous year'
        : 'Next year'
  }

  return language === 'de'
    ? direction < 0
      ? 'Vorheriger Monat'
      : 'Nächster Monat'
    : direction < 0
      ? 'Previous month'
      : 'Next month'
}

function firstCalendarDay(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7
  first.setDate(first.getDate() - offset)
  return first
}

function buildCalendarDays(month: Date) {
  const start = firstCalendarDay(month)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return toDateKey(date)
  })
}

function buildWeekDays(dateKey: string) {
  const start = startOfWeek(parseDateKey(dateKey))
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return toDateKey(date)
  })
}

function calendarDaysForMode(mode: CalendarViewMode, dateKey: string) {
  if (mode === 'day') {
    return [dateKey]
  }
  if (mode === 'week') {
    return buildWeekDays(dateKey)
  }
  return buildCalendarDays(parseDateKey(dateKey))
}

function shiftCalendarDate(dateKey: string, mode: CalendarViewMode, direction: number) {
  if (mode === 'day') {
    return addDays(dateKey, direction)
  }
  if (mode === 'week') {
    return addDays(dateKey, direction * 7)
  }
  const date = parseDateKey(dateKey)
  return toDateKey(new Date(date.getFullYear(), date.getMonth() + direction, 1))
}

function calendarPeriodTitle(mode: CalendarViewMode, dateKey: string, language: Language) {
  const date = parseDateKey(dateKey)
  if (mode === 'month') {
    return currentMonthTitle(date, language)
  }
  if (mode === 'day') {
    return date.toLocaleDateString(localeFor(language), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  }

  const weekDays = buildWeekDays(dateKey)
  const formatter = new Intl.DateTimeFormat(localeFor(language), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  return `${formatter.format(parseDateKey(weekDays[0]))} - ${formatter.format(parseDateKey(weekDays[6]))}`
}

function calendarModeLabel(mode: CalendarViewMode, t: T) {
  if (mode === 'day') {
    return t.day
  }
  if (mode === 'week') {
    return t.week
  }
  return t.month
}

function weekdayHeadersForMode(mode: CalendarViewMode, days: string[], language: Language) {
  if (mode === 'month') {
    return language === 'de'
      ? ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  }

  const formatter = new Intl.DateTimeFormat(localeFor(language), {
    weekday: mode === 'day' ? 'long' : 'short',
  })
  return days.map((date) => formatter.format(parseDateKey(date)))
}

const tabRouteSegments: Record<Tab, string> = {
  dashboard: '',
  calendar: 'calendar',
  requests: 'requests',
  adminCalendar: 'admin-calendar',
  adminUsers: 'users',
  adminGroups: 'groups',
  adminFreeDays: 'free-days',
  adminSettings: 'settings',
}

const tabFromRouteSegment: Record<string, Tab> = {
  calendar: 'calendar',
  requests: 'requests',
  'admin-calendar': 'adminCalendar',
  users: 'adminUsers',
  groups: 'adminGroups',
  'free-days': 'adminFreeDays',
  settings: 'adminSettings',
}

function appBaseUrlPath() {
  const base = new URL(appBasePath, window.location.origin).pathname
  return base.endsWith('/') ? base : `${base}/`
}

function appRelativePath() {
  const base = appBaseUrlPath()
  const path = window.location.pathname
  const baseWithoutSlash = base.replace(/\/+$/, '')
  if (baseWithoutSlash && path === baseWithoutSlash) {
    return ''
  }
  if (base !== '/' && path.startsWith(base)) {
    return path.slice(base.length).replace(/^\/+/, '')
  }
  if (baseWithoutSlash && path.startsWith(`${baseWithoutSlash}/`)) {
    return path.slice(baseWithoutSlash.length + 1).replace(/^\/+/, '')
  }
  return path.replace(/^\/+/, '')
}

function tabRoutePath(tab: Tab) {
  const segment = tabRouteSegments[tab]
  return segment ? `${appBaseUrlPath()}${segment}` : appBaseUrlPath()
}

function tabAllowedForRole(tab: Tab, role: User['role']) {
  return !tab.startsWith('admin') || role === 'admin'
}

function tabFromUrl(role: User['role']): Tab | undefined {
  const pathSegment = appRelativePath().split('/').filter(Boolean)[0]
  const pathTab = pathSegment ? tabFromRouteSegment[pathSegment] : undefined
  if (pathTab && tabAllowedForRole(pathTab, role)) {
    return pathTab
  }

  const params = new URLSearchParams(window.location.search)
  const requestedTab = params.get('tab')

  if (params.has('request')) {
    return 'requests'
  }

  if (requestedTab === 'dashboard' || requestedTab === 'calendar' || requestedTab === 'requests') {
    return requestedTab
  }

  if (
    role === 'admin' &&
    (requestedTab === 'adminUsers' ||
      requestedTab === 'adminCalendar' ||
      requestedTab === 'adminGroups' ||
      requestedTab === 'adminFreeDays' ||
      requestedTab === 'adminSettings')
  ) {
    return requestedTab
  }

  return pathSegment ? undefined : 'dashboard'
}

function requestIdFromUrl() {
  return new URLSearchParams(window.location.search).get('request') ?? ''
}

function invitationTokenFromUrl() {
  const pathParts = appRelativePath().split('/').filter(Boolean)
  return pathParts[0] === 'invite' && pathParts[1]
    ? decodeURIComponent(pathParts[1])
    : new URLSearchParams(window.location.search).get('invite') ?? ''
}

function passwordResetTokenFromUrl() {
  const pathParts = appRelativePath().split('/').filter(Boolean)
  return pathParts[0] === 'reset' && pathParts[1]
    ? decodeURIComponent(pathParts[1])
    : new URLSearchParams(window.location.search).get('reset') ?? ''
}

function useAuthToken() {
  const [token, setTokenState] = useState(() => {
    if (browserCoreSession) {
      // Older builds copied Core's HttpOnly session into module storage. Discard
      // those copies before any request; only the current Core cookie can sign in.
      localStorage.removeItem(authTokenStorageKey)
      sessionStorage.removeItem(authTokenStorageKey)
      return ''
    }
    return localStorage.getItem(authTokenStorageKey) ?? sessionStorage.getItem(authTokenStorageKey) ?? ''
  })

  const setToken = useCallback((nextToken: string, stayLoggedIn = true) => {
    localStorage.removeItem(authTokenStorageKey)
    sessionStorage.removeItem(authTokenStorageKey)
    if (nextToken && nextToken !== coreCookieSession && !browserCoreSession) {
      const storage = stayLoggedIn ? localStorage : sessionStorage
      storage.setItem(authTokenStorageKey, nextToken)
    }
    setTokenState(nextToken)
  }, [])

  return [token, setToken] as const
}

function sessionHeaders(token: string): Record<string, string> {
  return token && token !== coreCookieSession && !browserCoreSession ? { Authorization: `Bearer ${token}` } : {}
}

function useLanguage() {
  const [language, setLanguageState] = useState<Language>(() => readSuiteLanguage(['time-tracker-language']))

  useEffect(() => {
    const syncLanguage = (event: StorageEvent) => {
      if (event.key === suiteLanguageStorageKey) setLanguageState(readSuiteLanguage(['time-tracker-language']))
    }
    window.addEventListener('storage', syncLanguage)
    return () => window.removeEventListener('storage', syncLanguage)
  }, [])

  const setLanguage = useCallback((nextLanguage: Language) => {
    writeSuiteLanguage(nextLanguage, ['time-tracker-language'])
    setLanguageState(nextLanguage)
  }, [])

  return [language, setLanguage] as const
}

function initialTheme(): Theme {
  return readSuiteTheme(['time-tracker-theme'])
}

function useTheme() {
  const [theme, setThemeState] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === suiteThemeStorageKey) setThemeState(readSuiteTheme(['time-tracker-theme']))
    }
    window.addEventListener('storage', syncTheme)
    return () => window.removeEventListener('storage', syncTheme)
  }, [])

  const setTheme = useCallback((nextTheme: Theme) => {
    writeSuiteTheme(nextTheme, ['time-tracker-theme'])
    setThemeState(nextTheme)
  }, [])

  return [theme, setTheme] as const
}

function liveSocketUrl() {
  const url = new URL(`${apiBase}/api/live`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function parseLiveStateMessage(value: string) {
  try {
    return JSON.parse(value) as { type?: string; payload?: StatePayload; message?: string }
  } catch {
    return undefined
  }
}

function systemNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

async function requestSystemNotificationPermission() {
  if (!systemNotificationsSupported() || Notification.permission !== 'default') {
    return
  }

  try {
    await Notification.requestPermission()
  } catch {
    // Browsers and webviews may reject notification permission prompts.
  }
}

function App({ initialState }: { initialState?: StatePayload | null } = {}) {
  useDisclosureMotion()
  const simpleMode = forcedSimpleMode || window.location.pathname.includes('simple') || window.location.search.includes('simple=1')
  const inviteToken = invitationTokenFromUrl()
  const resetToken = passwordResetTokenFromUrl()
  const [language, setLanguage] = useLanguage()
  const [theme, setTheme] = useTheme()
  const t = translations[language]
  const [token, persistToken] = useAuthToken()
  const backendAuthEpoch = useRef(0)
  const backendSyncInFlight = useRef(false)
  const backendSyncController = useRef<AbortController | undefined>(undefined)
  const cancelBackendSync = useCallback(() => {
    backendSyncController.current?.abort()
    backendSyncController.current = undefined
    backendSyncInFlight.current = false
  }, [])
  const setToken = useCallback((nextToken: string, stayLoggedIn = true) => {
    // A cookie-session marker can be reused for a different account. Fence old
    // HTTP responses and socket events on every explicit session change.
    backendAuthEpoch.current += 1
    cancelBackendSync()
    persistToken(nextToken, stayLoggedIn)
  }, [cancelBackendSync, persistToken])
  const [state, setState] = useState<StatePayload | null>(() => {
    serverClock.synchronize(initialState?.serverTime)
    return initialState ?? null
  })
  if (state?.organizationTimezone) setOrganizationTimezone(state.organizationTimezone)
  const [ssoChecked, setSsoChecked] = useState(Boolean(initialState))
  const [ssoUnavailable, setSsoUnavailable] = useState(false)
  const [invitationPreview, setInvitationPreview] = useState<InvitationPreview | null>(null)
  const [passwordResetPreview, setPasswordResetPreview] = useState<PasswordResetPreview | null>(null)
  const [tab, setTab] = useState<Tab>(simpleMode ? 'dashboard' : 'dashboard')
  const [selectedRequestId, setSelectedRequestId] = useState(() => requestIdFromUrl())
  const [deepLinkApplied, setDeepLinkApplied] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [operationStatus, setOperationStatus] = useState<{ kind: 'pending' | 'success'; message: string } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const latestSyncFailed = useRef(false)
  useEffect(() => { latestSyncFailed.current = Boolean(syncError) }, [syncError])
  const [lastSyncedAt, setLastSyncedAt] = useState<number | undefined>(() => (initialState ? performance.now() : undefined))
  const latestSyncAt = useRef(lastSyncedAt)
  useEffect(() => { latestSyncAt.current = lastSyncedAt }, [lastSyncedAt])
  const operationStatusTimer = useRef<number | undefined>(undefined)
  const pendingClockOperation = useRef<{
    userId: string; action: ClockAction; workLocation?: WorkLocation; clientOperationId: string
    expectedRevision: number; expectedGeneration: number
  } | undefined>(undefined)
  const seenSystemNotificationIds = useRef<Set<string>>(new Set(initialState?.notifications.map((notification) => notification.id) ?? []))
  const seenSystemNotificationUserId = useRef(initialState?.currentUser.id)
  useLiveNow(Boolean(token && state))
  const maxSyncAgeMs = simpleMode ? 45_000 : 90_000
  const syncAgeMs = lastSyncedAt !== undefined ? performance.now() - lastSyncedAt : Number.POSITIVE_INFINITY
  const backendSyncFresh = Boolean(state && lastSyncedAt !== undefined && !syncError && syncAgeMs <= maxSyncAgeMs)
  const backendSyncMessage = syncing ? t.backendSyncing : syncError ? t.backendSyncLost : t.backendSyncStale

  useEffect(() => {
    const pending = pendingClockOperation.current
    if (pending && (pending.userId !== state?.currentUser.id || state?.zeitguru?.latestOperation?.clientOperationId === pending.clientOperationId)) {
      pendingClockOperation.current = undefined
    }
  }, [state?.currentUser.id, state?.zeitguru?.latestOperation?.clientOperationId])

  function showOperationStatus(status: { kind: 'pending' | 'success'; message: string } | null) {
    if (operationStatusTimer.current) {
      window.clearTimeout(operationStatusTimer.current)
      operationStatusTimer.current = undefined
    }
    setOperationStatus(status)
    if (status?.kind === 'success') {
      operationStatusTimer.current = window.setTimeout(() => {
        setOperationStatus(null)
        operationStatusTimer.current = undefined
      }, 1800)
    }
  }

  useEffect(() => () => {
    if (operationStatusTimer.current) {
      window.clearTimeout(operationStatusTimer.current)
    }
  }, [])

  async function api<T>(path: string, options: RequestInit = {}) {
    const authEpoch = backendAuthEpoch.current
    const response = await fetch(`${apiBase}${path}`, {
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...sessionHeaders(token),
        ...options.headers,
      },
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ message: 'Request failed' }))) as ApiError
      // Provider actions can also return 401; only this identity-checked endpoint
      // establishes that the Time session itself was rejected.
      if (path === '/api/state' && authEpoch === backendAuthEpoch.current && (response.status === 401 || response.status === 403)) {
        notifyCoreSessionInvalidated()
        setLastSyncedAt(undefined)
        setSyncError(payload.message)
        if (response.status === 401) {
          setToken(''); setState(null); setSyncing(false); setLoading(false)
        }
      }
      throw Object.assign(new Error(payload.message), { status: response.status })
    }

    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object' && 'serverTime' in payload) serverClock.synchronize(payload.serverTime)
    return payload as T
  }

  const loadBackendState = useCallback(async (options: { showLoading?: boolean; clearOnAuthError?: boolean; preserveError?: boolean; force?: boolean } = {}): Promise<'success' | 'failed' | 'skipped'> => {
    if (!token) {
      return 'skipped'
    }

    if (backendSyncInFlight.current && !options.force) {
      return 'skipped'
    }

    cancelBackendSync()
    const controller = new AbortController()
    backendSyncController.current = controller
    const authEpoch = backendAuthEpoch.current
    const isCurrent = () => backendSyncController.current === controller && backendAuthEpoch.current === authEpoch
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    backendSyncInFlight.current = true
    if (options.showLoading) {
      setLoading(true)
    }
    setSyncing(true)
    try {
      const response = await fetch(`${apiBase}/api/state`, {
        credentials: 'include',
        headers: sessionHeaders(token),
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!isCurrent()) return 'skipped'
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: 'Session expired' }))) as ApiError
        if (!isCurrent()) return 'skipped'
        if (response.status === 401 || response.status === 403) notifyCoreSessionInvalidated()
        if (response.status === 401 && options.clearOnAuthError !== false) {
          setToken('')
          setState(null)
          setLastSyncedAt(undefined)
          setSyncing(false)
          setLoading(false)
          setError(payload.message)
          return 'failed'
        }
        throw new Error(payload.message)
      }
      const payload = (await response.json()) as StatePayload
      if (!isCurrent()) return 'skipped'
      serverClock.synchronize(payload.serverTime)
      setState(payload)
      setLastSyncedAt(performance.now())
      setSyncError('')
      if (!options.preserveError) {
        setError('')
      }
      return 'success'
    } catch (requestError) {
      if (!isCurrent()) return 'skipped'
      const message = requestError instanceof Error ? requestError.message : 'Backend sync failed'
      setSyncError(message)
      if (options.showLoading) {
        setError(message)
      }
      return 'failed'
    } finally {
      window.clearTimeout(timeout)
      if (isCurrent()) {
        backendSyncController.current = undefined
        backendSyncInFlight.current = false
        setSyncing(false)
        if (options.showLoading) setLoading(false)
      }
    }
  }, [cancelBackendSync, setToken, token])

  useEffect(() => cancelBackendSync, [cancelBackendSync, token])

  useEffect(() => {
    if (!token || state) {
      return
    }

    void loadBackendState({ clearOnAuthError: true, preserveError: true, force: true })
  }, [loadBackendState, state, token])

  useEffect(() => {
    if (token || state || inviteToken || resetToken || packagedMobileBuild || ssoChecked) {
      if (token || state || inviteToken || resetToken || packagedMobileBuild) {
        setSsoChecked(true)
      }
      return
    }

    let cancelled = false
    const controller = new AbortController()
    const authEpoch = backendAuthEpoch.current
    const isCurrent = () => !cancelled && authEpoch === backendAuthEpoch.current
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    async function trySsoSession() {
      try {
        const response = await fetch(`${apiBase}/api/sso/session`, {
          cache: 'no-store',
          credentials: 'include',
          signal: controller.signal,
        })
        if (!isCurrent()) return
        if (response.status === 401 || response.status === 403) notifyCoreSessionInvalidated()
        if (response.status === 401) {
          setSsoUnavailable(false)
          return
        }
        if (!response.ok) throw new Error('Session verification unavailable')
        const payload = (await response.json()) as { token: string; stayLoggedIn?: boolean }
        if (!isCurrent()) return
        if (typeof payload.token !== 'string' || !payload.token) throw new Error('Session verification unavailable')
        setSsoUnavailable(false)
        setSsoChecked(true)
        setToken(payload.token, payload.stayLoggedIn === true)
        setError('')
      } catch {
        if (isCurrent()) {
          setSsoUnavailable(true)
        }
      } finally {
        window.clearTimeout(timeout)
        if (isCurrent()) setSsoChecked(true)
      }
    }

    void trySsoSession()
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [inviteToken, resetToken, setToken, simpleMode, ssoChecked, state, token])

  useEffect(() => {
    if (!token) {
      return
    }

    let cancelled = false
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let fallbackTimer: number | undefined
    let authTimer: number | undefined
    let reconnectAttempt = 0
    let failedReads = 0
    let socketDeliveredState = false
    let socketStateAt = 0
    const authEpoch = backendAuthEpoch.current
    const sessionCurrent = () => !cancelled && backendAuthEpoch.current === authEpoch

    function clearReconnect() {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
    }

    function clearFallback() {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer)
        fallbackTimer = undefined
      }
    }

    function clearAuthTimeout() {
      if (authTimer) {
        window.clearTimeout(authTimer)
        authTimer = undefined
      }
    }

    function fallbackInterval() {
      if (document.hidden) {
        return simpleMode ? 30_000 : 45_000
      }
      return simpleMode ? 15_000 : 30_000
    }

    function liveSocketHealthy() {
      return socket?.readyState === WebSocket.OPEN && socketDeliveredState && performance.now() - socketStateAt < 40_000
    }

    function scheduleFallback(delay = 0) {
      clearFallback()
      fallbackTimer = window.setTimeout(() => {
        void syncByHttpFallback()
      }, delay)
    }

    async function syncByHttpFallback() {
      if (!sessionCurrent()) return
      if (liveSocketHealthy()) {
        scheduleFallback(fallbackInterval())
        return
      }
      if (socket?.readyState === WebSocket.OPEN && socketDeliveredState) {
        closeSocket()
        scheduleReconnect()
      }
      const result = await loadBackendState({ clearOnAuthError: true, preserveError: true })
      if (result === 'failed') failedReads += 1
      if (result === 'success') failedReads = 0
      if (sessionCurrent()) {
        scheduleFallback(failedReads ? syncRetryDelay(failedReads) : fallbackInterval())
      }
    }

    function scheduleReconnect() {
      clearReconnect()
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5))
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(connectLiveSocket, delay)
    }

    function closeSocket() {
      if (!socket) {
        return
      }
      const currentSocket = socket
      socket = undefined
      try {
        currentSocket.close()
      } catch {
        // Ignore close races from browsers that already dropped the socket.
      }
    }

    function connectLiveSocket() {
      if (!sessionCurrent()) {
        return
      }

      closeSocket()
      clearAuthTimeout()
      socketDeliveredState = false

      try {
        const nextSocket = new WebSocket(liveSocketUrl())
        socket = nextSocket
        const current = () => sessionCurrent() && socket === nextSocket
        const fallBack = () => {
          if (!current()) return
          clearAuthTimeout()
          socketDeliveredState = false
          closeSocket()
          // A blocked WebSocket is only a transport failure. Authenticated HTTP
          // polling owns its own error state and can keep the clock up to date.
          scheduleFallback(0)
          scheduleReconnect()
        }

        authTimer = window.setTimeout(() => {
          if (current() && !socketDeliveredState) fallBack()
        }, 7000)

        nextSocket.addEventListener('open', () => {
          if (!current()) return
          nextSocket.send(JSON.stringify({ type: 'auth', token }))
        })

        nextSocket.addEventListener('message', (event) => {
          if (!current()) return
          const message = parseLiveStateMessage(String(event.data))
          if (message?.type === 'state' && message.payload) {
            serverClock.synchronize(message.payload.serverTime)
            socketDeliveredState = true
            socketStateAt = performance.now()
            reconnectAttempt = 0
            failedReads = 0
            clearAuthTimeout()
            scheduleFallback(fallbackInterval())
            cancelBackendSync()
            setState(message.payload)
            setLastSyncedAt(performance.now())
            setSyncError('')
            setSyncing(false)
            return
          }

          if (message?.type === 'heartbeat' && socketDeliveredState) {
            // Heartbeats prove transport liveness only. The refreshed state
            // revalidates the Core session and supplies a real freshness time.
            nextSocket.send(JSON.stringify({ type: 'refresh' }))
          }
        })

        nextSocket.addEventListener('close', fallBack)
        nextSocket.addEventListener('error', fallBack)
      } catch {
        closeSocket()
        clearAuthTimeout()
        scheduleFallback(0)
        scheduleReconnect()
      }
    }

    function syncSoon() {
      if (!sessionCurrent()) return
      if (liveSocketHealthy()) {
        socket?.send(JSON.stringify({ type: 'refresh' }))
        return
      }
      scheduleFallback(0)
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        scheduleReconnect()
      }
    }

    function syncWhenVisible() {
      if (document.hidden) return
      // Switching tabs must not duplicate a recent state update. Catch up when
      // returning after browser background throttling or sleep instead.
      if (!latestSyncFailed.current && latestSyncAt.current !== undefined && performance.now() - latestSyncAt.current < (simpleMode ? 15_000 : 30_000)) return
      syncSoon()
    }

    connectLiveSocket()
    scheduleFallback(0)
    window.addEventListener('online', syncSoon)
    window.addEventListener('focus', syncWhenVisible)
    window.addEventListener('pageshow', syncWhenVisible)
    document.addEventListener('visibilitychange', syncWhenVisible)

    return () => {
      cancelled = true
      clearReconnect()
      clearFallback()
      clearAuthTimeout()
      closeSocket()
      window.removeEventListener('online', syncSoon)
      window.removeEventListener('focus', syncWhenVisible)
      window.removeEventListener('pageshow', syncWhenVisible)
      document.removeEventListener('visibilitychange', syncWhenVisible)
    }
  }, [cancelBackendSync, loadBackendState, token, simpleMode])

  useEffect(() => {
    if (!inviteToken) {
      return
    }

    let cancelled = false

    async function loadInvitation() {
      setLoading(true)
      try {
        const response = await fetch(`${apiBase}/api/invitations/${encodeURIComponent(inviteToken)}`)
        if (!response.ok) {
          const body = (await response.json().catch(() => ({ message: t.invalidInvite }))) as ApiError
          throw new Error(body.message)
        }
        const preview = (await response.json()) as InvitationPreview
        if (!cancelled) {
          setInvitationPreview(preview)
          setError('')
        }
      } catch (requestError) {
        if (!cancelled) {
          setInvitationPreview(null)
          setError(requestError instanceof Error ? requestError.message : t.invalidInvite)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadInvitation()

    return () => {
      cancelled = true
    }
  }, [inviteToken, t.invalidInvite])

  useEffect(() => {
    if (!resetToken) {
      return
    }

    let cancelled = false

    async function loadPasswordReset() {
      setLoading(true)
      try {
        const response = await fetch(`${apiBase}/api/password-reset/${encodeURIComponent(resetToken)}`)
        if (!response.ok) {
          const body = (await response.json().catch(() => ({ message: t.resetLinkInvalid }))) as ApiError
          throw new Error(body.message)
        }
        const preview = (await response.json()) as PasswordResetPreview
        if (!cancelled) {
          setPasswordResetPreview(preview)
          setError('')
        }
      } catch (requestError) {
        if (!cancelled) {
          setPasswordResetPreview(null)
          setError(requestError instanceof Error ? requestError.message : t.resetLinkInvalid)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadPasswordReset()

    return () => {
      cancelled = true
    }
  }, [resetToken, t.resetLinkInvalid])

  useEffect(() => {
    if (simpleMode || !state || deepLinkApplied) {
      return
    }

    const linkedTab = tabFromUrl(state.currentUser.role)
    if (linkedTab) {
      setTab(linkedTab)
    }
    setSelectedRequestId(requestIdFromUrl())
    setDeepLinkApplied(true)
  }, [deepLinkApplied, simpleMode, state])

  useEffect(() => {
    if (simpleMode || !state) {
      return undefined
    }

    function applyRoute() {
      const linkedTab = tabFromUrl(state!.currentUser.role) ?? 'dashboard'
      setTab(linkedTab)
      setSelectedRequestId(requestIdFromUrl())
    }

    window.addEventListener('popstate', applyRoute)
    return () => window.removeEventListener('popstate', applyRoute)
  }, [simpleMode, state])

  function openNotificationTarget(notification: StatePayload['notifications'][number]) {
    if (notification.linkType === 'request' && notification.linkId) {
      setTab('requests')
      setSelectedRequestId(notification.linkId)
      const nextUrl = `${tabRoutePath('requests')}?request=${encodeURIComponent(notification.linkId)}`
      if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
        window.history.pushState({}, '', nextUrl)
      }
      return
    }

    if (notification.linkType === 'calendar') {
      navigateToTab('calendar')
      return
    }

    navigateToTab('dashboard')
  }

  function showSystemNotification(notification: StatePayload['notifications'][number]) {
    if (!systemNotificationsSupported() || Notification.permission !== 'granted') {
      return
    }

    const systemNotification = new Notification(notification.title, {
      body: notification.message,
      tag: notification.id,
    })
    systemNotification.onclick = () => {
      window.focus()
      openNotificationTarget(notification)
      systemNotification.close()
    }
  }

  useEffect(() => {
    if (!state) {
      seenSystemNotificationIds.current = new Set()
      seenSystemNotificationUserId.current = undefined
      return
    }

    if (seenSystemNotificationUserId.current !== state.currentUser.id) {
      seenSystemNotificationIds.current = new Set(state.notifications.map((notification) => notification.id))
      seenSystemNotificationUserId.current = state.currentUser.id
      return
    }

    for (const notification of state.notifications) {
      if (seenSystemNotificationIds.current.has(notification.id)) {
        continue
      }
      seenSystemNotificationIds.current.add(notification.id)
      if (!notification.read) {
        showSystemNotification(notification)
      }
    }
  }, [state])

  function navigateToTab(nextTab: Tab) {
    setTab(nextTab)
    setSelectedRequestId('')
    const nextUrl = tabRoutePath(nextTab)
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.pushState({}, '', nextUrl)
    }
  }

  async function openSuiteModule(event: ReactMouseEvent<HTMLAnchorElement>, targetUrl: string) {
    event.preventDefault()
    if (!token || state?.coreManaged) {
      window.location.assign(targetUrl)
      return
    }

    try {
      const stayLoggedIn = localStorage.getItem(authTokenStorageKey) === token
      const response = await fetch(`${apiBase}/api/sso/promote`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...sessionHeaders(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stayLoggedIn }),
      })
      if (!response.ok) {
        throw new Error(language === 'de' ? 'Die systemweite Anmeldung konnte nicht vorbereitet werden.' : 'Could not prepare suite sign-in.')
      }
      window.location.assign(targetUrl)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not prepare suite sign-in.')
    }
  }

  async function login(email: string, password: string, stayLoggedIn: boolean) {
    setLoading(true)
    try {
      const payload = await fetch(`${apiBase}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, stayLoggedIn, ...(packagedMobileBuild ? { clientType: 'native' } : {}) }),
      })
      if (!payload.ok) {
        const body = (await payload.json().catch(() => ({ message: 'Login failed' }))) as ApiError
        throw new Error(body.message)
      }

      const body = (await payload.json()) as { token: string }
      setToken(body.token, stayLoggedIn)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    setLoading(true)
    try {
      const response = await fetch(`${apiBase}/api/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: sessionHeaders(token),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as ApiError
        throw new Error(payload.message || (language === 'de' ? 'Abmelden fehlgeschlagen. Bitte versuche es erneut.' : 'Sign-out failed. Please try again.'))
      }
      setToken('')
      setState(null)
      setLastSyncedAt(undefined)
      setSyncError('')
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sign-out failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function requestPasswordReset(email: string) {
    setLoading(true)
    try {
      const payload = await fetch(`${apiBase}/api/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!payload.ok) {
        const body = (await payload.json().catch(() => ({ message: 'Password reset failed' }))) as ApiError
        throw new Error(body.message)
      }

      setError('')
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password reset failed')
      return false
    } finally {
      setLoading(false)
    }
  }

  async function completePasswordReset(password: string, passwordConfirm: string) {
    setLoading(true)
    try {
      const payload = await fetch(`${apiBase}/api/password-reset/${encodeURIComponent(resetToken)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, passwordConfirm }),
      })
      if (!payload.ok) {
        const body = (await payload.json().catch(() => ({ message: 'Password reset failed' }))) as ApiError
        throw new Error(body.message)
      }

      const body = (await payload.json()) as { token: string }
      window.history.replaceState({}, '', appBasePath)
      setToken(body.token)
      setPasswordResetPreview(null)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password reset failed')
    } finally {
      setLoading(false)
    }
  }

  async function acceptInvitation(password: string, passwordConfirm: string) {
    setLoading(true)
    try {
      const payload = await fetch(`${apiBase}/api/invitations/${encodeURIComponent(inviteToken)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, passwordConfirm }),
      })
      if (!payload.ok) {
        const body = (await payload.json().catch(() => ({ message: 'Invitation failed' }))) as ApiError
        throw new Error(body.message)
      }

      const body = (await payload.json()) as { token: string }
      window.history.replaceState({}, '', appBasePath)
      setToken(body.token)
      setError('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Invitation failed')
    } finally {
      setLoading(false)
    }
  }

  async function changePassword(currentPassword: string, password: string, passwordConfirm: string): MutationResult {
    setLoading(true)
    showOperationStatus({ kind: 'pending', message: t.savingChanges })
    try {
      const payload = await api<StatePayload & { requiresSignIn?: boolean }>('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, password, passwordConfirm }),
      })
      if (payload.requiresSignIn) {
        setToken('')
        setState(null)
        setSsoChecked(true)
        setError(language === 'de' ? 'Passwort geändert. Bitte melde dich erneut an.' : 'Password changed. Please sign in again.')
      } else {
        setState(payload)
        setError('')
      }
      showOperationStatus({ kind: 'success', message: t.changesSaved })
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password change failed')
      showOperationStatus(null)
      return false
    } finally {
      setLoading(false)
    }
  }

  async function updateState(path: string, options: RequestInit, onFailure?: (failure: unknown) => void): MutationResult {
    const authEpoch = backendAuthEpoch.current
    setLoading(true)
    showOperationStatus({ kind: 'pending', message: t.savingChanges })
    try {
      const payload = await api<StatePayload>(path, options)
      if (backendAuthEpoch.current !== authEpoch) return false
      cancelBackendSync()
      setSyncing(false)
      setState(payload)
      setLastSyncedAt(performance.now())
      setSyncError('')
      setError('')
      showOperationStatus({ kind: 'success', message: path === '/api/clock' ? t.clockSaved : t.changesSaved })
      return true
    } catch (requestError) {
      if (backendAuthEpoch.current !== authEpoch) return false
      onFailure?.(requestError)
      const message = requestError instanceof Error ? requestError.message : 'Request failed'
      setError(message)
      // A 4xx response proves the server was reached. Reconcile the rejected
      // action without falsely reporting a lost connection or replaying it.
      setLastSyncedAt(undefined)
      if (!isDefinitiveActionRejection(requestError)) setSyncError(message)
      showOperationStatus(null)
      await loadBackendState({ clearOnAuthError: true, preserveError: true, force: true })
      return false
    } finally {
      setLoading(false)
    }
  }

  async function updateZeitguru(path: string, body: object): Promise<ZeitguruStatus> {
    const userId = state?.currentUser.id
    const result = await api<ZeitguruStatus>(path, { method: 'POST', body: JSON.stringify(body) })
    setState((current) => current && current.currentUser.id === userId && (!current.zeitguru || result.generation >= current.zeitguru.generation)
      ? { ...current, zeitguru: result } : current)
    return result
  }

  async function updateZeitguruHistory(path: string, body: object): Promise<ZeitguruHistoryResult> {
    const userId = state?.currentUser.id
    const authEpoch = backendAuthEpoch.current
    const result = await api<ZeitguruHistoryResult>(path, { method: 'POST', body: JSON.stringify(body) })
    // A committed import/undo must update accounting, issues and projections together.
    // A refresh failure stays in the history panel; it never disables the native clock.
    if (backendAuthEpoch.current !== authEpoch) return result
    cancelBackendSync()
    setSyncing(false)
    const fresh = await api<StatePayload>('/api/state', { cache: 'no-store' })
    if (backendAuthEpoch.current !== authEpoch) return result
    setState((current) => current?.currentUser.id === userId && fresh.currentUser.id === userId ? fresh : current)
    if (fresh.currentUser.id === userId) {
      setLastSyncedAt(performance.now())
      setSyncError('')
    }
    return result
  }

  const zeitguruApi: ZeitguruApi = {
    synchronize: async () => {
      const result = await updateZeitguru('/api/zeitguru/sync', {})
      await loadBackendState({ clearOnAuthError: true, preserveError: true })
      return result
    },
    login: (body) => api('/api/zeitguru/login', { method: 'POST', body: JSON.stringify(body) }),
    connect: async (body) => {
      const result = await updateZeitguru('/api/zeitguru/connect', body)
      await loadBackendState({ clearOnAuthError: true, preserveError: true })
      return result
    },
    disconnect: (body) => updateZeitguru('/api/zeitguru/disconnect', body),
    reconcile: (body) => updateZeitguru('/api/zeitguru/reconcile', body),
    acknowledgeReview: (body) => updateZeitguru('/api/zeitguru/review', body),
    loadHistory: (query = {}) => {
      const search = new URLSearchParams()
      if (query.cursor) search.set('cursor', query.cursor)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.fromDate) search.set('fromDate', query.fromDate)
      if (query.toDate) search.set('toDate', query.toDate)
      return api(`/api/zeitguru/history?${search}`, { cache: 'no-store' })
    },
    importHistory: (body) => updateZeitguruHistory('/api/zeitguru/history/import', body),
    undoHistory: (body) => updateZeitguruHistory('/api/zeitguru/history/undo', body),
  }

  async function resolvePendingClockOperation(): Promise<'found' | 'missing' | 'unknown'> {
    const pending = pendingClockOperation.current
    if (!pending) return 'found'
    try {
      const result = await api<{ operation?: ZeitguruOperationSummary }>(`/api/zeitguru/operations/${encodeURIComponent(pending.clientOperationId)}`)
      if (result.operation && pendingClockOperation.current === pending) {
        pendingClockOperation.current = undefined
        return 'found'
      }
      return result.operation ? 'found' : 'missing'
    } catch {
      // An uncertain response retains its ID. Checking must never replay a clock action.
    }
    return 'unknown'
  }

  async function submitClock(action: ClockAction, workLocation?: WorkLocation): MutationResult {
    void requestSystemNotificationPermission()
    let bridge = state?.zeitguru
    if (!bridge?.enabled) {
      pendingClockOperation.current = undefined
      return updateState('/api/clock', { method: 'POST', body: JSON.stringify({ action, workLocation }) })
    }
    const previous = pendingClockOperation.current
    if (previous && (previous.action !== action || previous.workLocation !== workLocation)) {
      if (await resolvePendingClockOperation() === 'unknown') {
        setError(language === 'de'
          ? 'Der Status der vorherigen Stempelaktion konnte nicht geprüft werden. Bitte versuche es erneut, sobald DCO erreichbar ist.'
          : 'The previous clock action could not be checked. Please try again when DCO is reachable.')
        await loadBackendState({ preserveError: true, force: true })
        return false
      }
      // The user explicitly chose a different action. A verified missing operation
      // and fresh revision permit a new ID: the server CAS lets only one action win.
      // Never replay the original action automatically.
      try {
        const fresh = await api<StatePayload>('/api/state', { cache: 'no-store' })
        setState(fresh)
        setLastSyncedAt(performance.now())
        if (fresh.currentUser.id !== state?.currentUser.id) { pendingClockOperation.current = undefined; return false }
        bridge = fresh.zeitguru
        pendingClockOperation.current = undefined
        if (!bridge?.enabled) return updateState('/api/clock', { method: 'POST', body: JSON.stringify({ action, workLocation }) })
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t.backendSyncLost)
        return false
      }
    }
    const pending = pendingClockOperation.current ?? {
      userId: state!.currentUser.id, action, workLocation, clientOperationId: crypto.randomUUID(),
      expectedRevision: bridge.clockRevision, expectedGeneration: bridge.generation,
    }
    pendingClockOperation.current = pending
    let conflict = false
    const saved = await updateState('/api/clock', {
      method: 'POST',
      body: JSON.stringify({ action: pending.action, workLocation: pending.workLocation, clientOperationId: pending.clientOperationId,
        expectedRevision: pending.expectedRevision, expectedGeneration: pending.expectedGeneration }),
    }, (failure) => { conflict = failure instanceof Error && 'status' in failure && failure.status === 409 })
    if (pendingClockOperation.current === pending && (saved || conflict)) pendingClockOperation.current = undefined
    if (!saved && !conflict) await resolvePendingClockOperation()
    return saved
  }

  async function downloadTimeCsv(userId: string, period: TimeExportPeriod, date: string, onResult?: (result: TimeCsvExportResult) => void): MutationResult {
    try {
      const query = new URLSearchParams({
        userId,
        period,
        date,
        language,
      })
      const response = await fetch(`${apiBase}/api/exports/time-csv?${query.toString()}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(30_000),
        headers: sessionHeaders(token),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: 'CSV export failed' }))) as ApiError
        throw new Error(payload.message)
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filenameFromContentDisposition(response.headers.get('Content-Disposition')) ?? `nrw-time-export-${period}.csv`
      onResult?.({ url, filename: link.download })
      document.body.append(link)
      link.click()
      link.remove()
      // The export panel owns its retry link; other callers only need a short grace period.
      if (!onResult) window.setTimeout(() => window.URL.revokeObjectURL(url), 30_000)
      return true
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'CSV export failed'
      if (!onResult) setError(message)
      onResult?.({ error: message })
      return false
    }
  }

  async function downloadCalendarIcs(mode: CalendarViewMode, date: string, userIds: string[]): MutationResult {
    setLoading(true)
    try {
      const query = new URLSearchParams({
        mode,
        date,
        userIds: userIds.join(','),
        language,
      })
      const response = await fetch(`${apiBase}/api/exports/calendar-ics?${query.toString()}`, {
        credentials: 'include',
        headers: sessionHeaders(token),
      })

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: 'Calendar export failed' }))) as ApiError
        throw new Error(payload.message)
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filenameFromContentDisposition(response.headers.get('Content-Disposition')) ?? `arbeitszeitbuero-calendar-${mode}.ics`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => window.URL.revokeObjectURL(url), 500)
      setError('')
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Calendar export failed')
      return false
    } finally {
      setLoading(false)
    }
  }

  async function loadHolidayTemplateOptions(settings: Partial<HolidaySettings>) {
    const query = new URLSearchParams()
    if (settings.country) {
      query.set('country', settings.country)
    }
    if (settings.state) {
      query.set('state', settings.state)
    }
    if (settings.region) {
      query.set('region', settings.region)
    }
    if (settings.language) {
      query.set('language', settings.language)
    }

    return api<HolidayTemplateOptions>(`/api/holidays/template-options?${query.toString()}`)
  }

  if (packagedMobileBackendMissing) {
    return (
      <main className="app-shell simple-shell">
        <section className="panel clock-panel">
          <div className="panel-title">
            <Timer size={18} />
            <h2>{t.mobileBackendMissingTitle}</h2>
          </div>
          <p className="form-error mobile-backend-error">{t.mobileBackendMissingBody}</p>
        </section>
      </main>
    )
  }

  if (inviteToken) {
    return (
      <InvitationScreen
        error={error}
        invitation={invitationPreview}
        language={language}
        loading={loading}
        t={t}
        theme={theme}
        onAccept={acceptInvitation}
        onLanguageChange={setLanguage}
        onThemeChange={setTheme}
      />
    )
  }

  if (resetToken) {
    return (
      <PasswordResetScreen
        error={error}
        language={language}
        loading={loading}
        preview={passwordResetPreview}
        t={t}
        theme={theme}
        onBackToLogin={() => window.location.assign(appBasePath)}
        onChange={completePasswordReset}
        onLanguageChange={setLanguage}
        onThemeChange={setTheme}
      />
    )
  }

  if (token && !state) {
    if (syncError) return <SessionRecoveryScreen language={language} theme={theme} t={t} message={t.sessionCheckFailed} retrying={syncing}
      onLanguageChange={setLanguage} onThemeChange={setTheme} onRetry={() => void loadBackendState({ preserveError: true, force: true })} />
    return <SessionHoldScreen message={t.pending} />
  }

  if (!token && !ssoChecked) {
    return <SessionHoldScreen message={t.pending} />
  }

  if (!token && ssoUnavailable) {
    return <SessionRecoveryScreen language={language} theme={theme} t={t} message={t.sessionCheckFailed} retrying={false}
      onLanguageChange={setLanguage} onThemeChange={setTheme} onRetry={() => { setSsoUnavailable(false); setSsoChecked(false) }} />
  }

  if (!token) {
    return (
      <LoginScreen
        error={error}
        language={language}
        loading={loading}
        t={t}
        theme={theme}
        onLanguageChange={setLanguage}
        onThemeChange={setTheme}
        onLogin={login}
        onPasswordResetRequest={requestPasswordReset}
      />
    )
  }

  if (!state) {
    return null
  }

  if (state.currentUser.mustChangePassword) {
    return (
      <PasswordChangeScreen
        error={error}
        language={language}
        loading={loading}
        t={t}
        theme={theme}
        user={state.currentUser}
        onChange={changePassword}
        onLanguageChange={setLanguage}
        onThemeChange={setTheme}
        onLogout={() => void logout()}
      />
    )
  }

  const currentSummary = state.summaries.find((summary) => summary.userId === state.currentUser.id)
  const suiteProducts: SuiteProductDefinition[] = [
    ...(coreOfficeUrl ? [{ id: 'core' as const, path: coreOfficeUrl || '/', label: 'Core' }] : []),
    ...(enabledSuiteModules.has('time') ? [{ id: 'time' as const, path: appBasePath, label: language === 'de' ? 'Zeit' : 'Time' }] : []),
    ...(enabledSuiteModules.has('inventory') ? [{ id: 'inventory' as const, path: inventorySystemUrl, label: language === 'de' ? 'Inventar' : 'Inventory' }] : []),
    ...(enabledSuiteModules.has('agile') ? [{ id: 'agile' as const, path: agileProjectManagementUrl, label: 'Agile' }] : []),
  ]
  const timeNavigation: SuiteNavItem[] = simpleMode ? [] : [
    { id: 'dashboard', label: t.dashboard, icon: Timer, active: tab === 'dashboard', onSelect: () => navigateToTab('dashboard') },
    { id: 'calendar', label: t.calendar, icon: CalendarDays, active: tab === 'calendar', onSelect: () => navigateToTab('calendar') },
    { id: 'requests', label: t.requests, icon: BriefcaseBusiness, active: tab === 'requests', onSelect: () => navigateToTab('requests') },
    ...(state.currentUser.role === 'admin' ? [
      { id: 'adminCalendar', label: t.adminCalendarTab, icon: CalendarDays, active: tab === 'adminCalendar', onSelect: () => navigateToTab('adminCalendar') },
      { id: 'adminUsers', label: t.users, icon: ShieldCheck, active: tab === 'adminUsers', onSelect: () => navigateToTab('adminUsers') },
      { id: 'adminGroups', label: t.groups, icon: Users, active: tab === 'adminGroups', onSelect: () => navigateToTab('adminGroups') },
      { id: 'adminFreeDays', label: t.freeDays, icon: CalendarDays, active: tab === 'adminFreeDays', onSelect: () => navigateToTab('adminFreeDays') },
      { id: 'adminSettings', label: t.settings, icon: Settings, active: tab === 'adminSettings', onSelect: () => navigateToTab('adminSettings') },
    ] : []),
  ]
  const productTone: SuiteProductTone = state.clockStatus === 'on_break'
    ? 'on-break'
    : state.clockStatus === 'off_work'
      ? 'off-work'
      : 'working'

  return (
    <main className={classNames('app-shell', simpleMode && 'simple-shell')}>
        {state.readOnly && <p role="status" className="panel">{language === 'de' ? 'Dieses System ist schreibgeschützt. Daten können weiterhin angesehen und exportiert werden.' : 'This system is read-only. You can still view and export your data.'}</p>}
      <SuiteShellHeader
        currentProduct="time"
        identityLine={displayUserName(state.currentUser)}
        language={language}
        navigation={timeNavigation}
        navigationLabel="Primary"
        onLanguageChange={setLanguage}
        onLogout={() => void logout()}
        onProductNavigate={(product, event) => {
          if (product.id === 'time') {
            event.preventDefault()
            return
          }
          void openSuiteModule(event, product.path)
        }}
        onThemeChange={setTheme}
        productTitle={t.appName}
        productTone={productTone}
        products={suiteProducts}
        showSuiteControls={!packagedMobileBuild}
        theme={theme}
        workspaceOnly={isEmbeddedSuiteWorkspace}
      />

      {error && <div className="status-banner">{error}</div>}
      {operationStatus && <div className={classNames('operation-toast', operationStatus.kind)}>{operationStatus.message}</div>}

      <section className="content-band dco-suite-content">
        {(tab === 'dashboard' || simpleMode) && currentSummary && (
          <DashboardView
            backendSyncFresh={backendSyncFresh}
            backendSyncMessage={backendSyncMessage}
            syncRecovery={<button className="secondary-button" type="button" disabled={syncing} onClick={() => void loadBackendState({ preserveError: true, force: true })}>{syncing ? t.backendSyncing : t.reconnectNow}</button>}
            language={language}
            loading={loading}
            simpleMode={simpleMode}
            state={state}
            t={t}
            onClock={submitClock}
            zeitguruApi={zeitguruApi}
            onUpdateWorkLocation={(workLocation) =>
              updateState('/api/clock/location', {
                method: 'PATCH',
                body: JSON.stringify({ workLocation }),
              })
            }
            onReadNotification={(id) =>
              updateState(`/api/notifications/${id}/read`, {
                method: 'PATCH',
                body: JSON.stringify({ read: true }),
              })
            }
            onExportCsv={downloadTimeCsv}
            onResolveDayIssue={(issue, suggestion) => {
              if (suggestion.draft) {
                writeRequestFormDraft(requestDraftStorageKey(state.currentUser.id), {...suggestion.draft,targetUserId:issue.userId,targetUserName:state.users.find(user=>user.id===issue.userId)?.name})
                navigateToTab('requests')
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }
            }}
          />
        )}

        {tab === 'calendar' && !simpleMode && (
          <CalendarView
            state={state}
            loading={loading}
            language={language}
            t={t}
            onUpdateAccess={(ids) =>
              updateState(`/api/users/${state.currentUser.id}/calendar-access`, {
                method: 'PATCH',
                body: JSON.stringify({ calendarAccessUserIds: ids }),
              })
            }
            onCreateCalendarEvent={(body) =>
              updateState('/api/calendar-events', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onUpdateCalendarEvent={(id, body) =>
              updateState(`/api/calendar-events/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onDeleteCalendarEvent={(id) =>
              updateState(`/api/calendar-events/${id}`, {
                method: 'DELETE',
              })
            }
            onCreateCalDavAccount={(body) =>
              updateState('/api/caldav/accounts', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onUpdateCalDavAccount={(id, body) =>
              updateState(`/api/caldav/accounts/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onSyncCalDavAccount={(id) =>
              updateState(`/api/caldav/accounts/${id}/sync`, {
                method: 'POST',
              })
            }
            onDeleteCalDavAccount={(id) =>
              updateState(`/api/caldav/accounts/${id}`, {
                method: 'DELETE',
              })
            }
            onExportCalendar={downloadCalendarIcs}
          />
        )}

        {tab === 'adminCalendar' && !simpleMode && state.currentUser.role === 'admin' && (
          <AdminCalendarView state={state} language={language} t={t} />
        )}

        {tab === 'requests' && !simpleMode && (
          <RequestsView
            state={state}
            loading={loading}
            language={language}
            selectedRequestId={selectedRequestId}
            t={t}
            onCreate={(body) =>
              updateState('/api/requests', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onDecision={(requestId, decision) =>
              updateState(`/api/requests/${requestId}/decision`, {
                method: 'POST',
                body: JSON.stringify({ decision }),
              })
            }
            onUpdateRequest={(requestId, body) =>
              updateState(`/api/requests/${requestId}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onCancelRequest={(requestId) =>
              updateState(`/api/requests/${requestId}/cancel`, {
                method: 'POST',
              })
            }
          />
        )}

        {tab === 'adminUsers' && !simpleMode && state.currentUser.role === 'admin' && (
          <AdminUsersView
            state={state}
            language={language}
            loading={loading}
            t={t}
            onUpdateUser={(userId, body) =>
              updateState(`/api/users/${userId}/settings`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onRemoveUser={(userId) =>
              updateState(`/api/users/${userId}`, {
                method: 'DELETE',
              })
            }
            onInviteUser={(body) =>
              updateState('/api/admin/invitations', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onCancelInvite={(invitationId) =>
              updateState(`/api/admin/invitations/${invitationId}`, {
                method: 'DELETE',
              })
            }
            onImportCsv={(body) =>
              updateState('/api/imports/time-csv', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onUndoApproval={(requestId) =>
              updateState(`/api/requests/${requestId}/undo`, {
                method: 'POST',
              })
            }
            onExportCsv={downloadTimeCsv}
          />
        )}

        {tab === 'adminGroups' && !simpleMode && state.currentUser.role === 'admin' && (
          <GroupAdminPanel
            state={state}
            loading={loading}
            t={t}
            onCreateGroup={(body) =>
              updateState('/api/calendar-groups', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onUpdateGroup={(id, body) =>
              updateState(`/api/calendar-groups/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onDeleteGroup={(id) =>
              updateState(`/api/calendar-groups/${id}`, {
                method: 'DELETE',
              })
            }
          />
        )}

        {tab === 'adminFreeDays' && !simpleMode && state.currentUser.role === 'admin' && (
          <HolidayAdmin
            state={state}
            loading={loading}
            language={language}
            t={t}
            onLoadHolidayTemplateOptions={loadHolidayTemplateOptions}
            onUpdateHolidaySettings={(body) =>
              updateState('/api/holidays/settings', {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onHolidayOverride={(body) =>
              updateState('/api/holidays/overrides', {
                method: 'POST',
                body: JSON.stringify(body),
              })
            }
            onUpdateOverride={(id, body) =>
              updateState(`/api/holidays/overrides/${id}`, {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onDeleteOverride={(id) =>
              updateState(`/api/holidays/overrides/${id}`, {
                method: 'DELETE',
              })
            }
          />
        )}

        {tab === 'adminSettings' && !simpleMode && state.currentUser.role === 'admin' && (
          <SettingsView
            onUpdateOvertimePolicy={body=>updateState('/api/settings/overtime-policy',{method:'PATCH',body:JSON.stringify(body)})}
            onRetryOvertimeAlerts={()=>updateState('/api/settings/overtime-policy/retry-failed',{method:'POST',body:'{}'})}
            state={state}
            language={language}
            loading={loading}
            t={t}
            onCreateBackup={() =>
              updateState('/api/backups/weekly', {
                method: 'POST',
              })
            }
            onUpdateMailServer={(body) =>
              updateState('/api/settings/mail-server', {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onTestMailServer={() =>
              updateState('/api/settings/mail-server/test', {
                method: 'POST',
              })
            }
            onDeleteMailServer={() =>
              updateState('/api/settings/mail-server', {
                method: 'DELETE',
              })
            }
            onUpdateLicense={(body) =>
              updateState('/api/settings/license', {
                method: 'PATCH',
                body: JSON.stringify(body),
              })
            }
            onDeleteLicense={() =>
              updateState('/api/settings/license', {
                method: 'DELETE',
              })
            }
          />
        )}
      </section>
    </main>
  )
}

function SessionHoldScreen({ message }: { message: string }) {
  return <SuiteLoadingScreen message={message} product="time" title="Digital Core Office Time" />
}

function SessionRecoveryScreen({ language, theme, t, message, retrying, onRetry, onLanguageChange, onThemeChange }: {
  language: Language
  theme: Theme
  t: T
  message: string
  retrying: boolean
  onRetry: () => void
  onLanguageChange: (language: Language) => void
  onThemeChange: (theme: Theme) => void
}) {
  return <main className="login-layout"><section className="login-panel auth-loading-panel" aria-live="polite">
    <button className="icon-button language-login" title={language === 'en' ? 'Deutsch' : 'English'} type="button" onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}><Languages size={18} /></button>
    <ThemeToggle className="theme-login" theme={theme} t={t} onThemeChange={onThemeChange} />
    <div className="brand-mark"><DigitalCoreOfficeLogo size={28} /></div>
    <h1>{t.sessionUnavailable}</h1>
    <p>{message}</p>
    <button className="primary-button" type="button" disabled={retrying} onClick={onRetry}>{retrying ? t.backendSyncing : t.reconnectNow}</button>
  </section></main>
}

function ThemeToggle({
  className,
  theme,
  t,
  onThemeChange,
}: {
  className?: string
  theme: Theme
  t: T
  onThemeChange: (theme: Theme) => void
}) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = theme === 'dark' ? t.switchToLightMode : t.switchToDarkMode

  return (
    <button
      aria-label={label}
      className={classNames('icon-button', className)}
      title={label}
      type="button"
      onClick={() => onThemeChange(nextTheme)}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}

function LoginScreen({
  error,
  language,
  loading,
  t,
  theme,
  onLanguageChange,
  onThemeChange,
  onLogin,
  onPasswordResetRequest,
}: {
  error: string
  language: Language
  loading: boolean
  t: T
  theme: Theme
  onLanguageChange: (language: Language) => void
  onThemeChange: (theme: Theme) => void
  onLogin: (email: string, password: string, stayLoggedIn: boolean) => Promise<void>
  onPasswordResetRequest: (email: string) => Promise<boolean>
}) {
  const initialForgotMode = new URLSearchParams(window.location.search).has('forgot')
  const initialEmail = new URLSearchParams(window.location.search).get('email') ?? ''
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [stayLoggedIn, setStayLoggedIn] = useState(false)
  const [forgotMode, setForgotMode] = useState(initialForgotMode)
  const [resetEmail, setResetEmail] = useState(initialEmail)
  const [resetSent, setResetSent] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    void onLogin(email, password, stayLoggedIn)
  }

  async function submitPasswordReset(event: FormEvent) {
    event.preventDefault()
    const ok = await onPasswordResetRequest(resetEmail || email)
    if (ok) {
      setResetSent(true)
    }
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <button
          className="icon-button language-login"
          title={language === 'en' ? 'Deutsch' : 'English'}
          type="button"
          onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}
        >
          <Languages size={18} />
        </button>
        <ThemeToggle className="theme-login" theme={theme} t={t} onThemeChange={onThemeChange} />
        <div className="brand-mark">
          <DigitalCoreOfficeLogo size={28} />
        </div>
        <h1>{forgotMode ? t.resetPasswordTitle : t.appName}</h1>
        {forgotMode ? (
          <form onSubmit={submitPasswordReset}>
            <p className="password-hint">{t.resetPasswordIntro}</p>
            <label>
              {t.email}
              <input
                autoComplete="email"
                value={resetEmail}
                onChange={(event) => {
                  setResetEmail(event.target.value)
                  setResetSent(false)
                }}
                type="email"
              />
            </label>
            {resetSent && <p className="form-success">{t.resetPasswordEmailSent}</p>}
            {error && <p className="form-error">{error}</p>}
            <div className="auth-actions">
              <button disabled={loading} className="primary-button" type="submit">
                <Mail size={18} />
                {t.sendResetLink}
              </button>
              <button disabled={loading} className="secondary-button" type="button" onClick={() => setForgotMode(false)}>
                <ChevronLeft size={18} />
                {t.backToLogin}
              </button>
            </div>
          </form>
        ) : (
          <>
            {coreOfficeUrl && (
              <a className="secondary-button login-download-link" href={coreOfficeUrl}>
                <LayoutGrid size={18} />
                Digital Core Office SSO
              </a>
            )}
            <form onSubmit={submit}>
              <label>
                {t.email}
                <input autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
              </label>
              <PasswordField autoComplete="current-password" label={t.password} value={password} t={t} onChange={setPassword} />
              <label className="login-stay-row">
                <input
                  checked={stayLoggedIn}
                  type="checkbox"
                  onChange={(event) => setStayLoggedIn(event.target.checked)}
                />
                <span>{t.stayLoggedIn}</span>
              </label>
              <button
                className="link-button forgot-password-button"
                type="button"
                onClick={() => {
                  setResetEmail(email)
                  setResetSent(false)
                  setForgotMode(true)
                }}
              >
                {t.forgotPasswordReset}
              </button>
              <p className="password-hint">{t.invitationRequired}</p>
              {error && <p className="form-error">{error}</p>}
              <button disabled={loading} className="primary-button" type="submit">
                <LogIn size={18} />
                {t.signIn}
              </button>
            </form>
            <a className="secondary-button login-download-link" href={androidApkHref} download>
              <Download size={18} />
              {t.downloadAndroidApp}
            </a>
          </>
        )}
      </section>
    </main>
  )
}

function PasswordResetScreen({
  error,
  language,
  loading,
  preview,
  t,
  theme,
  onBackToLogin,
  onChange,
  onLanguageChange,
  onThemeChange,
}: {
  error: string
  language: Language
  loading: boolean
  preview: PasswordResetPreview | null
  t: T
  theme: Theme
  onBackToLogin: () => void
  onChange: (password: string, passwordConfirm: string) => Promise<void>
  onLanguageChange: (language: Language) => void
  onThemeChange: (theme: Theme) => void
}) {
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    void onChange(password, passwordConfirm)
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <button
          className="icon-button language-login"
          title={language === 'en' ? 'Deutsch' : 'English'}
          type="button"
          onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}
        >
          <Languages size={18} />
        </button>
        <ThemeToggle className="theme-login" theme={theme} t={t} onThemeChange={onThemeChange} />
        <div className="brand-mark">
          <DigitalCoreOfficeLogo size={28} />
        </div>
        <h1>{t.resetPasswordTitle}</h1>
        {preview ? (
          <form onSubmit={submit}>
            <div className="invite-preview">
              <span>{t.name}</span>
              <strong>{preview.name}</strong>
              <span>{t.email}</span>
              <strong>{preview.email}</strong>
              <span>{t.inviteExpiresAt}</span>
              <strong>{formatDateTime(preview.expiresAt, language)}</strong>
            </div>
            <PasswordField autoComplete="new-password" label={t.newPassword} value={password} t={t} onChange={setPassword} />
            <PasswordField
              autoComplete="new-password"
              label={t.confirmPassword}
              value={passwordConfirm}
              t={t}
              onChange={setPasswordConfirm}
            />
            <p className="password-hint">{t.safePasswordHint}</p>
            {error && <p className="form-error">{error}</p>}
            <button disabled={loading} className="primary-button" type="submit">
              <ShieldCheck size={18} />
              {t.setNewPassword}
            </button>
          </form>
        ) : (
          <div className="auth-empty-state">
            <p className={error ? 'form-error' : 'password-hint'}>{loading ? t.pending : error || t.resetLinkInvalid}</p>
            <button className="secondary-button" type="button" onClick={onBackToLogin}>
              <ChevronLeft size={18} />
              {t.backToLogin}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

function InvitationScreen({
  error,
  invitation,
  language,
  loading,
  t,
  theme,
  onAccept,
  onLanguageChange,
  onThemeChange,
}: {
  error: string
  invitation: InvitationPreview | null
  language: Language
  loading: boolean
  t: T
  theme: Theme
  onAccept: (password: string, passwordConfirm: string) => Promise<void>
  onLanguageChange: (language: Language) => void
  onThemeChange: (theme: Theme) => void
}) {
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    void onAccept(password, passwordConfirm)
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <button
          className="icon-button language-login"
          title={language === 'en' ? 'Deutsch' : 'English'}
          type="button"
          onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}
        >
          <Languages size={18} />
        </button>
        <ThemeToggle className="theme-login" theme={theme} t={t} onThemeChange={onThemeChange} />
        <div className="brand-mark">
          <DigitalCoreOfficeLogo size={28} />
        </div>
        <h1>{t.completeInviteTitle}</h1>
        <p className="password-hint">{t.invitationIntro}</p>
        {invitation ? (
          <form onSubmit={submit}>
            <div className="invite-preview">
              <span>{t.name}</span>
              <strong>{invitation.name}</strong>
              <span>{t.invitedEmailLocked}</span>
              <strong>{invitation.email}</strong>
              <span>{t.userRole}</span>
              <strong>{invitation.role === 'admin' ? t.admin : t.employee}</strong>
              <span>{t.inviteExpiresAt}</span>
              <strong>{formatDateTime(invitation.expiresAt, language)}</strong>
            </div>
            <PasswordField autoComplete="new-password" label={t.password} value={password} t={t} onChange={setPassword} />
            <PasswordField
              autoComplete="new-password"
              label={t.confirmPassword}
              value={passwordConfirm}
              t={t}
              onChange={setPasswordConfirm}
            />
            <p className="password-hint">{t.safePasswordHint}</p>
            {error && <p className="form-error">{error}</p>}
            <button disabled={loading} className="primary-button" type="submit">
              <UserPlus size={18} />
              {t.createPassword}
            </button>
          </form>
        ) : (
          <p className={error ? 'form-error' : 'password-hint'}>{loading ? t.pending : error || t.invalidInvite}</p>
        )}
      </section>
    </main>
  )
}

function PasswordChangeScreen({
  error,
  language,
  loading,
  t,
  theme,
  user,
  onChange,
  onLanguageChange,
  onThemeChange,
  onLogout,
}: {
  error: string
  language: Language
  loading: boolean
  t: T
  theme: Theme
  user: User
  onChange: (currentPassword: string, password: string, passwordConfirm: string) => MutationResult
  onLanguageChange: (language: Language) => void
  onThemeChange: (theme: Theme) => void
  onLogout: () => void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')

  function submit(event: FormEvent) {
    event.preventDefault()
    void onChange(currentPassword, password, passwordConfirm)
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <button
          className="icon-button language-login"
          title={language === 'en' ? 'Deutsch' : 'English'}
          type="button"
          onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}
        >
          <Languages size={18} />
        </button>
        <ThemeToggle className="theme-login" theme={theme} t={t} onThemeChange={onThemeChange} />
        <div className="brand-mark">
          <DigitalCoreOfficeLogo size={28} />
        </div>
        <h1>{t.changePasswordTitle}</h1>
        <p className="password-hint">{t.forcedPasswordChangeIntro}</p>
        <form onSubmit={submit}>
          <div className="invite-preview">
            <span>{t.name}</span>
            <strong>{displayUserName(user)}</strong>
            <span>{t.email}</span>
            <strong>{user.email}</strong>
          </div>
          <PasswordField autoComplete="current-password" label={t.currentPassword} value={currentPassword} t={t} onChange={setCurrentPassword} />
          <PasswordField autoComplete="new-password" label={t.newPassword} value={password} t={t} onChange={setPassword} />
          <PasswordField
            autoComplete="new-password"
            label={t.confirmPassword}
            value={passwordConfirm}
            t={t}
            onChange={setPasswordConfirm}
          />
          <p className="password-hint">{t.safePasswordHint}</p>
          {error && <p className="form-error">{error}</p>}
          <div className="auth-actions">
            <button disabled={loading} className="primary-button" type="submit">
              <ShieldCheck size={18} />
              {t.saveNewPassword}
            </button>
            <button disabled={loading} className="secondary-button" type="button" onClick={onLogout}>
              <LogOut size={18} />
              {t.signOut}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}

function DashboardView({
  backendSyncFresh,
  backendSyncMessage,
  syncRecovery,
  language,
  state,
  simpleMode,
  loading,
  t,
  onClock,
  onUpdateWorkLocation,
  onReadNotification,
  onExportCsv,
  onResolveDayIssue,
  zeitguruApi,
}: {
  backendSyncFresh: boolean
  backendSyncMessage: string
  syncRecovery: ReactNode
  language: Language
  state: StatePayload
  simpleMode: boolean
  loading: boolean
  t: T
  onClock: (action: ClockAction, workLocation?: WorkLocation) => MutationResult
  onUpdateWorkLocation: (workLocation: WorkLocation) => MutationResult
  onReadNotification: (id: string) => MutationResult
  onExportCsv: TimeCsvExport
  onResolveDayIssue: (issue: DayIssue, suggestion: DayIssueSuggestion) => void
  zeitguruApi: ZeitguruApi
}) {
  const unread = state.notifications.filter((notification) => !notification.read)
  const [review, setReview] = useState<{ userId: string; date: string }>()
  const reviewContext = review ? state.zeitguruAccounting?.[review.userId] : undefined

  return (
    <div className={classNames('dashboard-grid', simpleMode && 'dashboard-grid-simple')}>
      <ClockPanel
        status={state.clockStatus}
        language={language}
        timeEntries={state.timeEntries.filter(entry => entry.source !== 'zeitguru')}
        currentUserId={state.currentUser.id}
        loading={loading}
        syncFresh={backendSyncFresh}
        syncMessage={backendSyncMessage}
        syncRecovery={syncRecovery}
        t={t}
        onClock={onClock}
        onUpdateWorkLocation={onUpdateWorkLocation}
        zeitguru={state.zeitguru}
        zeitguruApi={zeitguruApi}
        readOnly={state.readOnly}
      />
      <DayIssuesPanel
        key={state.currentUser.id}
        userId={state.currentUser.id}
        issues={state.dayIssues ?? []}
        readOnly={Boolean(state.readOnly)||loading}
        language={language}
        users={state.users}
        onResolve={(issue, suggestion) => {
          if (suggestion.action === 'zeitguru_history') {
            setReview({ userId: issue.userId, date: issue.date })
            window.requestAnimationFrame(() => document.getElementById('zeitguru-day-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
          } else onResolveDayIssue(issue, suggestion)
        }}
      />
      {review && reviewContext && <section className="panel zeitguru-day-review" id="zeitguru-day-review" aria-label={language === 'de' ? 'Importierten Tag prüfen' : 'Review imported day'}>
        <h2>{formatDateKey(review.date, language)} · {displayUserName(state.users.find(user => user.id === review.userId))}</h2>
        <p>{language === 'de' ? 'Diese Quelldaten sind schreibgeschützt. Eine Prüfung ändert weder den Import noch deine Stempelungen.' : 'These source records are read-only. Reviewing them does not change the import or your clock entries.'}</p>
        <ZeitguruAccountingOverview key={`${review.userId}-${review.date}`} context={reviewContext} language={language} fromDate={review.date} toDate={review.date} />
        <button type="button" className="secondary-button" onClick={() => setReview(undefined)}>{language === 'de' ? 'Prüfung schließen' : 'Close review'}</button>
      </section>}
      <WorkedTimeLookupPanel state={state} user={state.currentUser} timeEntries={state.timeEntries} language={language} t={t} />
      <SummaryPanel state={state} user={state.currentUser} timeEntries={state.timeEntries} language={language} t={t} />
      <TimeExportPanel
        users={[state.currentUser]}
        selectedUserId={state.currentUser.id}
        language={language}
        subtle
        t={t}
        onExportCsv={onExportCsv}
      />
      <ClockActivityLog entries={state.timeEntries} userId={state.currentUser.id} language={language} t={t} />
      {simpleMode && <ApprovedRequestsSummary requests={state.requests} users={state.users} currentUserId={state.currentUser.id} language={language} t={t} />}
      {!simpleMode && (
        <section className="panel notifications-panel">
          <div className="panel-title">
            <Bell size={18} />
            <h2>{t.notifications}</h2>
          </div>
          <div className="notification-list">
            {unread.length === 0 && <p className="muted">{t.noUnread}</p>}
            {unread.slice(0, 5).map((notification) => (
              <article key={notification.id} className="notification-row">
                <div>
                  <strong>{notification.title}</strong>
                  <p>{notification.message}</p>
                </div>
                <button title="Mark read" className="icon-button" type="button" onClick={() => onReadNotification(notification.id)}>
                  <Check size={16} />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ApprovedRequestsSummary({
  requests,
  users,
  currentUserId,
  language,
  t,
}: {
  requests: RequestItem[]
  users: User[]
  currentUserId: string
  language: Language
  t: T
}) {
  const today = businessDateKey()
  const approvedRequests = requests
    .filter((request) => request.userId === currentUserId && request.status === 'approved')
    .sort((left, right) => {
      const leftDate = requestPrimaryDate(left)
      const rightDate = requestPrimaryDate(right)
      const leftUpcoming = leftDate >= today
      const rightUpcoming = rightDate >= today
      if (leftUpcoming !== rightUpcoming) {
        return leftUpcoming ? -1 : 1
      }
      return leftUpcoming ? leftDate.localeCompare(rightDate) : rightDate.localeCompare(leftDate)
    })
  const userById = new Map(users.map((user) => [user.id, user]))

  return (
    <details className="panel app-approved-requests-panel collapsible-summary-panel">
      <summary className="panel-title summary-title">
        <div className="summary-heading">
          <Check size={18} />
          <h2>{t.myApprovedRequests}</h2>
        </div>
        <ChevronRight size={16} />
      </summary>
      <div className="app-approved-request-list">
        {approvedRequests.length === 0 && <p className="muted app-approved-empty">{t.noApprovedRequests}</p>}
        {approvedRequests.map((request) => (
          <article className="app-approved-request-row" key={request.id}>
            <div>
              <span className="status-chip approved">{t.approved}</span>
              <strong>{requestTitle(request, t)}</strong>
              <small>{requestDateDetail(request, language)}</small>
              {request.decidedAt && <small>{t.approvedAt}: {formatDateTime(request.decidedAt, language)}</small>}
              {request.decidedBy && displayUserName(userById.get(request.decidedBy)) && (
                <small>{t.approvedBy}: {displayUserName(userById.get(request.decidedBy))}</small>
              )}
            </div>
          </article>
        ))}
      </div>
    </details>
  )
}

function ClockPanel({
  status,
  language,
  timeEntries,
  currentUserId,
  loading,
  syncFresh,
  syncMessage,
  syncRecovery,
  t,
  onClock,
  onUpdateWorkLocation,
  zeitguru,
  zeitguruApi,
  readOnly,
}: {
  status: ClockStatus
  language: Language
  timeEntries: TimeEntry[]
  currentUserId: string
  loading: boolean
  syncFresh: boolean
  syncMessage: string
  syncRecovery: ReactNode
  t: T
  onClock: (action: ClockAction, workLocation?: WorkLocation) => MutationResult
  onUpdateWorkLocation: (workLocation: WorkLocation) => MutationResult
  zeitguru?: ZeitguruStatus
  zeitguruApi: ZeitguruApi
  readOnly?: boolean
}) {
  const liveNow = useLiveNow(status !== 'off_work')
  const today = businessDateKey(liveNow)
  const todaysEntries = timeEntries.filter((entry) => entry.userId === currentUserId && entry.date === today)
  const openEntry = timeEntries.find((entry) => entry.userId === currentUserId && !entry.stoppedAt)
  const clockedInAt = openEntry?.startedAt ?? todaysEntries.reduce<string | undefined>(
    (latest, entry) => !latest || entry.startedAt > latest ? entry.startedAt : latest,
    undefined,
  )
  const breakMs = todaysEntries.reduce((total, entry) => total + entryBreakMs(entry, liveNow), 0)
  const workedMs = todaysEntries.reduce((total, entry) => total + entryWorkedMs(entry, liveNow), 0)
  const [confirmStopWork, setConfirmStopWork] = useState(false)
  const [selectedWorkLocation, setSelectedWorkLocation] = useState<WorkLocation>(() => {
    const saved = localStorage.getItem('time-tracker-work-location')
    return openEntry?.workLocation ?? (isWorkLocation(saved) ? saved : 'office')
  })

  useEffect(() => {
    if (openEntry?.workLocation) {
      setSelectedWorkLocation(openEntry.workLocation)
    }
  }, [openEntry?.workLocation])

  async function changeWorkLocation(nextLocation: string) {
    const workLocation = nextLocation as WorkLocation
    if (status === 'off_work') {
      setSelectedWorkLocation(workLocation)
      localStorage.setItem('time-tracker-work-location', workLocation)
      return
    }

    const saved = await onUpdateWorkLocation(workLocation)
    if (saved) {
      setSelectedWorkLocation(workLocation)
      localStorage.setItem('time-tracker-work-location', workLocation)
    }
  }

  return (
    <section className="panel clock-panel">
      <div className="clock-status">
        <span className={classNames('status-icon', status)}>
          <ClockStatusIcon status={status} size={16} />
        </span>
        {clockLabel(status, t)}
      </div>
      <div className="clock-face">
        <ClockFaceIcon running={status === 'working'} />
        <div className="clock-primary-reading">
          <span>{formatDuration(workedMs)}</span>
          <small>{t.workedToday}</small>
        </div>
      </div>
      <div className="clock-live-stats">
        <div>
          <span>{t.clockedInAt}</span>
          <strong>{clockedInAt ? formatTimeOnly(clockedInAt, language) : '—'}</strong>
        </div>
        <div>
          <span>{t.breakTaken}</span>
          <strong>{formatDuration(breakMs)}</strong>
        </div>
      </div>
      <label className="clock-location-control">
        <span>
          <MapPin size={16} />
          {t.workLocation}
        </span>
        <AppSelect
          ariaLabel={t.workLocation}
          disabled={loading || !syncFresh}
          options={workLocationOptions(t)}
          value={selectedWorkLocation}
          onChange={changeWorkLocation}
        />
      </label>
      {!syncFresh && (
        <div className="clock-sync-state stale" role="status">
          <span className="sync-dot stale"></span>
          {syncMessage}
          {syncRecovery}
        </div>
      )}
      <div className="clock-actions">
        {status === 'off_work' && (
          <ClockActionButton
            action="start_work"
            className="primary-button"
            disabled={loading || !syncFresh}
            t={t}
            onClick={() => onClock('start_work', selectedWorkLocation)}
          />
        )}
        {status === 'working' && (
          <>
            <ClockActionButton
              action="start_break"
              className="primary-button"
              disabled={loading || !syncFresh}
              t={t}
              onClick={() => onClock('start_break')}
            />
            <ClockActionButton
              action="stop_work"
              className="secondary-button"
              disabled={loading || !syncFresh}
              t={t}
              onClick={() => setConfirmStopWork(true)}
            />
          </>
        )}
        {status === 'on_break' && (
          <ClockActionButton
            action="stop_break"
            className="primary-button"
            disabled={loading || !syncFresh}
            t={t}
            onClick={() => onClock('stop_break')}
          />
        )}
      </div>
      {zeitguru?.available && <ZeitguruPanel key={currentUserId} status={zeitguru} api={zeitguruApi} language={language} clockStatus={status} readOnly={readOnly} />}
      {confirmStopWork && (
        <ConfirmDialog
          title={t.confirmClockOutTitle}
          body={t.confirmClockOutBody}
          confirmLabel={t.stopWork}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmStopWork(false)}
          onConfirm={async () => {
            const saved = await onClock('stop_work')
            if (saved) {
              setConfirmStopWork(false)
            }
          }}
        />
      )}
    </section>
  )
}

function ClockFaceIcon({ running }: { running: boolean }) {
  return (
    <svg className="clock-icon" width="42" height="42" viewBox="0 0 42 42" aria-hidden="true" focusable="false">
      <circle className="clock-icon-rim" cx="21" cy="21" r="16" />
      <line className="clock-icon-hour-hand" x1="21" y1="21" x2="21" y2="14" />
      <line className={classNames('clock-icon-pointer', running && 'clock-icon-pointer-running')} x1="21" y1="21" x2="21" y2="9" />
      <circle className="clock-icon-center" cx="21" cy="21" r="2" />
    </svg>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  loading,
  confirmTone = 'default',
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  loading: boolean
  confirmTone?: 'default' | 'danger'
  onConfirm: () => void | Promise<void | boolean>
  onCancel: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const mountedRef = useRef(true)
  const busy = loading || confirming

  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  async function confirm() {
    setConfirming(true)
    try {
      await onConfirm()
    } finally {
      if (mountedRef.current) {
        setConfirming(false)
      }
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{body}</p>
        <div className="modal-actions">
          <button disabled={busy} className="secondary-button" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button aria-busy={busy} disabled={busy} className={classNames('primary-button',confirmTone === 'danger' && 'danger-button')} type="button" onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryPanel({
  state,
  user,
  timeEntries,
  language,
  t,
}: {
  state: StatePayload
  user: User
  timeEntries: TimeEntry[]
  language: Language
  t: T
}) {
  const hasOpenEntry = timeEntries.some((entry) => entry.userId === user.id && !entry.stoppedAt)
  const liveNow = useLiveNow(hasOpenEntry)
  const referenceDate = businessDateKey(liveNow)
  const reference = parseDateKey(referenceDate)
  const [weekStart, weekEnd] = clampDateRange(startOfWeek(reference), endOfWeek(reference))
  const [monthStart, monthEnd] = clampDateRange(startOfMonth(reference), endOfMonth(reference))
  const week = periodViewTotals(state, user, timeEntries, weekStart, weekEnd, liveNow)
  const month = periodViewTotals(state, user, timeEntries, monthStart, monthEnd, liveNow)
  const context = state.zeitguruAccounting?.[user.id]
  const summary = state.summaries.find((item) => item.userId === user.id)
  const todayKey = businessDateKey(liveNow)
  const [balanceYearStart] = clampDateRange(startOfYear(parseDateKey(todayKey)), parseDateKey(todayKey))
  const balanceWorkedMs = context && summary ? summary.year.workedMinutes * 60_000 : closedWorkedMsForEntries(timeEntries, user.id, balanceYearStart, todayKey)
  const balanceExpectedMs = context && summary ? summary.year.expectedMinutes * 60_000 : expectedMsForRange(user, state.absences, state.holidays, balanceYearStart, todayKey, {
    entriesForClosedTodayCheck: timeEntries,
  })
  const usedVacationDays = vacationUsedDaysForYear(user, state.absences, state.holidays, reference.getFullYear())
  const yearlyVacationDays = termForDate(user, referenceDate).yearlyVacationDays
  const remainingVacationDays = yearlyVacationDays + user.vacationAdjustmentDays - usedVacationDays
  const balanceAdjustmentMs = user.balanceAdjustmentMinutes * 60_000
  const balanceTodayMs = context && summary ? summary.year.plusMinusMinutes * 60_000 : balanceWorkedMs - balanceExpectedMs + balanceAdjustmentMs - balanceDeductionsForRange(state.requests, user.id, balanceYearStart, todayKey) * 60_000

  return (
    <details className="panel summary-panel collapsible-summary-panel">
      <summary className="panel-title summary-title">
        <div className="summary-heading">
          <Timer size={18} />
          <h2>{t.timeBalance}</h2>
        </div>
        <ChevronRight size={16} />
      </summary>
      <div className="summary-cards">
        {context && <p role="status">{context.openingKnown
          ? language === 'de' ? 'Zeitguru-Verlauf und bestätigter Anfangssaldo sind berücksichtigt. Laufende DCO-Stempelungen bleiben eigenständig.' : 'Zeitguru history and the confirmed opening balance are included. Live DCO clock entries remain separate.'
          : language === 'de' ? 'Der Anfangssaldo ist in Zeitguru nicht hinterlegt. Angezeigt werden Überstunden im Zeitraum; ein Gesamtsaldo einschließlich früherer Überträge ist nicht bestätigt.' : 'Zeitguru has no configured opening balance. Figures show overtime for the period; an overall balance including earlier carry is not confirmed.'}</p>}
        {summary?.balanceReviewRequired && <p role="status">{context ? language === 'de' ? 'Die importierte Abrechnung benötigt eine Prüfung. Details stehen unter „Tage mit Klärungsbedarf“.' : 'Imported accounting needs review. See “Days needing attention” for details.' : t.legacyBalanceReview}</p>}
        <Metric
          label={t.week}
          value={formatDuration(week.workedMs)}
          detail={`${t.expected}: ${formatDuration(week.expectedMs)} · ${t.balance}: ${formatSignedDuration(week.balanceMs)}`}
        />
        <Metric
          label={t.month}
          value={formatDuration(month.workedMs)}
          detail={`${t.expected}: ${formatDuration(month.expectedMs)} · ${t.balance}: ${formatSignedDuration(month.balanceMs)}`}
        />
        <Metric
          label={context && !context.openingKnown ? language === 'de' ? 'Überstunden im laufenden Jahr' : 'Overtime this year' : t.balanceToday}
          value={formatSignedDuration(balanceTodayMs)}
          detail={`${t.closedWorked}: ${formatDuration(balanceWorkedMs)} · ${t.expected}: ${formatDuration(balanceExpectedMs)}`}
        />
        <Metric
          label={t.vacation}
          value={formatShownNumber(remainingVacationDays)}
          detail={`${formatShownNumber(usedVacationDays)}/${formatShownNumber(yearlyVacationDays)} ${t.used}`}
        />
      </div>
    </details>
  )
}

function WorkedTimeLookupPanel({
  state,
  user,
  timeEntries,
  language,
  t,
}: {
  state: StatePayload
  user: User
  timeEntries: TimeEntry[]
  language: Language
  t: T
}) {
  const [period, setPeriod] = useState<WorkOverviewPeriod>('week')
  const [date, setDate] = useState(() => businessDateKey())
  const hasOpenEntry = timeEntries.some((entry) => entry.userId === user.id && !entry.stoppedAt)
  const liveNow = useLiveNow(hasOpenEntry)
  const dateBounds = useMemo(() => sensibleDateBounds(), [])
  const [startDate, endDate] = workOverviewDateRange(period, date)
  const { workedMs, expectedMs, balanceMs } = periodViewTotals(state, user, timeEntries, startDate, endDate, liveNow)
  const breakMs = breakMsForEntries(timeEntries, user.id, startDate, endDate, liveNow)
  const entryCount = timeEntries.filter((entry) => entry.userId === user.id && entry.date >= startDate && entry.date <= endDate).length
  const previousDate = shiftWorkOverviewDate(date, period, -1)
  const nextDate = shiftWorkOverviewDate(date, period, 1)

  return (
    <details className="panel worked-time-panel collapsible-summary-panel">
      <summary className="panel-title worked-time-title summary-title">
        <div className="summary-heading">
          <Timer size={18} />
          <h2>{t.workedTime}</h2>
        </div>
        <ChevronRight size={16} />
      </summary>
      <div className="worked-time-controls">
        <label>
          {t.workTimePeriod}
          <AppSelect
            ariaLabel={t.workTimePeriod}
            value={period}
            options={[
              { value: 'day', label: t.day },
              { value: 'week', label: t.week },
              { value: 'month', label: t.month },
            ]}
            onChange={(value) => setPeriod(value as WorkOverviewPeriod)}
          />
        </label>
        <div className="worked-time-date-controls">
          <button
            aria-label={t.previousPeriod}
            className="icon-button"
            disabled={!isSensibleDateKey(previousDate)}
            title={t.previousPeriod}
            type="button"
            onClick={() => setDate(previousDate)}
          >
            <ChevronLeft size={17} />
          </button>
          <label>
            {t.chooseWorkDate}
            <DateField
              ariaLabel={t.chooseWorkDate}
              language={language}
              max={dateBounds.max}
              min={dateBounds.min}
              selectionMode={period}
              title={t.chooseWorkDate}
              value={date}
              onChange={setDate}
            />
          </label>
          <button
            aria-label={t.nextPeriod}
            className="icon-button"
            disabled={!isSensibleDateKey(nextDate)}
            title={t.nextPeriod}
            type="button"
            onClick={() => setDate(nextDate)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <div className="worked-time-range">
          <span>{t.selectedRange}</span>
          <strong>{formatDateRange(startDate, endDate, language)}</strong>
        </div>
      </div>
      <div className="summary-cards worked-time-cards">
        <Metric label={t.worked} value={formatDuration(workedMs)} detail={`${formatShownNumber(entryCount)} ${t.entries}`} />
        <Metric label={t.breaks} value={formatDuration(breakMs)} detail={t.breakTaken} />
        <Metric label={t.expected} value={formatDuration(expectedMs)} detail={formatDateRange(startDate, endDate, language)} />
        <Metric label={state.zeitguruAccounting?.[user.id] ? language === 'de' ? 'Überstunden im Zeitraum' : 'Overtime for period' : t.balance} value={formatSignedDuration(balanceMs)} detail={state.zeitguruAccounting?.[user.id] ? language === 'de' ? 'Mit Zeitguru-Gutschriften und Tagessoll' : 'Includes Zeitguru credits and daily targets' : t.workedTime} />
      </div>
    </details>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function timeExportDateSelectionMode(period: TimeExportPeriod): DateFieldSelectionMode {
  if (period === 'week' || period === 'month' || period === 'year') {
    return period
  }

  return 'day'
}

function TimeExportPanel({
  users,
  selectedUserId,
  language,
  subtle = false,
  t,
  onExportCsv,
}: {
  users: User[]
  selectedUserId: string
  language: Language
  subtle?: boolean
  t: T
  onExportCsv: TimeCsvExport
}) {
  const [userId, setUserId] = useState(selectedUserId)
  const [period, setPeriod] = useState<TimeExportPeriod>('month')
  const [date, setDate] = useState(() => businessDateKey())
  const [validationError, setValidationError] = useState('')
  const [exportResult, setExportResult] = useState<TimeCsvExportResult | null>(null)
  const [exporting, setExporting] = useState(false)
  const downloadUrl = exportResult && 'url' in exportResult ? exportResult.url : undefined
  useEffect(() => () => {
    if (downloadUrl) window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000)
  }, [downloadUrl])
  const dateBounds = useMemo(() => sensibleDateBounds(), [])
  const referenceSelectionMode = timeExportDateSelectionMode(period)
  const selectedUser = users.find((user) => user.id === userId) ?? users[0]
  const canChooseUser = users.length > 1

  useEffect(() => {
    if (selectedUserId && users.some((user) => user.id === selectedUserId)) {
      setUserId(selectedUserId)
    }
  }, [selectedUserId, users])

  useEffect(() => {
    setValidationError('')
    setExportResult(null)
  }, [date, period, userId])

  const exportForm = (
    <form
      className="time-export-form"
      onSubmit={async (event) => {
        event.preventDefault()
        if (exporting) return
        if (period !== 'all' && !isSensibleDateKey(date)) {
          setValidationError(sensibleDateRangeMessage(t, language))
          return
        }
        setValidationError('')
        if (selectedUser) {
          setExporting(true)
          setExportResult(null)
          try { await onExportCsv(selectedUser.id, period, date, setExportResult) }
          catch (failure) { setExportResult({ error: failure instanceof Error ? failure.message : (language === 'de' ? 'Export fehlgeschlagen.' : 'Export failed.') }) }
          finally { setExporting(false) }
        }
      }}
    >
      {canChooseUser && (
        <label>
          {t.exportFor}
          <AppSelect
            ariaLabel={t.exportFor}
            value={selectedUser?.id ?? ''}
            options={users.map((user) => ({ value: user.id, label: displayUserName(user) }))}
            onChange={setUserId}
          />
        </label>
      )}
      <label>
        {t.exportPeriod}
        <AppSelect
          ariaLabel={t.exportPeriod}
          value={period}
          options={[
            { value: 'day', label: t.day },
            { value: 'week', label: t.week },
            { value: 'month', label: t.month },
            { value: 'year', label: t.year },
            { value: 'all', label: t.allTime },
          ]}
          onChange={(nextPeriod) => setPeriod(nextPeriod as TimeExportPeriod)}
        />
      </label>
      {period !== 'all' && (
        <label>
          {t.referenceDate}
          <DateField
            ariaLabel={t.referenceDate}
            language={language}
            max={dateBounds.max}
            min={dateBounds.min}
            selectionMode={referenceSelectionMode}
            title={t.referenceDate}
            value={date}
            onChange={setDate}
          />
        </label>
      )}
      {!selectedUser && <p role="status">{language === 'de' ? 'Bitte einen Mitarbeiter für den Export auswählen.' : 'Choose an employee to export.'}</p>}
      {validationError && <p className="form-error inline-form-error">{validationError}</p>}
      <button disabled={exporting || !selectedUser} aria-busy={exporting} className="primary-button" type="submit">
        <Download size={16} />
        {exporting ? (language === 'de' ? 'Export wird vorbereitet…' : 'Preparing export…') : t.exportCsv}
      </button>
      <div className="time-export-status" role={exportResult && 'error' in exportResult ? 'alert' : 'status'}>
        {exportResult && ('error' in exportResult ? <p className="form-error">{exportResult.error}</p> : <>
          <p>{language === 'de' ? 'Deine CSV-Datei ist bereit. Falls der Download nicht gestartet ist, nutze diesen Link:' : 'Your CSV is ready. If the download did not start, use this link:'}</p>
          <a className="secondary-button" href={exportResult.url} download={exportResult.filename}><Download size={16} />{language === 'de' ? 'CSV herunterladen' : 'Download CSV'}</a>
          <small>{exportResult.filename}</small>
        </>)}
      </div>
    </form>
  )

  if (subtle) {
    return (
      <details className="panel time-export-panel subtle-time-export-panel">
        <summary>
          <span>
            <Download size={16} />
            {t.csvExport}
          </span>
          <ChevronRight size={16} />
        </summary>
        {exportForm}
      </details>
    )
  }

  return (
    <section className="panel time-export-panel">
      <div className="panel-title">
        <Download size={18} />
        <h2>{t.csvExport}</h2>
      </div>
      {exportForm}
    </section>
  )
}

function ClockActivityLog({
  entries,
  userId,
  language,
  t,
}: {
  entries: TimeEntry[]
  userId: string
  language: Language
  t: T
}) {
  const [selectedDate, setSelectedDate] = useState(() => businessDateKey())
  const events = useMemo(
    () => clockActivityEventsForEntries(entries, userId).filter((event) => clockActivityDateKey(event) === selectedDate),
    [entries, selectedDate, userId],
  )

  return (
    <section className="panel clock-log-panel">
      <div className="panel-title clock-log-title">
        <div className="clock-log-heading">
          <Timer size={18} />
          <h2>{t.clockLog}</h2>
        </div>
        <div className="clock-log-controls">
          <button
            className="icon-button"
            title={t.previousDay}
            type="button"
            onClick={() => setSelectedDate((date) => addDays(date, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <DateField
            ariaLabel={t.chooseLogDate}
            language={language}
            title={t.chooseLogDate}
            value={selectedDate}
            onChange={setSelectedDate}
          />
          <button
            className="icon-button"
            title={t.nextDay}
            type="button"
            onClick={() => setSelectedDate((date) => addDays(date, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="muted clock-log-empty">{t.noClockEvents}</p>
      ) : (
        <div className="clock-log-list">
          {events.map((event) => (
            <article key={event.id} className="clock-log-row">
              <span className={classNames('clock-log-symbol', event.action)} title={clockActionLabel(event.action, t)}>
                <ClockActionIcon action={event.action} size={18} />
              </span>
              <strong>{clockActionLabel(event.action, t)}</strong>
              <time dateTime={event.at}>{formatProtocolTime(event.at, language)}</time>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function externalEventOccursOnDate(event: StatePayload['externalCalendarEvents'][number], date: string) {
  const startDate = businessDateKey(new Date(event.startAt))
  const end = new Date(event.endAt)
  if (event.isAllDay) {
    end.setDate(end.getDate() - 1)
  }
  const endDate = businessDateKey(end)
  return startDate <= date && date <= endDate
}

function externalEventTimeLabel(event: StatePayload['externalCalendarEvents'][number], language: Language, t: T) {
  if (event.isAllDay) {
    return t.allDay
  }

  const formatter = new Intl.DateTimeFormat(localeFor(language), timeOnlyFormatOptions(language))
  return `${formatter.format(new Date(event.startAt))}-${formatter.format(new Date(event.endAt))}`
}

function customEventTimeLabel(event: StatePayload['customCalendarEvents'][number], t: T) {
  if (event.isAllDay) {
    return t.allDay
  }
  return `${event.startTime ?? '--:--'}-${event.endTime ?? '--:--'}`
}

function sortCustomCalendarEvents(events: StatePayload['customCalendarEvents']) {
  return [...events].sort((left, right) => {
    const dateCompare = left.date.localeCompare(right.date)
    if (dateCompare !== 0) {
      return dateCompare
    }
    const timeCompare = (left.startTime ?? '').localeCompare(right.startTime ?? '')
    if (timeCompare !== 0) {
      return timeCompare
    }
    return left.title.localeCompare(right.title)
  })
}

function timeOnlyFormatOptions(language: Language, includeSeconds = false): Intl.DateTimeFormatOptions {
  return {
    timeZone: organizationTimezone(),
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    ...(language === 'de' ? { hour12: false } : {}),
  }
}

function formatTimeOnly(value: string, language: Language) {
  return new Intl.DateTimeFormat(localeFor(language), timeOnlyFormatOptions(language)).format(new Date(value))
}

function formatProtocolTime(value: string, language: Language) {
  return new Intl.DateTimeFormat(localeFor(language), timeOnlyFormatOptions(language, true)).format(new Date(value))
}

function formatDurationShort(milliseconds: number) {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}:${pad2(minutes)}`
}

function formatSignedDurationShort(milliseconds: number) {
  return `${milliseconds >= 0 ? '+' : '-'}${formatDurationShort(Math.abs(milliseconds))}`
}

function entriesForUserOnDate(entries: TimeEntry[], userId: string, date: string) {
  return entries
    .filter((entry) => entry.userId === userId && entry.date === date)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

function currentClockStatusForEntries(entries: TimeEntry[], userId: string): ClockStatus {
  const openEntry = entries
    .filter((entry) => entry.userId === userId && entry.source !== 'zeitguru' && !entry.stoppedAt)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]

  if (!openEntry) {
    return 'off_work'
  }

  return openEntry.breaks.some((segment) => !segment.stoppedAt) ? 'on_break' : 'working'
}

function openTimeEntryForUser(entries: TimeEntry[], userId: string) {
  return entries
    .filter((entry) => entry.userId === userId && entry.source !== 'zeitguru' && !entry.stoppedAt)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
}

function entryTimeRange(entry: TimeEntry, language: Language, t: T) {
  const endLabel = entry.stoppedAt ? formatTimeOnly(entry.stoppedAt, language) : t.runningNow
  const location = workLocationLabel(entry.workLocation, t)
  return [`${formatTimeOnly(entry.startedAt, language)}-${endLabel}`, location, entry.source === 'zeitguru' ? language === 'de' ? 'Zeitguru · schreibgeschützt' : 'Zeitguru · read-only' : ''].filter(Boolean).join(' · ')
}

function weekDayHeader(date: string, language: Language) {
  const parsed = parseDateKey(date)
  const weekday = new Intl.DateTimeFormat(localeFor(language), { weekday: 'short' }).format(parsed)
  const day = new Intl.DateTimeFormat(localeFor(language), { day: '2-digit', month: '2-digit' }).format(parsed)
  return `${weekday} ${day}`
}

interface CalendarTimedItem {
  id: string
  userId: string
  title: string
  meta: string
  kind: 'external_busy' | 'custom_event'
  startMinutes: number
  endMinutes: number
  customEventId?: string
}

interface CalendarAllDayItem {
  id: string
  userId?: string
  title: string
  meta?: string
  kind: AbsenceType | 'external_busy' | 'custom_event' | 'holiday'
  customEventId?: string
}

interface LaidOutCalendarTimedItem extends CalendarTimedItem {
  lane: number
  laneCount: number
}

const calendarInitialStartHour = 7
const calendarHourHeight = 58

function minutesFromTime(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const [hours, minutes] = value.split(':').map((item) => Number(item))
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : undefined
}

function minutesOfDay(date: Date) {
  return businessTimeMinutes(date)
}

function localDayBounds(dateKey: string) {
  const start = new Date(isoFromDateAndTime(dateKey, '00:00'))
  const end = new Date(isoFromDateAndTime(addDays(dateKey, 1), '00:00'))
  return { start, end }
}

function externalTimedItemForDate(
  event: StatePayload['externalCalendarEvents'][number],
  date: string,
  userById: Map<string, User>,
  language: Language,
  t: T,
): CalendarTimedItem | undefined {
  if (event.isAllDay || !externalEventOccursOnDate(event, date)) {
    return undefined
  }

  const { start: dayStart, end: dayEnd } = localDayBounds(date)
  const eventStart = new Date(event.startAt)
  const eventEnd = new Date(event.endAt)
  const clippedStart = new Date(Math.max(dayStart.getTime(), eventStart.getTime()))
  const clippedEnd = new Date(Math.min(dayEnd.getTime(), eventEnd.getTime()))
  const startMinutes = minutesOfDay(clippedStart)
  const endMinutes = clippedEnd.getTime() === dayEnd.getTime() ? 1440 : Math.max(startMinutes + 15, minutesOfDay(clippedEnd))

  return {
    id: `external-${event.id}-${date}`,
    userId: event.userId,
    title: event.title || t.busy,
    meta: `${displayUserName(userById.get(event.userId))} · ${externalEventTimeLabel(event, language, t)}`,
    kind: 'external_busy',
    startMinutes,
    endMinutes: Math.min(24 * 60, endMinutes),
  }
}

function customTimedItemForDate(
  event: StatePayload['customCalendarEvents'][number],
  date: string,
  userById: Map<string, User>,
  t: T,
): CalendarTimedItem | undefined {
  if (event.isAllDay || event.date !== date) {
    return undefined
  }

  const startMinutes = minutesFromTime(event.startTime)
  const endMinutes = minutesFromTime(event.endTime)
  if (startMinutes === undefined || endMinutes === undefined) {
    return undefined
  }

  return {
    id: `custom-${event.id}`,
    userId: event.userId,
    title: event.title,
    meta: `${displayUserName(userById.get(event.userId))} · ${customEventTimeLabel(event, t)}`,
    kind: 'custom_event',
    startMinutes,
    endMinutes: Math.max(startMinutes + 15, endMinutes),
    customEventId: event.id,
  }
}

function layoutTimedItems(items: CalendarTimedItem[]): LaidOutCalendarTimedItem[] {
  const sorted = [...items].sort((a,b) => a.startMinutes-b.startMinutes || a.endMinutes-b.endMinutes || a.id.localeCompare(b.id))
  const result: LaidOutCalendarTimedItem[] = []
  let group: CalendarTimedItem[] = [], groupEnd = 0
  function flush() {
    const laneEnds: number[] = [], visible: LaidOutCalendarTimedItem[] = []
    for (const item of group) {
      let lane = laneEnds.findIndex(end => end <= item.startMinutes)
      if (lane < 0) { if (laneEnds.length >= 3) continue; lane = laneEnds.length }
      laneEnds[lane] = item.endMinutes
      visible.push({...item,lane,laneCount:1})
    }
    result.push(...visible.map(item => ({...item,laneCount:laneEnds.length})))
    group = []
  }
  for (const item of sorted) {
    if (group.length && item.startMinutes >= groupEnd) flush()
    groupEnd = group.length ? Math.max(groupEnd,item.endMinutes) : item.endMinutes
    group.push(item)
  }
  flush()
  return result
}

function visibleClockStatus(status: ClockStatus | undefined) {
  return status === 'working' || status === 'on_break' ? status : undefined
}

function CalendarView({
  state,
  loading,
  language,
  t,
  onUpdateAccess,
  onCreateCalendarEvent,
  onUpdateCalendarEvent,
  onDeleteCalendarEvent,
  onCreateCalDavAccount,
  onUpdateCalDavAccount,
  onSyncCalDavAccount,
  onDeleteCalDavAccount,
  onExportCalendar,
}: {
  state: StatePayload
  loading: boolean
  language: Language
  t: T
  onUpdateAccess: (ids: string[]) => MutationResult
  onCreateCalendarEvent: (body: Record<string, unknown>) => MutationResult
  onUpdateCalendarEvent: (id: string, body: Record<string, unknown>) => MutationResult
  onDeleteCalendarEvent: (id: string) => MutationResult
  onCreateCalDavAccount: (body: Record<string, unknown>) => MutationResult
  onUpdateCalDavAccount: (id: string, body: Record<string, unknown>) => MutationResult
  onSyncCalDavAccount: (id: string) => MutationResult
  onDeleteCalDavAccount: (id: string) => MutationResult
  onExportCalendar: (mode: CalendarViewMode, date: string, userIds: string[]) => MutationResult
}) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month')
  const [anchorDate, setAnchorDate] = useState(() => businessDateKey())
  const [selectedUsers, setSelectedUsers] = useState<string[]>(() => state.visibleCalendarUsers.map((user) => user.id))
  const days = useMemo(() => calendarDaysForMode(viewMode, anchorDate), [anchorDate, viewMode])
  const weekdayHeaders = useMemo(() => weekdayHeadersForMode(viewMode, days, language), [days, language, viewMode])
  const anchorMonth = parseDateKey(anchorDate).getMonth()
  const holidayByDate = new Map(state.holidays.map((holiday) => [holiday.date, holiday]))
  const userById = new Map(state.users.map((user) => [user.id, user]))
  const [selectedCustomEventId, setSelectedCustomEventId] = useState<string | null>(null)
  const selectedCustomEvent = selectedCustomEventId
    ? state.customCalendarEvents.find(
        (event) => event.id === selectedCustomEventId && event.userId === state.currentUser.id,
      )
    : undefined

  useEffect(() => {
    setSelectedUsers((current) => {
      const visibleIds = new Set(state.visibleCalendarUsers.map((user) => user.id))
      const next = current.filter((id) => visibleIds.has(id))
      return next.length > 0 ? next : state.visibleCalendarUsers.map((user) => user.id)
    })
  }, [state.visibleCalendarUsers])

  useEffect(() => {
    if (selectedCustomEventId && !selectedCustomEvent) {
      setSelectedCustomEventId(null)
    }
  }, [selectedCustomEvent, selectedCustomEventId])

  function movePeriod(delta: number) {
    setAnchorDate((current) => shiftCalendarDate(current, viewMode, delta))
  }

  function changeViewMode(mode: CalendarViewMode) {
    setViewMode(mode)
    setAnchorDate((current) => normalizeDateFieldValue(current, mode))
  }

  function toggleSelected(id: string) {
    setSelectedUsers((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  return (
    <div className="calendar-layout">
      <section className="panel calendar-panel">
        <div className="calendar-header">
          <button className="icon-button" title={t.previousPeriod} type="button" onClick={() => movePeriod(-1)}>
            <ChevronLeft size={18} />
          </button>
          <div className="calendar-heading">
            <h2>{calendarPeriodTitle(viewMode, anchorDate, language)}</h2>
            <div className="calendar-controls">
              <div className="calendar-view-switch" aria-label={t.calendarViewMode}>
                {(['day', 'week', 'month'] satisfies CalendarViewMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={viewMode === mode ? 'active' : ''}
                    type="button"
                    onClick={() => changeViewMode(mode)}
                  >
                    {calendarModeLabel(mode, t)}
                  </button>
                ))}
              </div>
              <DateField
                ariaLabel={t.chooseCalendarDate}
                language={language}
                selectionMode={viewMode}
                title={t.chooseCalendarDate}
                value={anchorDate}
                onChange={setAnchorDate}
              />
            </div>
          </div>
          <button className="icon-button" title={t.nextPeriod} type="button" onClick={() => movePeriod(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="user-filter">
          {state.visibleCalendarUsers.map((user) => (
            <button
              key={user.id}
              className={selectedUsers.includes(user.id) ? 'active' : ''}
              type="button"
              onClick={() => toggleSelected(user.id)}
            >
              <Users size={16} />
              <span>{displayUserName(user)}</span>
              {visibleClockStatus(state.clockStatuses[user.id]) && (
                <small className={classNames('user-clock-chip', state.clockStatuses[user.id])}>
                  {clockStatusWithLocation(state.clockStatuses[user.id], state.clockLocations[user.id], t)}
                </small>
              )}
            </button>
          ))}
        </div>
        {viewMode === 'month' ? (
          <div className="calendar-viewport">
          <MonthCalendarGrid
            anchorMonth={anchorMonth}
            currentUserId={state.currentUser.id}
            days={days}
            holidayByDate={holidayByDate}
            language={language}
            selectedUsers={selectedUsers}
            state={state}
            t={t}
            userById={userById}
            weekdayHeaders={weekdayHeaders}
            onOpenCustomEvent={setSelectedCustomEventId}
          />
          </div>
        ) : (
          <TimedCalendarGrid
            currentUserId={state.currentUser.id}
            days={days}
            holidayByDate={holidayByDate}
            language={language}
            selectedUsers={selectedUsers}
            state={state}
            t={t}
            userById={userById}
            weekdayHeaders={weekdayHeaders}
            onOpenCustomEvent={setSelectedCustomEventId}
          />
        )}
        <div className="calendar-legend" aria-label={t.calendarLegend}>
          <span className="legend-item">
            <i className="legend-swatch holiday"><CalendarKindIcon kind="holiday" /></i>
            {t.publicHolidayLegend}
          </span>
          <span className="legend-item">
            <i className="legend-swatch vacation"><CalendarKindIcon kind="vacation" /></i>
            {t.vacationLegend}
          </span>
          <span className="legend-item">
            <i className="legend-swatch sick_leave"><CalendarKindIcon kind="sick_leave" /></i>
            {t.sickLeaveLegend}
          </span>
          <span className="legend-item">
            <i className="legend-swatch child_sick_leave"><CalendarKindIcon kind="child_sick_leave" /></i>
            {t.childSickLeave}
          </span>
          <span className="legend-item">
            <i className="legend-swatch overtime_time_off"><CalendarKindIcon kind="overtime_time_off" /></i>
            {t.timeOffLegend}
          </span>
          <span className="legend-item">
            <i className="legend-swatch external_busy"><CalendarKindIcon kind="external_busy" /></i>
            {t.busyLegend}
          </span>
          <span className="legend-item">
            <i className="legend-swatch custom_event"><CalendarKindIcon kind="custom_event" /></i>
            {t.customEventLegend}
          </span>
        </div>
        <div className="calendar-footer-actions">
          <button
            className="calendar-export-button"
            disabled={loading || selectedUsers.length === 0}
            type="button"
            onClick={() => onExportCalendar(viewMode, anchorDate, selectedUsers)}
          >
            <Download size={14} />
            {t.exportCalendar}
          </button>
        </div>
      </section>
      {selectedCustomEvent && (
        <CustomCalendarEventModal
          key={selectedCustomEvent.id}
          event={selectedCustomEvent}
          language={language}
          loading={loading || Boolean(state.readOnly)}
          t={t}
          onClose={() => setSelectedCustomEventId(null)}
          onDelete={onDeleteCalendarEvent}
          onUpdate={onUpdateCalendarEvent}
        />
      )}

      <div className="calendar-side-stack">
        <CalendarSharingPanel key={state.currentUser.id} users={state.shareableCalendarUsers}
          savedIds={state.currentUser.calendarAccessUserIds} language={language}
          disabled={loading || Boolean(state.readOnly)} onSave={onUpdateAccess} />

        <CustomCalendarEventsPanel
          events={state.customCalendarEvents.filter((event) => event.userId === state.currentUser.id)}
          language={language}
          loading={loading}
          t={t}
          onCreate={onCreateCalendarEvent}
          onUpdate={onUpdateCalendarEvent}
          onDelete={onDeleteCalendarEvent}
        />

        <CalDavSyncPanel
          accounts={state.calDavAccounts}
          language={language}
          loading={loading}
          t={t}
          onCreate={onCreateCalDavAccount}
          onUpdate={onUpdateCalDavAccount}
          onSync={onSyncCalDavAccount}
          onDelete={onDeleteCalDavAccount}
        />
      </div>
    </div>
  )
}

function MonthCalendarGrid({ anchorMonth, currentUserId, days, holidayByDate, language, selectedUsers, state, t, userById, weekdayHeaders, onOpenCustomEvent }: {
  anchorMonth: number; currentUserId: string; days: string[]; holidayByDate: Map<string, Holiday>; language: Language; selectedUsers: string[]; state: StatePayload; t: T; userById: Map<string, User>; weekdayHeaders: string[]; onOpenCustomEvent: (id: string) => void
}) {
  const today = businessDateKey()
  return <div className="calendar-grid calendar-grid-month">
    {weekdayHeaders.map((day,index) => <span className="weekday" key={day + index}>{day}</span>)}
    {days.map(date => {
      const items = [...allDayItemsForDate({date,holidayByDate,language,selectedUsers,state,t,userById}),
        ...timedItemsForDate({date,language,selectedUsers,state,t,userById}).sort((a,b) => a.startMinutes - b.startMinutes)]
      return <div key={date} data-date={date} className={classNames('calendar-day',date===today&&'today',parseDateKey(date).getMonth()!==anchorMonth&&'muted-day',isWeekend(date)&&'weekend')}>
        <span className="calendar-day-number">{Number(date.slice(8,10))}</span>
        <CalendarDayItems items={items} date={date} currentUserId={currentUserId} language={language} onOpenCustomEvent={onOpenCustomEvent}/>
      </div>
    })}
  </div>
}

function allDayItemsForDate({
  date,
  holidayByDate,
  language,
  selectedUsers,
  state,
  t,
  userById,
}: {
  date: string
  holidayByDate: Map<string, Holiday>
  language: Language
  selectedUsers: string[]
  state: StatePayload
  t: T
  userById: Map<string, User>
}) {
  const items: CalendarAllDayItem[] = []
  const holiday = holidayByDate.get(date)
  if (holiday) {
    items.push({ id: `holiday-${holiday.id}`, title: holidayDisplayLabel(holiday, language), kind: 'holiday' })
  }

  state.absences
    .filter((absence) => absence.date === date && selectedUsers.includes(absence.userId))
    .forEach((absence) =>
      items.push({
        id: absence.id,
        userId: absence.userId,
        title: `${displayUserName(userById.get(absence.userId))}: ${absenceLabel(absence.type, t)}`,
        kind: absence.type,
      }),
    )

  state.externalCalendarEvents
    .filter((event) => event.isAllDay && selectedUsers.includes(event.userId) && externalEventOccursOnDate(event, date))
    .forEach((event) =>
      items.push({
        id: `external-${event.id}-${date}`,
        userId: event.userId,
        title: event.title || t.busy,
        meta: `${displayUserName(userById.get(event.userId))} · ${t.allDay}`,
        kind: 'external_busy',
      }),
    )

  selectedUsers.forEach(userId => {
    const sourceAbsence = accountingDay(state.zeitguruAccounting?.[userId], date)?.absence
    if (sourceAbsence) items.push({ id: `zeitguru-${userId}-${date}`, userId, title: `${displayUserName(userById.get(userId))}: ${sourceAbsence.typeName} · Zeitguru`, kind: 'external_busy' })
  })

  sortCustomCalendarEvents(
    state.customCalendarEvents.filter((event) => event.isAllDay && selectedUsers.includes(event.userId) && event.date === date),
  ).forEach((event) =>
    items.push({
      id: `custom-${event.id}`,
      userId: event.userId,
      title: event.title,
      meta: `${displayUserName(userById.get(event.userId))} · ${t.allDay}`,
      kind: 'custom_event',
      customEventId: event.id,
    }),
  )

  return items
}

function timedItemsForDate({
  date,
  language,
  selectedUsers,
  state,
  t,
  userById,
}: {
  date: string
  language: Language
  selectedUsers: string[]
  state: StatePayload
  t: T
  userById: Map<string, User>
}) {
  const externalItems = state.externalCalendarEvents
    .filter((event) => selectedUsers.includes(event.userId))
    .map((event) => externalTimedItemForDate(event, date, userById, language, t))
    .filter((item): item is CalendarTimedItem => Boolean(item))
  const customItems = state.customCalendarEvents
    .filter((event) => selectedUsers.includes(event.userId))
    .map((event) => customTimedItemForDate(event, date, userById, t))
    .filter((item): item is CalendarTimedItem => Boolean(item))

  return [...externalItems, ...customItems]
}



function TimedCalendarGrid({
  currentUserId,
  days,
  holidayByDate,
  language,
  selectedUsers,
  state,
  t,
  userById,
  weekdayHeaders,
  onOpenCustomEvent,
}: {
  currentUserId: string
  days: string[]
  holidayByDate: Map<string, Holiday>
  language: Language
  selectedUsers: string[]
  state: StatePayload
  t: T
  userById: Map<string, User>
  weekdayHeaders: string[]
  onOpenCustomEvent: (id: string) => void
}) {
  const today = businessDateKey()
  const [agendaDate,setAgendaDate] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const firstDate = days[0]
  const dayCount = days.length
  const gridTemplateColumns = `64px repeat(${dayCount}, minmax(0, 1fr))`

  // Start at the morning when navigating, but preserve the user's scroll position on refresh.
  useLayoutEffect(() => {
    viewportRef.current?.scrollTo({ top: calendarInitialStartHour * calendarHourHeight, left: 0, behavior: 'instant' })
  }, [firstDate, dayCount])
  const timedByDate = new Map(
    days.map((date) => [
      date,
      timedItemsForDate({
        date,
        language,
        selectedUsers,
        state,
        t,
        userById,
      }),
    ]),
  )
  const laidOutByDate = new Map([...timedByDate].map(([date,items]) => [date,layoutTimedItems(items)]))
  const startHour = 0
  const endHour = 24
  const hourCount = endHour - startHour
  const timelineHeight = hourCount * calendarHourHeight
  const hourMarks = Array.from({ length: hourCount + 1 }, (_, index) => startHour + index)

  return (
    <>
    <div className="calendar-viewport calendar-viewport-timed" ref={viewportRef} tabIndex={0} role="region"
      aria-label={language === 'de' ? (dayCount === 1 ? 'Tageskalender' : 'Wochenkalender') : (dayCount === 1 ? 'Day calendar' : 'Week calendar')}>
    <div className={classNames('timed-calendar', dayCount === 1 ? 'timed-calendar-day' : 'timed-calendar-week')}
      style={{ minWidth: dayCount === 1 ? 0 : 64 + dayCount * 150 }}>
      <div className="timed-calendar-heading">
      <div className="timed-calendar-header" style={{ gridTemplateColumns }}>
        <span className="timed-axis-spacer"></span>
        {days.map((date, index) => {
          const activeUsers = date === today
            ? state.visibleCalendarUsers.filter(
                (user) => selectedUsers.includes(user.id) && visibleClockStatus(state.clockStatuses[user.id]),
              )
            : []
          return (
            <div className={classNames('timed-day-header', date === today && 'today', isWeekend(date) && 'weekend')} key={date}>
              <strong>{weekdayHeaders[index]}</strong>
              <small>{date}</small>
              {(timedByDate.get(date)!.length - laidOutByDate.get(date)!.length) > 0 && <button type="button" className="calendar-more-button" onClick={() => setAgendaDate(date)}>
                +{timedByDate.get(date)!.length - laidOutByDate.get(date)!.length} {language === 'de' ? 'weitere' : 'more'}
              </button>}
              {activeUsers.length > 0 && (
                <div className="timed-day-statuses">
                  {activeUsers.map((user) => (
                    <span key={user.id} className={classNames('calendar-status-chip', state.clockStatuses[user.id])}>
                      {displayUserName(user)} · {clockStatusWithLocation(state.clockStatuses[user.id], state.clockLocations[user.id], t)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="timed-calendar-all-day" style={{ gridTemplateColumns }}>
        <span className="timed-axis-label">{t.allDay}</span>
        {days.map((date) => (
          <div className={classNames('timed-all-day-cell', date === today && 'today')} key={date}>
            <CalendarDayItems items={allDayItemsForDate({date,holidayByDate,language,selectedUsers,state,t,userById})}
              date={date} currentUserId={currentUserId} language={language} onOpenCustomEvent={onOpenCustomEvent} limit={2}/>
          </div>
        ))}
      </div>

      </div>
      <div className="timed-calendar-body" style={{ gridTemplateColumns }}>
        <div className="calendar-time-axis" style={{ height: timelineHeight }}>
          {hourMarks.map((hour, index) => (
            <span key={hour} style={{ top: index * calendarHourHeight }}>
              {pad2(hour)}:00
            </span>
          ))}
        </div>
        {days.map((date) => (
          <div className={classNames('timed-day-column', date === today && 'today', isWeekend(date) && 'weekend')} key={date} style={{ height: timelineHeight }}>
            {hourMarks.slice(0, -1).map((hour, index) => (
              <i className="calendar-hour-line" key={hour} style={{ top: index * calendarHourHeight }}></i>
            ))}
            {(laidOutByDate.get(date) ?? []).map((item) => {
              const startMinutes = Math.max(item.startMinutes, startHour * 60)
              const endMinutes = Math.min(item.endMinutes, endHour * 60)
              const top = ((startMinutes - startHour * 60) / 60) * calendarHourHeight
              const height = Math.min(timelineHeight - top, Math.max(26, ((endMinutes - startMinutes) / 60) * calendarHourHeight - 4))
              const widthPercent = 100 / item.laneCount
              const leftPercent = item.lane * widthPercent
              const style = {
                top,
                height,
                left: `calc(${leftPercent}% + 4px)`,
                width: `calc(${widthPercent}% - 8px)`,
              }
              const content = (
                <>
                  <strong><CalendarKindIcon kind={item.kind} />{item.title}</strong>
                  <small>{item.meta}</small>
                </>
              )

              if (item.kind === 'custom_event' && item.userId === currentUserId && item.customEventId) {
                return (
                  <button
                    className={classNames('calendar-time-block', item.kind, 'calendar-event-button')}
                    key={item.id}
                    style={style}
                    title={t.editEvent}
                    type="button"
                    onClick={() => onOpenCustomEvent(item.customEventId!)}
                  >
                    {content}
                  </button>
                )
              }

              return (
                <button type="button" className={classNames('calendar-time-block', item.kind, 'calendar-event-button')} key={item.id} style={style} onClick={() => setAgendaDate(date)}>
                  {content}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
    </div>
      {agendaDate && <CalendarDayAgenda date={agendaDate} currentUserId={currentUserId} language={language}
        items={[...allDayItemsForDate({date:agendaDate,holidayByDate,language,selectedUsers,state,t,userById}),...(timedByDate.get(agendaDate)??[])]}
        onClose={() => setAgendaDate(null)} onOpenCustomEvent={id => {setAgendaDate(null);onOpenCustomEvent(id)}}/>}
    </>
  )
}

function AdminCalendarView({ state, language, t }: { state: StatePayload; language: Language; t: T }) {
  const [anchorDate, setAnchorDate] = useState(() => businessDateKey())

  return (
    <div className="admin-calendar-layout">
      <section className="panel admin-calendar-controls-panel">
        <div className="calendar-header">
          <button className="icon-button" title={t.previousPeriod} type="button" onClick={() => setAnchorDate((date) => addDays(date, -7))}>
            <ChevronLeft size={18} />
          </button>
          <div className="calendar-heading">
            <h2>{calendarPeriodTitle('week', anchorDate, language)}</h2>
            <div className="calendar-controls">
              <DateField
                ariaLabel={t.chooseCalendarDate}
                language={language}
                selectionMode="week"
                title={t.chooseCalendarDate}
                value={anchorDate}
                onChange={setAnchorDate}
              />
            </div>
          </div>
          <button className="icon-button" title={t.nextPeriod} type="button" onClick={() => setAnchorDate((date) => addDays(date, 7))}>
            <ChevronRight size={18} />
          </button>
        </div>
      </section>
      <AdminWorkCalendarPanel state={state} anchorDate={anchorDate} language={language} t={t} />
      <AdminWorkReportPanel state={state} language={language} t={t} />
    </div>
  )
}

function AdminWorkCalendarPanel({
  state,
  anchorDate,
  language,
  t,
}: {
  state: StatePayload
  anchorDate: string
  language: Language
  t: T
}) {
  const [selectedGroupId, setSelectedGroupId] = useState('all')
  const entries = state.adminTimeEntries ?? []
  const now = useLiveNow(entries.some((entry) => !entry.stoppedAt))
  const weekDays = useMemo(() => buildWeekDays(anchorDate), [anchorDate])
  const today = businessDateKey()
  const selectedMemberIds = useMemo(() => {
    const selectedGroup = state.calendarGroups.find((group) => group.id === selectedGroupId)
    return selectedGroup ? new Set(selectedGroup.memberUserIds) : undefined
  }, [selectedGroupId, state.calendarGroups])
  const employees = useMemo(
    () =>
      state.users
        .filter((user) => user.active && (!selectedMemberIds || selectedMemberIds.has(user.id)))
        .sort((left, right) => displayUserName(left).localeCompare(displayUserName(right), localeFor(language))),
    [language, selectedMemberIds, state.users],
  )

  useEffect(() => {
    if (selectedGroupId !== 'all' && !state.calendarGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId('all')
    }
  }, [selectedGroupId, state.calendarGroups])

  return (
    <section className="panel admin-work-calendar-panel">
      <div className="panel-title admin-work-calendar-title">
        <div className="admin-work-calendar-heading">
          <Timer size={18} />
          <div>
            <h2>{t.adminWorkCalendar}</h2>
            <small>{calendarPeriodTitle('week', anchorDate, language)}</small>
          </div>
        </div>
        <label className="admin-work-group-filter">
          {t.groupFilter}
          <AppSelect
            ariaLabel={t.groupFilter}
            value={selectedGroupId}
            options={[
              { value: 'all', label: t.allEmployees },
              ...state.calendarGroups.map((group) => ({ value: group.id, label: group.name })),
            ]}
            onChange={setSelectedGroupId}
          />
        </label>
      </div>

      {employees.length === 0 ? (
        <p className="muted admin-work-empty">{t.noEmployeesInSelection}</p>
      ) : (
        <div className="admin-work-calendar-wrap">
          <table className="admin-work-calendar-table">
            <thead>
              <tr>
                <th>{t.employee}</th>
                {weekDays.map((date) => (
                  <th className={date === today ? 'today' : undefined} key={date}>{weekDayHeader(date, language)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {employees.map((user) => {
                const status = currentClockStatusForEntries(entries, user.id)
                const openEntry = openTimeEntryForUser(entries, user.id)
                return (
                  <tr key={user.id}>
                    <th scope="row">
                      <strong>{displayUserName(user)}</strong>
                      <span className={classNames('work-status-chip', status)}>{clockStatusWithLocation(status, openEntry?.workLocation, t)}</span>
                    </th>
                    {weekDays.map((date) => {
                      const dayEntries = entriesForUserOnDate(entries, user.id, date)
                      const workedMs = dayEntries.reduce((total, entry) => total + entryWorkedMs(entry, now), 0)
                      const breakMs = dayEntries.reduce((total, entry) => total + entryBreakMs(entry, now), 0)
                      const sourceAbsence = accountingDay(state.zeitguruAccounting?.[user.id], date)?.absence
                      return (
                        <td key={date} className={classNames(date === today && 'today', dayEntries.length === 0 && 'empty-work-day')}>
                          {sourceAbsence && <small className="absence-pill external_busy">{sourceAbsence.typeName} · Zeitguru</small>}
                          {dayEntries.length === 0 ? (
                            <span>-</span>
                          ) : (
                            <>
                              <strong>{formatDurationShort(workedMs)}</strong>
                              <div className="work-time-ranges">
                                {dayEntries.map((entry) => (
                                  <small key={entry.id}>{entryTimeRange(entry, language, t)}</small>
                                ))}
                              </div>
                              {breakMs > 0 && (
                                <small className="work-break-summary">
                                  {t.breakTaken}: {formatDurationShort(breakMs)}
                                </small>
                              )}
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function AdminWorkReportPanel({ state, language, t }: { state: StatePayload; language: Language; t: T }) {
  const entries = state.adminTimeEntries ?? []
  const now = useLiveNow(entries.some((entry) => !entry.stoppedAt))
  const dateBounds = sensibleDateBounds()
  const [fromDate, setFromDate] = useState(() => toDateKey(startOfWeek(new Date())))
  const [toDate, setToDate] = useState(() => toDateKey(endOfWeek(new Date())))
  const [selectedGroupId, setSelectedGroupId] = useState('all')
  const [search, setSearch] = useState('')
  const activeUsers = useMemo(
    () =>
      state.users
        .filter((user) => user.active)
        .sort((left, right) => displayUserName(left).localeCompare(displayUserName(right), localeFor(language))),
    [language, state.users],
  )
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const activeUserIds = useMemo(() => new Set(activeUsers.map((user) => user.id)), [activeUsers])
  const groupNamesByUserId = useMemo(() => {
    const names = new Map<string, string[]>()
    state.calendarGroups.forEach((group) => {
      group.memberUserIds.forEach((userId) => {
        const current = names.get(userId) ?? []
        current.push(group.name)
        names.set(userId, current)
      })
    })
    return names
  }, [state.calendarGroups])
  const selectedUserIdSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds])
  const selectedGroup = state.calendarGroups.find((group) => group.id === selectedGroupId)
  const filteredGroupUserIds = selectedGroup ? new Set(selectedGroup.memberUserIds) : undefined
  const normalizedSearch = search.trim().toLowerCase()
  const visibleUsers = activeUsers.filter((user) => {
    if (filteredGroupUserIds && !filteredGroupUserIds.has(user.id)) {
      return false
    }

    const userGroupNames = groupNamesByUserId.get(user.id)?.join(' ') ?? ''
    const searchableText = `${displayUserName(user)} ${user.email ?? ''} ${userGroupNames}`.toLowerCase()
    return !normalizedSearch || searchableText.includes(normalizedSearch)
  })
  const [rangeStart, rangeEnd] = fromDate <= toDate ? [fromDate, toDate] : [toDate, fromDate]
  const selectedUsers = activeUsers.filter((user) => selectedUserIdSet.has(user.id))
  const reportRows = selectedUsers.map((user) => {
    const userEntries = entries.filter((entry) => entry.userId === user.id && entry.date >= rangeStart && entry.date <= rangeEnd)
    const { workedMs, expectedMs, balanceMs } = periodViewTotals(state, user, entries, rangeStart, rangeEnd, now)
    const breakMs = userEntries.reduce((total, entry) => total + entryBreakMs(entry, now), 0)
    const status = currentClockStatusForEntries(entries, user.id)
    const openEntry = openTimeEntryForUser(entries, user.id)
    return {
      user,
      status,
      workLocation: openEntry?.workLocation,
      workedMs,
      breakMs,
      expectedMs,
      balanceMs,
      entryCount: userEntries.length,
    }
  })
  const reportTotals = reportRows.reduce(
    (totals, row) => ({
      workedMs: totals.workedMs + row.workedMs,
      breakMs: totals.breakMs + row.breakMs,
      expectedMs: totals.expectedMs + row.expectedMs,
      balanceMs: totals.balanceMs + row.balanceMs,
      entryCount: totals.entryCount + row.entryCount,
    }),
    { workedMs: 0, breakMs: 0, expectedMs: 0, balanceMs: 0, entryCount: 0 },
  )

  useEffect(() => {
    setSelectedUserIds((current) => current.filter((id) => activeUserIds.has(id)))
  }, [activeUserIds])

  useEffect(() => {
    if (selectedGroupId !== 'all' && !state.calendarGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId('all')
    }
  }, [selectedGroupId, state.calendarGroups])

  function toggleUser(userId: string) {
    setSelectedUserIds((current) => (current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]))
  }

  function selectVisibleUsers() {
    setSelectedUserIds((current) => [...new Set([...current, ...visibleUsers.map((user) => user.id)])])
  }

  function setCurrentWeek() {
    const today = new Date()
    setFromDate(toDateKey(startOfWeek(today)))
    setToDate(toDateKey(endOfWeek(today)))
  }

  function setCurrentMonth() {
    const today = new Date()
    setFromDate(toDateKey(startOfMonth(today)))
    setToDate(toDateKey(endOfMonth(today)))
  }

  function setCurrentYear() {
    const today = new Date()
    setFromDate(toDateKey(startOfYear(today)))
    setToDate(toDateKey(endOfYear(today)))
  }

  return (
    <section className="panel admin-work-report-panel">
      <div className="panel-title admin-work-report-title">
        <div className="admin-work-calendar-heading">
          <BriefcaseBusiness size={18} />
          <div>
            <h2>{t.adminWorkReport}</h2>
            <small>{`${formatDateKey(rangeStart, language)} - ${formatDateKey(rangeEnd, language)}`}</small>
          </div>
        </div>
        <span className="member-chip">{t.selectedUsersCount.replace('{count}', formatShownNumber(selectedUserIds.length))}</span>
      </div>

      <div className="admin-work-report-controls">
        <label>
          {t.requestFrom}
          <DateField
            ariaLabel={t.requestFrom}
            language={language}
            max={dateBounds.max}
            min={dateBounds.min}
            value={fromDate}
            onChange={setFromDate}
          />
        </label>
        <label>
          {t.requestTo}
          <DateField
            ariaLabel={t.requestTo}
            language={language}
            max={dateBounds.max}
            min={dateBounds.min}
            value={toDate}
            onChange={setToDate}
          />
        </label>
        <div className="admin-work-report-presets">
          <button className="secondary-button" type="button" onClick={setCurrentWeek}>
            {t.currentWeek}
          </button>
          <button className="secondary-button" type="button" onClick={setCurrentMonth}>
            {t.thisMonth}
          </button>
          <button className="secondary-button" type="button" onClick={setCurrentYear}>
            {t.year}
          </button>
        </div>
      </div>

      <div className="admin-work-report-body">
        <aside className="admin-work-report-users">
          <div className="admin-work-report-user-filters">
            <label>
              {t.groupFilter}
              <AppSelect
                ariaLabel={t.groupFilter}
                value={selectedGroupId}
                options={[
                  { value: 'all', label: t.allEmployees },
                  ...state.calendarGroups.map((group) => ({ value: group.id, label: group.name })),
                ]}
                onChange={setSelectedGroupId}
              />
            </label>
            <label>
              {t.searchUsers}
              <input value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <div className="admin-work-report-selection-actions">
            <button className="secondary-button" type="button" onClick={selectVisibleUsers}>
              <Check size={16} />
              {t.selectVisibleUsers}
            </button>
            <button className="secondary-button" type="button" onClick={() => setSelectedUserIds([])}>
              <X size={16} />
              {t.clearSelection}
            </button>
          </div>
          <div className="admin-work-report-user-list">
            {visibleUsers.map((user) => {
              const groupNames = groupNamesByUserId.get(user.id)?.join(', ')
              return (
                <label className="admin-work-report-user-row" key={user.id}>
                  <input checked={selectedUserIdSet.has(user.id)} type="checkbox" onChange={() => toggleUser(user.id)} />
                  <span>
                    <strong>{displayUserName(user)}</strong>
                    <small>{[user.email, groupNames].filter(Boolean).join(' · ')}</small>
                  </span>
                </label>
              )
            })}
            {visibleUsers.length === 0 && <p className="muted">{t.noEmployeesInSelection}</p>}
          </div>
        </aside>

        <div className="admin-work-report-results">
          {selectedUsers.some(user => state.zeitguruAccounting?.[user.id]) && <p className="muted">{language === 'de' ? 'Überstunden im gewählten Zeitraum berücksichtigen die Zeitguru-Tagesabrechnung. Ohne bestätigten Anfangssaldo ist dies kein vollständiges Gesamtstundenkonto.' : 'Overtime for the selected period includes Zeitguru daily accounting. Without a confirmed opening balance, this is not a complete overall hours balance.'}</p>}
          {reportRows.length === 0 ? (
            <p className="muted admin-work-empty">{t.noReportUsersSelected}</p>
          ) : (
            <div className="admin-work-report-table-wrap">
              <table className="admin-work-report-table">
                <thead>
                  <tr>
                    <th>{t.employee}</th>
                    <th>{t.clockedIn}</th>
                    <th>{t.worked}</th>
                    <th>{t.breaks}</th>
                    <th>{t.expected}</th>
                    <th>{t.balance}</th>
                    <th>{t.entries}</th>
                  </tr>
                </thead>
                <tbody>
                  {reportRows.map((row) => (
                    <tr key={row.user.id}>
                      <th scope="row">{displayUserName(row.user)}</th>
                      <td>
                        <span className={classNames('work-status-chip', row.status)}>{clockStatusWithLocation(row.status, row.workLocation, t)}</span>
                      </td>
                      <td>{formatDurationShort(row.workedMs)}</td>
                      <td>{formatDurationShort(row.breakMs)}</td>
                      <td>{formatDurationShort(row.expectedMs)}</td>
                      <td className={row.balanceMs < 0 ? 'negative-balance' : 'positive-balance'}>
                        {formatSignedDurationShort(row.balanceMs)}
                      </td>
                      <td>{formatShownNumber(row.entryCount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{t.total}</th>
                    <td>-</td>
                    <td>{formatDurationShort(reportTotals.workedMs)}</td>
                    <td>{formatDurationShort(reportTotals.breakMs)}</td>
                    <td>{formatDurationShort(reportTotals.expectedMs)}</td>
                    <td className={reportTotals.balanceMs < 0 ? 'negative-balance' : 'positive-balance'}>
                      {formatSignedDurationShort(reportTotals.balanceMs)}
                    </td>
                    <td>{formatShownNumber(reportTotals.entryCount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function defaultCalendarEventDate() {
  return businessDateKey()
}

function CustomCalendarEventsPanel({
  events,
  language,
  loading,
  t,
  onCreate,
  onUpdate,
  onDelete,
}: {
  events: StatePayload['customCalendarEvents']
  language: Language
  loading: boolean
  t: T
  onCreate: (body: Record<string, unknown>) => MutationResult
  onUpdate: (id: string, body: Record<string, unknown>) => MutationResult
  onDelete: (id: string) => MutationResult
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(defaultCalendarEventDate)
  const [isAllDay, setIsAllDay] = useState(true)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [shareWithCalendarUsers, setShareWithCalendarUsers] = useState(false)

  const [search,setSearch] = useState(''), [page,setPage] = useState(0)
  const filteredEvents = useMemo(() => sortCustomCalendarEvents(events).filter(event => (event.title+' '+(event.description??'')+' '+event.date).toLocaleLowerCase(language).includes(search.trim().toLocaleLowerCase(language))), [events,search,language])
  const pages = Math.max(1,Math.ceil(filteredEvents.length/10)), currentPage = Math.min(page,pages-1)

  function reset() {
    setTitle('')
    setDescription('')
    setDate(defaultCalendarEventDate())
    setIsAllDay(true)
    setStartTime('09:00')
    setEndTime('10:00')
    setShareWithCalendarUsers(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onCreate({ title, description, date, isAllDay, startTime, endTime, shareWithCalendarUsers })
    if (saved) {
      reset()
    }
  }

  return (
    <section className="panel custom-events-panel">
      <div className="panel-title">
        <CalendarDays size={18} />
        <h2>{t.customCalendarEvents}</h2>
      </div>
      <form className="custom-event-form" onSubmit={submit}>
        <label>
          {t.eventTitle}
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          {t.date}
          <DateField language={language} title={t.date} value={date} onChange={setDate} />
        </label>
        <label className="toggle-row">
          <input checked={isAllDay} type="checkbox" onChange={(event) => setIsAllDay(event.target.checked)} />
          {t.allDayEvent}
        </label>
        {!isAllDay && (
          <div className="custom-event-time-grid">
            <label>
              {t.start}
              <input value={startTime} type="time" onChange={(event) => setStartTime(event.target.value)} />
            </label>
            <label>
              {t.end}
              <input value={endTime} type="time" onChange={(event) => setEndTime(event.target.value)} />
            </label>
          </div>
        )}
        <label>
          {t.eventDescription}
          <textarea value={description} rows={3} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="toggle-row">
          <input
            checked={shareWithCalendarUsers}
            type="checkbox"
            onChange={(event) => setShareWithCalendarUsers(event.target.checked)}
          />
          {t.shareEventWithCalendarUsers}
        </label>
        <button
          disabled={loading || !title.trim() || !date || (!isAllDay && (!startTime || !endTime || startTime >= endTime))}
          className="primary-button"
          type="submit"
        >
          <Check size={16} />
          {t.saveEvent}
        </button>
      </form>
      <label className="calendar-own-search">{language === 'de' ? 'Eigene Termine durchsuchen' : 'Search own events'}<input type="search" value={search} onChange={event => {setSearch(event.target.value);setPage(0)}}/></label>
      <div className="custom-event-list">
        {events.length === 0 && <p className="muted">{t.noCustomCalendarEvents}</p>}
        {filteredEvents.slice(currentPage*10,(currentPage+1)*10).map((event) => (
          <CustomCalendarEventRow
            key={event.id}
            event={event}
            language={language}
            loading={loading}
            t={t}
            onUpdate={onUpdate}
            onDelete={onDelete}
          />
        ))}
      </div>
      {!filteredEvents.length && events.length > 0 && <p className="calendar-list-empty">{language === 'de' ? 'Keine passenden Termine.' : 'No matching events.'}</p>}
      {pages > 1 && <nav className="calendar-agenda-pagination" aria-label={language === 'de' ? 'Eigene Terminseiten' : 'Own event pages'}><button className="secondary-button" type="button" disabled={!currentPage} onClick={() => setPage(currentPage-1)}>{language === 'de' ? 'Zurück' : 'Previous'}</button><span>{currentPage+1} / {pages}</span><button className="secondary-button" type="button" disabled={currentPage+1>=pages} onClick={() => setPage(currentPage+1)}>{language === 'de' ? 'Weiter' : 'Next'}</button></nav>}
    </section>
  )
}

function CustomCalendarEventRow({
  event,
  language,
  loading,
  t,
  onUpdate,
  onDelete,
}: {
  event: StatePayload['customCalendarEvents'][number]
  language: Language
  loading: boolean
  t: T
  onUpdate: (id: string, body: Record<string, unknown>) => MutationResult
  onDelete: (id: string) => MutationResult
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [title, setTitle] = useState(event.title)
  const [description, setDescription] = useState(event.description ?? '')
  const [date, setDate] = useState(event.date)
  const [isAllDay, setIsAllDay] = useState(event.isAllDay)
  const [startTime, setStartTime] = useState(event.startTime ?? '09:00')
  const [endTime, setEndTime] = useState(event.endTime ?? '10:00')
  const [shareWithCalendarUsers, setShareWithCalendarUsers] = useState(event.shareWithCalendarUsers)

  useEffect(() => {
    setTitle(event.title)
    setDescription(event.description ?? '')
    setDate(event.date)
    setIsAllDay(event.isAllDay)
    setStartTime(event.startTime ?? '09:00')
    setEndTime(event.endTime ?? '10:00')
    setShareWithCalendarUsers(event.shareWithCalendarUsers)
  }, [event])

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault()
    const saved = await onUpdate(event.id, { title, description, date, isAllDay, startTime, endTime, shareWithCalendarUsers })
    if (saved) {
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <article className="custom-event-row">
        <div>
          <strong>{event.title}</strong>
          <small>
          {formatDateKey(event.date, language)} · {customEventTimeLabel(event, t)}
        </small>
        {event.description && <p>{event.description}</p>}
          <small>{event.shareWithCalendarUsers ? t.sharedEvent : t.privateEvent}</small>
        </div>
        <div className="custom-event-actions">
          <button disabled={loading} className="icon-button" title={t.editEvent} type="button" onClick={() => setEditing(true)}>
            <Pencil size={16} />
          </button>
          <button disabled={loading} className="icon-button reject" title={t.deleteEvent} type="button" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} />
          </button>
        </div>
        {confirmDelete && (
          <ConfirmDialog
            title={t.deleteEvent}
            confirmTone="danger"
            body={event.title}
            confirmLabel={t.deleteEvent}
            cancelLabel={t.cancel}
            loading={loading}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => {
              const saved = await onDelete(event.id)
              if (saved) {
                setConfirmDelete(false)
              }
            }}
          />
        )}
      </article>
    )
  }

  return (
    <form className="custom-event-row custom-event-edit-row" onSubmit={submit}>
      <label>
        {t.eventTitle}
        <input value={title} onChange={(inputEvent) => setTitle(inputEvent.target.value)} />
      </label>
      <label>
        {t.date}
        <DateField language={language} title={t.date} value={date} onChange={setDate} />
      </label>
      <label className="toggle-row">
        <input checked={isAllDay} type="checkbox" onChange={(inputEvent) => setIsAllDay(inputEvent.target.checked)} />
        {t.allDayEvent}
      </label>
      {!isAllDay && (
        <div className="custom-event-time-grid">
          <label>
            {t.start}
            <input value={startTime} type="time" onChange={(inputEvent) => setStartTime(inputEvent.target.value)} />
          </label>
          <label>
            {t.end}
            <input value={endTime} type="time" onChange={(inputEvent) => setEndTime(inputEvent.target.value)} />
          </label>
        </div>
      )}
      <label>
        {t.eventDescription}
        <textarea value={description} rows={3} onChange={(inputEvent) => setDescription(inputEvent.target.value)} />
      </label>
      <label className="toggle-row">
        <input
          checked={shareWithCalendarUsers}
          type="checkbox"
          onChange={(inputEvent) => setShareWithCalendarUsers(inputEvent.target.checked)}
        />
        {t.shareEventWithCalendarUsers}
      </label>
      <div className="custom-event-edit-actions">
        <button
          disabled={loading || !title.trim() || !date || (!isAllDay && (!startTime || !endTime || startTime >= endTime))}
          className="secondary-button"
          type="submit"
        >
          <Check size={16} />
          {t.updateEvent}
        </button>
        <button className="secondary-button" type="button" onClick={() => setEditing(false)}>
          <X size={16} />
          {t.cancel}
        </button>
      </div>
    </form>
  )
}

function CalDavSyncPanel({
  accounts,
  language,
  loading,
  t,
  onCreate,
  onUpdate,
  onSync,
  onDelete,
}: {
  accounts: StatePayload['calDavAccounts']
  language: Language
  loading: boolean
  t: T
  onCreate: (body: Record<string, unknown>) => MutationResult
  onUpdate: (id: string, body: Record<string, unknown>) => MutationResult
  onSync: (id: string) => MutationResult
  onDelete: (id: string) => MutationResult
}) {
  const [name, setName] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [calendarUrl, setCalendarUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [shareEventTitles, setShareEventTitles] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onCreate({ name, serverUrl, calendarUrl, username, password, shareEventTitles })
    if (saved) {
      setName('')
      setServerUrl('')
      setCalendarUrl('')
      setUsername('')
      setPassword('')
      setShareEventTitles(false)
    }
  }

  return (
    <section className="panel caldav-panel">
      <div className="panel-title">
        <CalendarDays size={18} />
        <h2>{t.calDavSync}</h2>
      </div>
      <p className="mail-server-note">{t.calDavHint}</p>
      <p className="mail-server-note">{t.calDavPrivacyHint}</p>
      <form className="caldav-form" onSubmit={submit}>
        <label>
          {t.calDavName}
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nextcloud" />
        </label>
        <label>
          {t.calDavServerUrl}
          <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://cloud.example.com/remote.php/dav" />
        </label>
        <label>
          {t.calDavCalendarUrl}
          <input value={calendarUrl} onChange={(event) => setCalendarUrl(event.target.value)} placeholder="https://..." />
        </label>
        <label>
          {t.calDavUsername}
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          {t.calDavPassword}
          <PasswordInput aria-label={t.calDavPassword} language={language} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        </label>
        <label className="toggle-row">
          <input checked={shareEventTitles} type="checkbox" onChange={(event) => setShareEventTitles(event.target.checked)} />
          {t.shareCalDavTitles}
        </label>
        <button disabled={loading || !serverUrl.trim() || !username.trim() || !password} className="primary-button" type="submit">
          <Check size={16} />
          {t.addCalDavAccount}
        </button>
      </form>
      <div className="caldav-list">
        {accounts.length === 0 && <p className="muted">{t.noCalDavAccounts}</p>}
        {accounts.map((account) => (
          <CalDavAccountRow
            key={account.id}
            account={account}
            language={language}
            loading={loading}
            t={t}
            onUpdate={onUpdate}
            onSync={onSync}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  )
}

function CalDavAccountRow({
  account,
  language,
  loading,
  t,
  onUpdate,
  onSync,
  onDelete,
}: {
  account: StatePayload['calDavAccounts'][number]
  language: Language
  loading: boolean
  t: T
  onUpdate: (id: string, body: Record<string, unknown>) => MutationResult
  onSync: (id: string) => MutationResult
  onDelete: (id: string) => MutationResult
}) {
  const [name, setName] = useState(account.name)
  const [serverUrl, setServerUrl] = useState(account.serverUrl)
  const [calendarUrl, setCalendarUrl] = useState(account.calendarUrl ?? '')
  const [username, setUsername] = useState(account.username)
  const [password, setPassword] = useState('')
  const [shareEventTitles, setShareEventTitles] = useState(account.shareEventTitles)
  const [syncEnabled, setSyncEnabled] = useState(account.syncEnabled)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setName(account.name)
    setServerUrl(account.serverUrl)
    setCalendarUrl(account.calendarUrl ?? '')
    setUsername(account.username)
    setPassword('')
    setShareEventTitles(account.shareEventTitles)
    setSyncEnabled(account.syncEnabled)
  }, [account])

  function submit(event: FormEvent) {
    event.preventDefault()
    onUpdate(account.id, {
      name,
      serverUrl,
      calendarUrl,
      username,
      password,
      shareEventTitles,
      syncEnabled,
    })
  }

  return (
    <form className="caldav-account-row" onSubmit={submit}>
      <div className="caldav-account-status">
        <strong>{account.name}</strong>
        <small>{account.calendarName || account.calendarUrl || account.serverUrl}</small>
        <small>
          {t.lastSync}: {account.lastSyncAt ? formatDateTime(account.lastSyncAt, language) : t.neverSynced}
          {account.lastSyncStatus === 'error' && account.lastSyncError ? ` · ${account.lastSyncError}` : ''}
        </small>
      </div>
      <div className="caldav-edit-grid">
        <label>
          {t.calDavName}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t.calDavServerUrl}
          <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} />
        </label>
        <label>
          {t.calDavCalendarUrl}
          <input value={calendarUrl} onChange={(event) => setCalendarUrl(event.target.value)} />
        </label>
        <label>
          {t.calDavUsername}
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          {t.calDavPassword}
          <PasswordInput aria-label={t.calDavPassword} language={language}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={account.passwordConfigured ? t.calDavPasswordPlaceholder : ''}
            autoComplete="new-password"
          />
        </label>
      </div>
      <div className="caldav-actions">
        <label className="toggle-row">
          <input checked={shareEventTitles} type="checkbox" onChange={(event) => setShareEventTitles(event.target.checked)} />
          {t.shareCalDavTitles}
        </label>
        <label className="toggle-row">
          <input checked={syncEnabled} type="checkbox" onChange={(event) => setSyncEnabled(event.target.checked)} />
          {t.syncEnabled}
        </label>
        <button disabled={loading || !serverUrl.trim() || !username.trim()} className="secondary-button" type="submit">
          <Check size={16} />
          {t.saveCalDavAccount}
        </button>
        <button disabled={loading} className="secondary-button" type="button" onClick={() => onSync(account.id)}>
          <RotateCcw size={16} />
          {t.syncNow}
        </button>
        <button disabled={loading} className="icon-button reject" title={t.deleteCalDavAccount} type="button" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={16} />
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t.deleteCalDavAccount}
          body={account.name}
          confirmLabel={t.deleteCalDavAccount}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const saved = await onDelete(account.id)
            if (saved) {
              setConfirmDelete(false)
            }
          }}
        />
      )}
    </form>
  )
}

function RequestsView({
  state,
  language,
  loading,
  selectedRequestId,
  t,
  onCreate,
  onDecision,
  onUpdateRequest,
  onCancelRequest,
}: {
  state: StatePayload
  language: Language
  loading: boolean
  selectedRequestId: string
  t: T
  onCreate: (body: Record<string, unknown>) => MutationResult
  onDecision: (requestId: string, decision: 'approved' | 'rejected') => MutationResult
  onUpdateRequest: (requestId: string, body: Record<string, unknown>) => MutationResult
  onCancelRequest: (requestId: string) => MutationResult
}) {
  const isAdmin = state.currentUser.role === 'admin'
  const preparedDraftKey = requestDraftStorageKey(state.currentUser.id)
  const [adminMode, setAdminMode] = useState(() => isAdmin && !readRequestFormDraft(preparedDraftKey))
  const [requestFrom, setRequestFrom] = useState(() => toDateKey(startOfWeek(new Date())))
  const [requestTo, setRequestTo] = useState(() => toDateKey(endOfWeek(new Date())))
  const [statusFilter, setStatusFilter] = useState<RequestItem['status'] | 'all'>('all')
  const [includeOpenRequests, setIncludeOpenRequests] = useState(true)
  const [showAllRequests, setShowAllRequests] = useState(false)
  const requestDateBounds = useMemo(() => sensibleDateBounds(), [])
  const visibleRequests = state.requests
    .filter((request) => {
      const selectedDeepLink = request.id === selectedRequestId
      const openBypass = includeOpenRequests && request.status === 'pending'
      const matchesStatus = statusFilter === 'all' || request.status === statusFilter
      const matchesRange = showAllRequests || requestOverlapsDateRange(request, requestFrom, requestTo)
      return selectedDeepLink || openBypass || (matchesStatus && matchesRange)
    })
    .sort(sortRequestsForAdmin)

  function setCurrentMonthFilter() {
    const today = new Date()
    setRequestFrom(toDateKey(startOfMonth(today)))
    setRequestTo(toDateKey(endOfMonth(today)))
    setShowAllRequests(false)
  }

  function setCurrentYearFilter() {
    const today = new Date()
    setRequestFrom(toDateKey(startOfYear(today)))
    setRequestTo(toDateKey(endOfYear(today)))
    setShowAllRequests(false)
  }

  function setCurrentWeekFilter() {
    const today = new Date()
    setRequestFrom(toDateKey(startOfWeek(today)))
    setRequestTo(toDateKey(endOfWeek(today)))
    setShowAllRequests(false)
  }

  const requestFilterBar = (className?: string) => (
    <div className={classNames('request-filter-bar', className)}>
      <div className="request-filter-title">{t.requestTimeframe}</div>
      <label>
        {t.requestStatusFilter}
        <AppSelect
          ariaLabel={t.requestStatusFilter}
          value={statusFilter}
          options={[
            { value: 'all', label: t.allStatuses },
            { value: 'pending', label: t.pending },
            { value: 'approved', label: t.approved },
            { value: 'rejected', label: t.rejected },
            { value: 'undone', label: t.undone },
          ]}
          onChange={(value) => setStatusFilter(value as RequestItem['status'] | 'all')}
        />
      </label>
      <label>
        {t.requestFrom}
        <DateField
          disabled={showAllRequests}
          language={language}
          max={requestDateBounds.max}
          min={requestDateBounds.min}
          title={t.requestFrom}
          value={requestFrom}
          onChange={(value) => {
            setRequestFrom(value)
            setShowAllRequests(false)
          }}
        />
      </label>
      <label>
        {t.requestTo}
        <DateField
          disabled={showAllRequests}
          language={language}
          max={requestDateBounds.max}
          min={requestFrom || requestDateBounds.min}
          title={t.requestTo}
          value={requestTo}
          onChange={(value) => {
            setRequestTo(value)
            setShowAllRequests(false)
          }}
        />
      </label>
      <div className="request-filter-actions">
        <button className="secondary-button" type="button" onClick={setCurrentWeekFilter}>
          {t.currentWeek}
        </button>
        <button className="secondary-button" type="button" onClick={setCurrentMonthFilter}>
          {t.month}
        </button>
        <button className="secondary-button" type="button" onClick={setCurrentYearFilter}>
          {t.year}
        </button>
        <button className={classNames('secondary-button', showAllRequests && 'active')} type="button" onClick={() => setShowAllRequests(true)}>
          {t.showAllRequests}
        </button>
      </div>
      <label className="toggle-row request-open-toggle">
        <input checked={includeOpenRequests} type="checkbox" onChange={(event) => setIncludeOpenRequests(event.target.checked)} />
        {t.includeOpenRequests}
      </label>
      <small>
        {t.shownRequests}: {formatShownNumber(visibleRequests.length)} / {formatShownNumber(state.requests.length)}
      </small>
    </div>
  )

  if (isAdmin && adminMode) return <ApprovalQueue state={state} language={language} loading={loading} selectedRequestId={selectedRequestId} onOwnRequests={()=>setAdminMode(false)} onDecision={onDecision} />
  return (
    <div className="requests-layout">
      <RequestForm
        draftStorageKey={requestDraftStorageKey(state.currentUser.id)}
        loading={loading}
        language={language}
        t={t}
        onCreate={onCreate}
      />
      <section className="panel requests-list-panel">
        <div className="panel-title">
          <BriefcaseBusiness size={18} />
          <h2>{isAdmin ? t.allRequests : t.myRequests}</h2>
          {isAdmin && (
            <button className="secondary-button" type="button" onClick={() => setAdminMode(true)}>
              <BriefcaseBusiness size={16} />
              {t.adminRequestView}
            </button>
          )}
        </div>
        {requestFilterBar('own-request-filter-bar')}
        <div className="request-list">
          {visibleRequests.length === 0 && <p className="muted">{t.noRequests}</p>}
          {visibleRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              users={state.users}
              isAdmin={isAdmin}
              highlighted={request.id === selectedRequestId}
              language={language}
              loading={loading}
              t={t}
              canDecide={false}
              canEdit={request.userId === state.currentUser.id && request.status === 'pending'}
              canWithdraw={request.userId === state.currentUser.id && request.status === 'pending'}
              onDecision={onDecision}
              onUpdateRequest={onUpdateRequest}
              onCancelRequest={onCancelRequest}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function RequestForm({
  loading,
  language,
  t,
  onCreate,
  request,
  title,
  submitLabel,
  onCancel,
  onSaved,
  draftStorageKey,
  embedded = false,
}: {
  loading: boolean
  language: Language
  t: T
  onCreate: (body: Record<string, unknown>) => MutationResult
  request?: RequestItem
  title?: string
  submitLabel?: string
  onCancel?: () => void
  onSaved?: () => void
  draftStorageKey?: string
  embedded?: boolean
}) {
  const today = businessDateKey()
  const formDraft = useMemo(() => readRequestFormDraft(request || embedded ? undefined : draftStorageKey), [draftStorageKey, embedded, request])
  const [type, setType] = useState<RequestType>(request?.type ?? formDraft?.type ?? 'vacation')
  const [startDate, setStartDate] = useState(request?.startDate ?? formDraft?.startDate ?? today)
  const [endDate, setEndDate] = useState(request?.endDate ?? request?.startDate ?? formDraft?.endDate ?? addDays(today, 1))
  const [minutes, setMinutes] = useState(request?.minutes !== undefined ? String(request.minutes) : (formDraft?.minutes ?? '60'))
  const [customTitle, setCustomTitle] = useState(request?.customTitle ?? formDraft?.customTitle ?? '')
  const [correctionDate, setCorrectionDate] = useState(request?.correctionDate ?? formDraft?.correctionDate ?? today)
  const [proposedStartTime, setProposedStartTime] = useState(request?.proposedStartTime ?? formDraft?.proposedStartTime ?? '09:00')
  const [proposedEndTime, setProposedEndTime] = useState(request?.proposedEndTime ?? formDraft?.proposedEndTime ?? '17:00')
  const [proposedBreakMinutes, setProposedBreakMinutes] = useState(
    request?.proposedBreakMinutes !== undefined ? String(request.proposedBreakMinutes) : (formDraft?.proposedBreakMinutes ?? '30'),
  )
  const [doctorNoteName, setDoctorNoteName] = useState(request?.doctorNoteName ?? '')
  const [doctorNoteDataUrl, setDoctorNoteDataUrl] = useState(request?.doctorNoteDataUrl ?? '')
  const [reason, setReason] = useState(request?.reason ?? formDraft?.reason ?? '')
  const [requestValidationError, setRequestValidationError] = useState('')
  const [reviewProposal,setReviewProposal]=useState(formDraft?.reviewProposal===true)
  const [proposalConfirmed,setProposalConfirmed]=useState(false)
  const [targetUserId,setTargetUserId]=useState(formDraft?.targetUserId)
  const [targetUserName,setTargetUserName]=useState(formDraft?.targetUserName)
  const dateBounds = useMemo(() => sensibleDateBounds(), [])
  const formTitle = title ?? t.newRequest
  const formSubmitLabel = submitLabel ?? t.submitRequest

  useEffect(() => {
    if (!draftStorageKey || request || embedded) {
      return
    }

    writeRequestFormDraft(draftStorageKey, {
      reviewProposal,targetUserId,targetUserName,
      type,
      startDate,
      endDate,
      minutes,
      customTitle,
      correctionDate,
      proposedStartTime,
      proposedEndTime,
      proposedBreakMinutes,
      reason,
    })
  }, [
    reviewProposal,targetUserId,targetUserName,
    correctionDate,
    customTitle,
    draftStorageKey,
    embedded,
    endDate,
    minutes,
    proposedBreakMinutes,
    proposedEndTime,
    proposedStartTime,
    reason,
    request,
    startDate,
    type,
  ])

  function resetNewRequestForm() {
    setReviewProposal(false);setProposalConfirmed(false);setTargetUserId(undefined);setTargetUserName(undefined)
    const resetToday = businessDateKey()
    setType('vacation')
    setStartDate(resetToday)
    setEndDate(addDays(resetToday, 1))
    setMinutes('60')
    setCustomTitle('')
    setCorrectionDate(resetToday)
    setProposedStartTime('09:00')
    setProposedEndTime('17:00')
    setProposedBreakMinutes('30')
    setDoctorNoteName('')
    setDoctorNoteDataUrl('')
    setReason('')
  }

  function changeStartDate(nextStartDate: string) {
    setStartDate((previousStartDate) => {
      const previousDefaultEndDate = addDays(previousStartDate, 1)
      setEndDate((currentEndDate) =>
        currentEndDate === previousDefaultEndDate || currentEndDate < nextStartDate ? nextStartDate : currentEndDate,
      )
      return nextStartDate
    })
  }

  function handleDoctorNote(file: File | undefined) {
    if (!file) {
      setDoctorNoteName('')
      setDoctorNoteDataUrl('')
      return
    }

    if (!allowedDoctorNoteTypes.has(file.type) || file.size > maxDoctorNoteBytes) {
      setDoctorNoteName('')
      setDoctorNoteDataUrl('')
      setRequestValidationError(t.doctorNoteFileInvalid)
      return
    }

    const reader = new FileReader()
    reader.addEventListener('load', () => {
      setDoctorNoteName(file.name)
      setDoctorNoteDataUrl(typeof reader.result === 'string' ? reader.result : '')
      setRequestValidationError('')
    })
    reader.readAsDataURL(file)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if(reviewProposal&&!proposalConfirmed){setRequestValidationError(language==='de'?'Bitte den Vorschlag prüfen und die tatsächlichen Zeiten bestätigen.':'Review the proposal and confirm the actual times.');return}
    const parsedMinutes = parseDecimalInput(minutes)
    const parsedBreakMinutes = parseDecimalInput(proposedBreakMinutes)
    const dateRangeError = sensibleDateRangeMessage(t, language)
    if (type === 'time_correction' && !isSensibleDateKey(correctionDate)) {
      setRequestValidationError(dateRangeError)
      return
    }
    if (type !== 'time_correction' && (!isSensibleDateKey(startDate) || !isSensibleDateKey(endDate))) {
      setRequestValidationError(dateRangeError)
      return
    }
    if (type === 'overtime_payout' && (parsedMinutes === undefined || parsedMinutes < 0)) {
      setRequestValidationError(t.numericFieldsRequired)
      return
    }
    if (type === 'custom' && customTitle.trim().length === 0) {
      setRequestValidationError(t.customRequestSubjectRequired)
      return
    }
    if (type === 'time_correction' && (parsedBreakMinutes === undefined || parsedBreakMinutes < 0)) {
      setRequestValidationError(t.numericFieldsRequired)
      return
    }

    setRequestValidationError('')
    const requestMinutes = type === 'overtime_payout' ? parsedMinutes : undefined
    const body =
      type === 'time_correction'
        ? { type, correctionDate, proposedStartTime, proposedEndTime, proposedBreakMinutes: parsedBreakMinutes, reason }
        : { type, customTitle, startDate, endDate, minutes: requestMinutes, reason, doctorNoteName, doctorNoteDataUrl }
    const saved = await onCreate({...body,...(!request&&targetUserId?{targetUserId}:{}),...(reviewProposal?{reviewProposal:true,proposalConfirmed}: {})})
    if (saved) {
      if (!request) {
        clearRequestFormDraft(draftStorageKey)
        resetNewRequestForm()
      }
      onSaved?.()
    }
  }

  return (
    <section className={classNames(!embedded && 'panel', 'request-form-panel', embedded && 'embedded-request-form')}>
      <div className="panel-title">
        <BriefcaseBusiness size={18} />
        <h2 id={embedded ? 'request-edit-dialog-title' : undefined}>{formTitle}</h2>
      </div>
      <form className="stacked-form" onSubmit={submit}>
        {targetUserName&&<p className="field-help">{language==='de'?'Antrag für':'Request for'}: <strong>{targetUserName}</strong></p>}
        {reviewProposal&&<div className="resolution-proposal-note">
          <strong>{language==='de'?'Automatisch ausgefüllter Vorschlag':'Automatically filled proposal'}</strong>
          <p>{language==='de'?'Die Zeiten sind Schätzungen aus Aufzeichnungen und Sollzeit. Bei fehlenden Angaben werden 09:00 Uhr und die Sollzeit verwendet. Bitte an die tatsächlich geleistete Arbeit anpassen. Eine Kürzung ist nur bei fehlerhafter Erfassung richtig.':'Times are estimates from records and the work schedule. Missing values use 09:00 and the scheduled duration. Adjust them to the work actually performed. Reducing time is appropriate only when the record is wrong.'}</p>
          <p>{language==='de'?'Eine Genehmigung verändert nur DCO; der Zeitguru-Import bleibt als Original erhalten.':'Approval changes DCO only; the Zeitguru import remains preserved as the original.'}</p>
          <label className="toggle-row"><input type="checkbox" checked={proposalConfirmed} onChange={event=>setProposalConfirmed(event.target.checked)}/><span>{language==='de'?'Ich habe die Angaben geprüft; sie entsprechen der tatsächlichen Arbeit und den tatsächlich genommenen Pausen.':'I reviewed the details; they reflect actual work and breaks actually taken.'}</span></label>
        </div>}
        <label>
          {t.type}
          <AppSelect
            ariaLabel={t.type}
            value={type}
            options={[
              { value: 'vacation', label: t.vacation },
              { value: 'overtime_payout', label: t.overtimePayout },
              { value: 'overtime_time_off', label: t.overtimeTimeOff },
              { value: 'time_correction', label: t.timeCorrection },
              { value: 'sick_leave', label: t.sickLeave },
              { value: 'child_sick_leave', label: t.childSickLeave },
              { value: 'custom', label: t.customRequest },
            ]}
            onChange={(nextType) => setType(nextType as RequestType)}
          />
        </label>

        {type === 'custom' && (
          <label>
            {t.customRequestSubject}
            <input value={customTitle} onChange={(event) => setCustomTitle(event.target.value)} />
          </label>
        )}

        {type === 'time_correction' && <p className="field-help">{language === 'de' ? 'Eine genehmigte Korrektur ersetzt alle Zeiteinträge dieses Tages. Die Originale bleiben im Änderungsprotokoll erhalten.' : 'An approved correction replaces all time entries for this day. Original entries remain in the audit history.'}</p>}
        {type === 'time_correction' ? (
          <div className="form-grid">
            <label>
              {t.date}
              <DateField
                language={language}
                max={dateBounds.max}
                min={dateBounds.min}
                title={t.date}
                value={correctionDate}
                onChange={setCorrectionDate}
              />
            </label>
            <label>
              {t.start}
              <input value={proposedStartTime} onChange={(event) => setProposedStartTime(event.target.value)} type="time" />
            </label>
            <label>
              {t.end}
              <input value={proposedEndTime} onChange={(event) => setProposedEndTime(event.target.value)} type="time" />
            </label>
            <label>
              {t.breakMinutes}
              <input
                value={proposedBreakMinutes}
                min={0}
                onChange={(event) => setProposedBreakMinutes(event.target.value)}
                type="number"
              />
            </label>
          </div>
        ) : (
          <div className="form-grid">
            <label>
              {t.startDate}
              <DateField
                language={language}
                max={dateBounds.max}
                min={dateBounds.min}
                title={t.startDate}
                value={startDate}
                onChange={changeStartDate}
              />
            </label>
            <label>
              {t.endDate}
              <DateField
                language={language}
                max={dateBounds.max}
                min={startDate}
                title={t.endDate}
                value={endDate}
                onChange={setEndDate}
              />
            </label>
            {type === 'overtime_payout' && (
              <label>
                {t.minutes}
                <input value={minutes} min={0} onChange={(event) => setMinutes(event.target.value)} type="number" />
              </label>
            )}
          </div>
        )}

        {(type === 'sick_leave' || type === 'child_sick_leave') && (
          <label>
            {t.doctorNote}
            <input accept=".pdf,.png,.jpg,.jpeg,.webp" type="file" onChange={(event) => handleDoctorNote(event.target.files?.[0])} />
            {doctorNoteName && <small>{doctorNoteName}</small>}
          </label>
        )}

        <label>
          {t.reason}
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={4} />
          </label>
        {requestValidationError && <p className="form-error inline-form-error">{requestValidationError}</p>}
        <div className="form-actions">
          {onCancel && (
            <button disabled={loading} className="secondary-button" type="button" onClick={onCancel}>
              <X size={18} />
              {t.cancel}
            </button>
          )}
          <button disabled={loading} className="primary-button" type="submit">
            <Check size={18} />
            {formSubmitLabel}
          </button>
        </div>
      </form>
    </section>
  )
}

function RequestRow({
  request,
  users,
  isAdmin,
  highlighted,
  language,
  loading,
  t,
  canDecide = isAdmin,
  canEdit = false,
  canWithdraw = false,
  onDecision,
  onUpdateRequest,
  onCancelRequest,
}: {
  request: RequestItem
  users: User[]
  isAdmin: boolean
  highlighted: boolean
  language: Language
  loading: boolean
  t: T
  canDecide?: boolean
  canEdit?: boolean
  canWithdraw?: boolean
  onDecision: (requestId: string, decision: 'approved' | 'rejected') => MutationResult
  onUpdateRequest: (requestId: string, body: Record<string, unknown>) => MutationResult
  onCancelRequest: (requestId: string) => MutationResult
}) {
  const user = users.find((candidate) => candidate.id === request.userId)
  const [isEditing, setIsEditing] = useState(false)
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  return (
    <article className={classNames('request-row', highlighted && 'highlighted')}>
      <div>
        <span className={classNames('status-chip', request.status)}>{t[request.status]}</span>
        <h3>{requestTitle(request, t)}</h3>
        <p>
          {displayUserName(user)}
          {requestDateDetail(request, language) ? `, ${requestDateDetail(request, language)}` : ''}
        </p>
        {isAdmin && (
          <small>
            {t.requestSubmittedAt}: {requestSubmittedDate(request, language)}
            {request.decidedAt ? ` · ${t.requestDecisionAt}: ${formatDateTime(request.decidedAt, language)}` : ''}
          </small>
        )}
        {request.type === 'custom' && request.customTitle && <small>{requestLabel(request.type, t)}</small>}
        {request.minutes && request.type === 'overtime_payout' ? <small>{formatDecimalHours(request.minutes)} {t.hours}</small> : null}
        {request.doctorNoteDataUrl && (
          <a className="doctor-note-link" href={request.doctorNoteDataUrl} download={request.doctorNoteName ?? 'doctor-note'} target="_blank" rel="noreferrer">
            {t.doctorNoteAttached}: {request.doctorNoteName ?? t.downloadDoctorNote}
          </a>
        )}
        {request.reason && <small>{request.reason}</small>}
      </div>
      {canDecide && request.status === 'pending' && (
        <div className="row-actions">
          <button disabled={loading} className="icon-button approve" title="Approve" type="button" onClick={() => onDecision(request.id, 'approved')}>
            <Check size={18} />
          </button>
          <button disabled={loading} className="icon-button reject" title="Reject" type="button" onClick={() => onDecision(request.id, 'rejected')}>
            <X size={18} />
          </button>
        </div>
      )}
      {(canEdit || canWithdraw) && (
        <div className="row-actions">
          {canEdit && (
            <button disabled={loading} className="secondary-button" type="button" onClick={() => setIsEditing(true)}>
              <Pencil size={16} />
              {t.editRequest}
            </button>
          )}
          {canWithdraw && (
            <button disabled={loading} className="secondary-button" type="button" onClick={() => setConfirmWithdraw(true)}>
              <RotateCcw size={16} />
              {t.withdrawRequest}
            </button>
          )}
        </div>
      )}
      {isEditing && (
        <div className="modal-backdrop">
          <div className="modal-dialog request-edit-modal" role="dialog" aria-modal="true" aria-labelledby="request-edit-dialog-title">
            <RequestForm
              key={request.id}
              embedded
              request={request}
              loading={loading}
              language={language}
              t={t}
              title={t.editRequest}
              submitLabel={t.updateRequest}
              onCreate={(body) => onUpdateRequest(request.id, body)}
              onCancel={() => setIsEditing(false)}
              onSaved={() => setIsEditing(false)}
            />
          </div>
        </div>
      )}
      {confirmWithdraw && (
        <ConfirmDialog
          title={t.confirmWithdrawRequestTitle}
          body={t.confirmWithdrawRequestBody}
          confirmLabel={t.withdrawRequest}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmWithdraw(false)}
          onConfirm={async () => {
            const saved = await onCancelRequest(request.id)
            if (saved) {
              setConfirmWithdraw(false)
            }
          }}
        />
      )}
    </article>
  )
}

function AdminUsersView({
  state,
  language,
  loading,
  t,
  onUpdateUser,
  onRemoveUser,
  onInviteUser,
  onCancelInvite,
  onImportCsv,
  onUndoApproval,
  onExportCsv,
}: {
  state: StatePayload
  language: Language
  loading: boolean
  t: T
  onUpdateUser: (userId: string, body: Record<string, unknown>) => MutationResult
  onRemoveUser: (userId: string) => MutationResult
  onInviteUser: (body: Record<string, unknown>) => MutationResult
  onCancelInvite: (invitationId: string) => MutationResult
  onImportCsv: (body: Record<string, unknown>) => MutationResult
  onUndoApproval: (requestId: string) => MutationResult
  onExportCsv: TimeCsvExport
}) {
  const summaryByUser = new Map(state.summaries.map((summary) => [summary.userId, summary]))
  const admins = state.users.filter((user) => user.role === 'admin')
  const selectableUsers = state.users
  const employees = state.users.filter((user) => user.role === 'employee')
  const [selectedUserId, setSelectedUserId] = useState(() => employees[0]?.id ?? selectableUsers[0]?.id ?? '')
  const selectedUser = selectableUsers.find((user) => user.id === selectedUserId) ?? employees[0] ?? selectableUsers[0]

  useEffect(() => {
    if (selectableUsers.some((user) => user.id === selectedUserId)) {
      return
    }
    setSelectedUserId(employees[0]?.id ?? selectableUsers[0]?.id ?? '')
  }, [employees, selectableUsers, selectedUserId])

  return (
    <div className="admin-users-layout">
      <section className="panel admin-users-panel">
        <div className="panel-title">
          <Settings size={18} />
          <h2>{t.employeeSettings}</h2>
        </div>
        <div className="employee-selector-bar">
          <label>
            {t.selectEmployee}
            <AppSelect
              ariaLabel={t.selectEmployee}
              value={selectedUser?.id ?? ''}
              options={selectableUsers.map((user) => ({
                value: user.id,
                label: `${displayUserName(user)} · ${user.role === 'admin' ? t.admin : t.employee}`,
              }))}
              onChange={setSelectedUserId}
            />
          </label>
          {selectedUser && (
            <div className="selected-employee-card">
              <span>{t.selectedEmployee}</span>
              <strong>{displayUserName(selectedUser)}</strong>
              <small>{selectedUser.email}</small>
            </div>
          )}
        </div>
        {selectedUser ? (
          <EmployeeDetailPanel
            user={selectedUser}
            coreManaged={state.coreManaged}
            admins={admins}
            language={language}
            loading={loading}
            summary={summaryByUser.get(selectedUser.id)}
            t={t}
            onUpdate={onUpdateUser}
            onRemove={onRemoveUser}
            onExportCsv={onExportCsv}
          />
        ) : (
          <p className="muted admin-empty-state">{t.noEmployeeSelected}</p>
        )}
      </section>

      <div className="admin-side-stack">
        {state.coreManaged ? <SuiteAdminLink title={language === 'de' ? 'Konten und Berechtigungen' : 'Accounts and permissions'} description={language === 'de' ? 'Nutzer, Passwörter und Systemzugriff zentral verwalten.' : 'Manage users, passwords and system access centrally.'} label={language === 'de' ? 'Nutzer in Core verwalten' : 'Manage users in Core'} href={(coreOfficeUrl || '/') + '#users'} /> : <InviteUserPanel
          state={state}
          admins={admins}
          language={language}
          loading={loading}
          t={t}
          onInviteUser={onInviteUser}
          onCancelInvite={onCancelInvite}
        />}
        <TimeExportPanel
          users={state.users}
          selectedUserId={selectedUser?.id ?? state.currentUser.id}
          language={language}
          t={t}
          onExportCsv={onExportCsv}
        />
        <ImportCsvPanel state={state} selectedUserId={selectedUser?.id} loading={loading} t={t} onImportCsv={onImportCsv} />
        <ApprovedActionsPanel
          state={state}
          selectedUserId={selectedUser?.id}
          language={language}
          loading={loading}
          t={t}
          onUndoApproval={onUndoApproval}
        />
      </div>
    </div>
  )
}

function InviteUserPanel({
  state,
  admins,
  language,
  loading,
  t,
  onInviteUser,
  onCancelInvite,
}: {
  state: StatePayload
  admins: User[]
  language: Language
  loading: boolean
  t: T
  onInviteUser: (body: Record<string, unknown>) => MutationResult
  onCancelInvite: (invitationId: string) => MutationResult
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('employee')
  const [expectedWeeklyHours, setExpectedWeeklyHours] = useState('40')
  const [yearlyVacationDays, setYearlyVacationDays] = useState('30')
  const [targetRemainingVacationDays, setTargetRemainingVacationDays] = useState('30')
  const [targetBalanceHours, setTargetBalanceHours] = useState('0')
  const [responsibleAdminUserId, setResponsibleAdminUserId] = useState(admins[0]?.id ?? '')
  const [confirmInvite, setConfirmInvite] = useState(false)
  const [confirmCancelInvite, setConfirmCancelInvite] = useState<UserInvitation | null>(null)
  const [inviteValidationError, setInviteValidationError] = useState('')
  const [inviteDraft, setInviteDraft] = useState<Record<string, unknown> | null>(null)
  const pendingInvites = state.userInvitations
    .filter((invitation) => !invitation.acceptedAt)
    .slice(0, 5)
  const acceptedInvites = state.userInvitations.filter((invitation) => invitation.acceptedAt).slice(0, 3)

  useEffect(() => {
    if (!responsibleAdminUserId && admins[0]?.id) {
      setResponsibleAdminUserId(admins[0].id)
    }
  }, [admins, responsibleAdminUserId])

  function resetForm() {
    setName('')
    setEmail('')
    setRole('employee')
    setExpectedWeeklyHours('40')
    setYearlyVacationDays('30')
    setTargetRemainingVacationDays('30')
    setTargetBalanceHours('0')
    setResponsibleAdminUserId(admins[0]?.id ?? '')
    setInviteValidationError('')
    setInviteDraft(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsedWeeklyHours = parseDecimalInput(expectedWeeklyHours)
    const parsedVacationDays = parseDecimalInput(yearlyVacationDays)
    const parsedRemainingVacationDays = parseDecimalInput(targetRemainingVacationDays)
    const parsedBalanceHours = parseDecimalInput(targetBalanceHours)

    if (
      parsedWeeklyHours === undefined ||
      parsedVacationDays === undefined ||
      parsedRemainingVacationDays === undefined ||
      parsedBalanceHours === undefined
    ) {
      setInviteValidationError(t.numericFieldsRequired)
      return
    }
    if (parsedWeeklyHours <= 0) {
      setInviteValidationError(t.weeklyHoursRequired)
      return
    }
    if (parsedVacationDays < 0) {
      setInviteValidationError(t.numericFieldsRequired)
      return
    }

    setInviteValidationError('')
    setInviteDraft({
      name,
      email,
      role,
      expectedWeeklyHours: parsedWeeklyHours,
      yearlyVacationDays: parsedVacationDays,
      targetRemainingVacationDays: parsedRemainingVacationDays,
      targetBalanceHours: parsedBalanceHours,
      responsibleAdminUserId,
    })
    setConfirmInvite(true)
  }

  return (
    <section className="panel invite-user-panel">
      <div className="panel-title">
        <UserPlus size={18} />
        <h2>{t.inviteNewUser}</h2>
      </div>
      <form className="invite-user-form" onSubmit={submit}>
        <label>
          {t.name}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t.email}
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
        </label>
        <label>
          {t.userRole}
          <AppSelect
            ariaLabel={t.userRole}
            value={role}
            options={[
              { value: 'employee', label: t.employee },
              { value: 'admin', label: t.admin },
            ]}
            onChange={(nextRole) => setRole(nextRole === 'admin' ? 'admin' : 'employee')}
          />
        </label>
        <div className="invite-section-label">{t.startingTerms}</div>
        <label>
          {t.weeklyHours}
          <input
            value={expectedWeeklyHours}
            min={1}
            step={0.5}
            type="number"
            onChange={(event) => setExpectedWeeklyHours(event.target.value)}
          />
        </label>
        <label>
          {t.vacationDays}
          <input
            value={yearlyVacationDays}
            min={0}
            step={0.5}
            type="number"
            onChange={(event) => setYearlyVacationDays(event.target.value)}
          />
        </label>
        <div className="invite-section-label">{t.initialBalances}</div>
        <label>
          {t.currentVacationRemainingDays}
          <input
            value={targetRemainingVacationDays}
            step={0.5}
            type="number"
            onChange={(event) => setTargetRemainingVacationDays(event.target.value)}
          />
        </label>
        <label>
          {t.currentBalanceHours}
          <input
            value={targetBalanceHours}
            step={0.25}
            type="number"
            onChange={(event) => setTargetBalanceHours(event.target.value)}
          />
        </label>
        {role === 'employee' && (
          <label>
            {t.responsibleAdmin}
            <AppSelect
              ariaLabel={t.responsibleAdmin}
              value={responsibleAdminUserId}
              options={admins.map((admin) => ({ value: admin.id, label: displayUserName(admin) }))}
              onChange={setResponsibleAdminUserId}
            />
          </label>
        )}
        {inviteValidationError && <p className="form-error inline-form-error">{inviteValidationError}</p>}
        <button
          disabled={loading || name.trim().length < 2 || !email.includes('@')}
          className="primary-button"
          type="submit"
        >
          <UserPlus size={16} />
          {t.sendInvite}
        </button>
      </form>
      <InviteList
        title={t.pendingInvites}
        emptyText={t.noPendingInvites}
        invitations={pendingInvites}
        users={state.users}
        language={language}
        loading={loading}
        cancelLabel={t.cancelInvite}
        onCancelInvite={setConfirmCancelInvite}
      />
      {acceptedInvites.length > 0 && (
        <InviteList title={t.acceptedInvites} emptyText="" invitations={acceptedInvites} users={state.users} language={language} />
      )}
      {confirmInvite && (
        <ConfirmDialog
          title={t.confirmInviteTitle}
          body={t.confirmInviteBody}
          confirmLabel={t.sendInvite}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmInvite(false)}
          onConfirm={async () => {
            if (inviteDraft) {
              const saved = await onInviteUser(inviteDraft)
              if (saved) {
                setConfirmInvite(false)
                resetForm()
              }
            }
          }}
        />
      )}
      {confirmCancelInvite && (
        <ConfirmDialog
          title={t.confirmCancelInviteTitle}
          body={`${t.confirmCancelInviteBody} ${confirmCancelInvite.email}`}
          confirmLabel={t.cancelInvite}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmCancelInvite(null)}
          onConfirm={async () => {
            const invitationId = confirmCancelInvite.id
            const saved = await onCancelInvite(invitationId)
            if (saved) {
              setConfirmCancelInvite(null)
            }
          }}
        />
      )}
    </section>
  )
}

function InviteList({
  title,
  emptyText,
  invitations,
  users,
  language,
  loading = false,
  cancelLabel,
  onCancelInvite,
}: {
  title: string
  emptyText: string
  invitations: UserInvitation[]
  users: User[]
  language: Language
  loading?: boolean
  cancelLabel?: string
  onCancelInvite?: (invitation: UserInvitation) => void
}) {
  const userById = new Map(users.map((user) => [user.id, user]))
  return (
    <div className="invite-list">
      <h3>{title}</h3>
      {invitations.length === 0 && emptyText && <p className="muted">{emptyText}</p>}
      {invitations.map((invitation) => {
        const user = userById.get(invitation.userId)
        return (
          <article key={invitation.id} className="invite-row">
            <div>
              <strong>{displayUserName(user) || invitation.email}</strong>
              <small>{invitation.email}</small>
              <small>
                {invitation.acceptedAt
                  ? formatDateTime(invitation.acceptedAt, language)
                  : formatDateTime(invitation.expiresAt, language)}
              </small>
            </div>
            {!invitation.acceptedAt && onCancelInvite && cancelLabel && (
              <button disabled={loading} className="secondary-button" type="button" onClick={() => onCancelInvite(invitation)}>
                <X size={16} />
                {cancelLabel}
              </button>
            )}
          </article>
        )
      })}
    </div>
  )
}

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false
  }

  const rightSet = new Set(right)
  return left.every((item) => rightSet.has(item))
}

function GroupAdminPanel({
  state,
  loading,
  t,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
}: {
  state: StatePayload
  loading: boolean
  t: T
  onCreateGroup: (body: Record<string, unknown>) => MutationResult
  onUpdateGroup: (id: string, body: Record<string, unknown>) => MutationResult
  onDeleteGroup: (id: string) => MutationResult
}) {
  const [name, setName] = useState('')
  const [memberUserIds, setMemberUserIds] = useState<string[]>([])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onCreateGroup({ name, memberUserIds })
    if (saved) {
      setName('')
      setMemberUserIds([])
    }
  }

  return (
    <section className="panel group-admin-panel">
      <div className="panel-title">
        <Users size={18} />
        <h2>{t.groups}</h2>
      </div>
      <form className="group-form" onSubmit={submit}>
        <label>
          {t.newGroup}
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.groupName} />
        </label>
        <GroupMemberChecks
          users={state.users}
          memberUserIds={memberUserIds}
          onToggle={(userId) => setMemberUserIds((current) => toggleId(current, userId))}
        />
        <button disabled={loading || name.trim().length === 0} className="primary-button" type="submit">
          <UserPlus size={16} />
          {t.createGroup}
        </button>
      </form>
      <div className="group-list">
        {state.calendarGroups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            users={state.users}
            loading={loading}
            t={t}
            onUpdate={onUpdateGroup}
            onDelete={onDeleteGroup}
          />
        ))}
      </div>
    </section>
  )
}

function GroupMemberChecks({
  users,
  memberUserIds,
  disabled = false,
  onToggle,
}: {
  users: User[]
  memberUserIds: string[]
  disabled?: boolean
  onToggle: (userId: string) => void
}) {
  return (
    <div className="group-member-list">
      {users.map((user) => (
        <label key={user.id} className="check-row">
          <input
            checked={memberUserIds.includes(user.id)}
            disabled={disabled}
            type="checkbox"
            onChange={() => onToggle(user.id)}
          />
          <span>
            {displayUserName(user)}
            <small>{user.email}</small>
          </span>
        </label>
      ))}
    </div>
  )
}

function GroupRow({
  group,
  users,
  loading,
  t,
  onUpdate,
  onDelete,
}: {
  group: CalendarGroup
  users: User[]
  loading: boolean
  t: T
  onUpdate: (id: string, body: Record<string, unknown>) => MutationResult
  onDelete: (id: string) => MutationResult
}) {
  const [name, setName] = useState(group.name)
  const [memberUserIds, setMemberUserIds] = useState(group.memberUserIds)
  const [isEditing, setIsEditing] = useState(false)
  const [confirmSave, setConfirmSave] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isDirty = name !== group.name || !sameIds(memberUserIds, group.memberUserIds)
  const memberUsers = users.filter((user) => group.memberUserIds.includes(user.id))

  useEffect(() => {
    setName(group.name)
    setMemberUserIds(group.memberUserIds)
    setIsEditing(false)
  }, [group.id, group.memberUserIds, group.name])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (isEditing && isDirty) {
      setConfirmSave(true)
    }
  }

  function startEdit() {
    setName(group.name)
    setMemberUserIds(group.memberUserIds)
    setIsEditing(true)
  }

  function cancelEdit() {
    setName(group.name)
    setMemberUserIds(group.memberUserIds)
    setIsEditing(false)
  }

  return (
    <form className={classNames('group-row', isEditing && 'group-row-editing')} onSubmit={submit}>
      <div className="group-row-header">
        {isEditing ? (
          <label>
            {t.groupName}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        ) : (
          <div className="group-summary">
            <strong>{group.name}</strong>
            <small>
              {memberUsers.length} {t.groupMembers.toLowerCase()}
            </small>
          </div>
        )}
        <div className="group-actions">
          {isEditing ? (
            <>
              <button disabled={loading || name.trim().length === 0 || !isDirty} className="secondary-button" type="submit">
                <Check size={16} />
                {t.saveGroup}
              </button>
              <button disabled={loading} className="secondary-button" type="button" onClick={cancelEdit}>
                <X size={16} />
                {t.cancel}
              </button>
            </>
          ) : (
            <>
              <button disabled={loading} className="secondary-button" type="button" onClick={startEdit}>
                <Pencil size={16} />
                {t.editGroup}
              </button>
              <button
                disabled={loading}
                className="icon-button reject"
                title={t.deleteGroup}
                type="button"
                onClick={() => setConfirmDelete(true)}
              >
                <X size={16} />
              </button>
            </>
          )}
        </div>
      </div>
      {isEditing ? (
        <>
          <span className="group-members-label">{t.groupMembers}</span>
          <GroupMemberChecks
            users={users}
            memberUserIds={memberUserIds}
            onToggle={(userId) => setMemberUserIds((current) => toggleId(current, userId))}
          />
        </>
      ) : (
        <div className="group-member-summary">
          {memberUsers.length === 0 && <span className="member-chip muted-chip">{t.noneYet}</span>}
          {memberUsers.map((user) => (
            <span key={user.id} className="member-chip">
              {displayUserName(user)}
            </span>
          ))}
        </div>
      )}
      {confirmSave && (
        <ConfirmDialog
          title={t.confirmGroupChangeTitle}
          body={t.confirmGroupChangeBody}
          confirmLabel={t.saveGroup}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmSave(false)}
          onConfirm={async () => {
            const saved = await onUpdate(group.id, { name: name.trim(), memberUserIds })
            if (saved) {
              setConfirmSave(false)
              setIsEditing(false)
            }
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t.confirmDeleteGroupTitle}
          body={t.confirmDeleteGroupBody}
          confirmLabel={t.deleteGroup}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const saved = await onDelete(group.id)
            if (saved) {
              setConfirmDelete(false)
            }
          }}
        />
      )}
    </form>
  )
}

function EmployeeDetailPanel({
  user,
  coreManaged = false,
  admins,
  language,
  loading,
  summary,
  t,
  onUpdate,
  onRemove,
  onExportCsv,
}: {
  user: User
  coreManaged?: boolean
  admins: User[]
  language: Language
  loading: boolean
  summary?: UserSummary
  t: T
  onUpdate: (userId: string, body: Record<string, unknown>) => MutationResult
  onRemove: (userId: string) => MutationResult
  onExportCsv: TimeCsvExport
}) {
  const currentTerm = currentEmploymentTerm(user)
  const currentWeeklyHours = currentTerm.expectedWeeklyMinutes / 60
  const currentYearlyVacationDays = currentTerm.yearlyVacationDays
  const terms = employmentTermsFor(user)
  const currentRemainingVacationDays = summary?.vacation.remainingDays ?? currentYearlyVacationDays + user.vacationAdjustmentDays
  const currentBalanceHours = (summary?.year.plusMinusMinutes ?? 0) / 60
  const responsibleAdmin = admins.find((admin) => admin.id === user.responsibleAdminUserId)
  const [termsEditMode, setTermsEditMode] = useState(false)
  const [adjustmentsEditMode, setAdjustmentsEditMode] = useState(false)
  const [adminEditMode, setAdminEditMode] = useState(false)
  const [roleEditMode, setRoleEditMode] = useState(false)
  const [confirmRemoveUser, setConfirmRemoveUser] = useState(false)
  const [exportBeforeRemove, setExportBeforeRemove] = useState(true)
  const [confirmAction, setConfirmAction] = useState<{
    title: string
    body: string
    confirmLabel: string
    onConfirm: () => MutationResult
  } | null>(null)
  const [employeeValidationError, setEmployeeValidationError] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(() => businessDateKey())
  const [expectedWeeklyHours, setExpectedWeeklyHours] = useState(numberInputValue(currentWeeklyHours))
  const [yearlyVacationDays, setYearlyVacationDays] = useState(numberInputValue(currentYearlyVacationDays))
  const [targetRemainingVacationDays, setTargetRemainingVacationDays] = useState(
    numberInputValue(currentRemainingVacationDays),
  )
  const [targetBalanceHours, setTargetBalanceHours] = useState(numberInputValue(currentBalanceHours))
  const [responsibleAdminUserId, setResponsibleAdminUserId] = useState(user.responsibleAdminUserId ?? '')
  const [role, setRole] = useState<Role>(user.role)

  useEffect(() => {
    setEffectiveFrom(businessDateKey())
    setExpectedWeeklyHours(numberInputValue(currentWeeklyHours))
    setYearlyVacationDays(numberInputValue(currentYearlyVacationDays))
    setTargetRemainingVacationDays(numberInputValue(currentRemainingVacationDays))
    setTargetBalanceHours(numberInputValue(currentBalanceHours))
    setResponsibleAdminUserId(user.responsibleAdminUserId ?? '')
    setRole(user.role)
    setTermsEditMode(false)
    setAdjustmentsEditMode(false)
    setAdminEditMode(false)
    setRoleEditMode(false)
    setConfirmRemoveUser(false)
    setExportBeforeRemove(true)
    setEmployeeValidationError('')
  }, [
    currentBalanceHours,
    currentRemainingVacationDays,
    currentWeeklyHours,
    currentYearlyVacationDays,
    user.id,
    user.responsibleAdminUserId,
    user.role,
  ])

  return (
    <div className="employee-detail">
      {summary?.balanceReviewRequired && <p className="zeitguru-history-note" role="status">{language === 'de' ? 'Dieses Stundenkonto benötigt eine Prüfung. Ein Anfangssaldo oder importierte Tageswerte können ungeklärt sein. Bitte vor einer Saldoanpassung die Zeitabrechnung und ihre Hinweise prüfen.' : 'This hours account needs review. Its opening balance or imported daily values may be unresolved. Check the accounting and its notes before adjusting the balance.'}</p>}
      <div className="employee-profile-row">
        <div>
          <span>{t.currentSettings}</span>
          <h3>{displayUserName(user)}</h3>
          <small>{user.email}</small>
        </div>
        <div className="employee-profile-metrics">
          <EmployeeSettingValue label={t.currentRole} value={user.role === 'admin' ? t.admin : t.employee} />
          <EmployeeSettingValue label={t.weeklyHours} value={`${formatShownNumber(currentWeeklyHours)} h`} />
          <EmployeeSettingValue label={t.vacationDays} value={formatShownNumber(currentYearlyVacationDays)} />
          <EmployeeSettingValue label={t.currentBalanceHours} value={`${formatShownNumber(currentBalanceHours)} h`} />
        </div>
      </div>

      <div className="employee-detail-grid">
        <section className="employee-settings-section">
          <div className="employee-section-header">
            <h3>{t.permissions}</h3>
            <button disabled={loading || coreManaged} className="secondary-button" type="button" onClick={() => setRoleEditMode((value) => !value)}>
              {roleEditMode ? <X size={16} /> : <Pencil size={16} />}
              {roleEditMode ? t.cancel : t.editPermissions}
            </button>
          </div>
          <EmployeeSettingValue label={t.currentRole} value={user.role === 'admin' ? t.admin : t.employee} />
          {roleEditMode && (
            <form
              className="employee-edit-form role-edit-form"
              onSubmit={(event) => {
                event.preventDefault()
                setConfirmAction({
                  title: t.confirmRoleTitle,
                  body: t.confirmRoleBody,
                  confirmLabel: t.saveImportantChange,
                  onConfirm: async () => {
                    const saved = await onUpdate(user.id, {
                      role,
                      responsibleAdminUserId: role === 'employee' ? responsibleAdminUserId : '',
                    })
                    if (saved) {
                      setRoleEditMode(false)
                    }
                    return saved
                  },
                })
              }}
            >
              <label>
                {t.userRole}
                <AppSelect
                  ariaLabel={t.userRole}
                  value={role}
                  options={[
                    { value: 'employee', label: t.employee },
                    { value: 'admin', label: t.admin },
                  ]}
                  onChange={(nextRole) => setRole(nextRole === 'admin' ? 'admin' : 'employee')}
                />
              </label>
              {role === 'employee' && (
                <label>
                  {t.responsibleAdmin}
                  <AppSelect
                    ariaLabel={t.responsibleAdmin}
                    value={responsibleAdminUserId}
                    options={[
                      { value: '', label: t.allAdminsFallback },
                      ...admins
                        .filter((admin) => admin.id !== user.id)
                        .map((admin) => ({ value: admin.id, label: displayUserName(admin) })),
                    ]}
                    onChange={setResponsibleAdminUserId}
                  />
                </label>
              )}
              <button disabled={loading || role === user.role} className="primary-button" type="submit">
                <Check size={16} />
                {t.saveImportantChange}
              </button>
            </form>
          )}
        </section>

        <section className="employee-settings-section">
          <div className="employee-section-header">
            <div>
              <h3>{t.employmentTerms}</h3>
              <small>{t.effectiveFrom}: {formatDateKey(currentTerm.effectiveFrom, language)}</small>
            </div>
            <button disabled={loading} className="secondary-button" type="button" onClick={() => setTermsEditMode((value) => !value)}>
              {termsEditMode ? <X size={16} /> : <Pencil size={16} />}
              {termsEditMode ? t.cancel : t.editTerms}
            </button>
          </div>
          <div className="term-history">
            <strong>{t.currentTerms}</strong>
            {terms
              .slice()
              .reverse()
              .map((term) => (
                <div key={term.id} className="term-row">
                  <span>{t.appliesSince} {formatDateKey(term.effectiveFrom, language)}</span>
                  <strong>{formatDecimalHours(term.expectedWeeklyMinutes)} h / {formatShownNumber(term.yearlyVacationDays)} {t.vacationDays}</strong>
                </div>
              ))}
          </div>
          {termsEditMode && (
            <form
              className="employee-edit-form"
              onSubmit={(event) => {
                event.preventDefault()
                const parsedWeeklyHours = parseDecimalInput(expectedWeeklyHours)
                const parsedVacationDays = parseDecimalInput(yearlyVacationDays)
                if (parsedWeeklyHours === undefined || parsedVacationDays === undefined || parsedVacationDays < 0) {
                  setEmployeeValidationError(t.numericFieldsRequired)
                  return
                }
                if (parsedWeeklyHours <= 0) {
                  setEmployeeValidationError(t.weeklyHoursRequired)
                  return
                }
                setEmployeeValidationError('')
                setConfirmAction({
                  title: t.confirmEmploymentTermTitle,
                  body: t.confirmEmploymentTermBody,
                  confirmLabel: t.saveImportantChange,
                  onConfirm: async () => {
                    const saved = await onUpdate(user.id, {
                      effectiveFrom,
                      expectedWeeklyHours: parsedWeeklyHours,
                      yearlyVacationDays: parsedVacationDays,
                    })
                    if (saved) {
                      setTermsEditMode(false)
                    }
                    return saved
                  },
                })
              }}
            >
              <label>
                {t.effectiveFrom}
                <DateField
                  language={language}
                  title={t.effectiveFrom}
                  value={effectiveFrom}
                  onChange={(nextDate) => {
                    const activeTerm = termForDate(user, nextDate)
                    setEffectiveFrom(nextDate)
                    setExpectedWeeklyHours(numberInputValue(activeTerm.expectedWeeklyMinutes / 60))
                    setYearlyVacationDays(numberInputValue(activeTerm.yearlyVacationDays))
                  }}
                />
              </label>
              <label>
                {t.weeklyHours}
                <input
                  value={expectedWeeklyHours}
                  min={1}
                  step={0.5}
                  onChange={(event) => setExpectedWeeklyHours(event.target.value)}
                  type="number"
                />
              </label>
              <label>
                {t.vacationDays}
                <input
                  value={yearlyVacationDays}
                  min={0}
                  step={0.5}
                  onChange={(event) => setYearlyVacationDays(event.target.value)}
                  type="number"
                />
              </label>
              {employeeValidationError && <p className="form-error inline-form-error">{employeeValidationError}</p>}
              <button disabled={loading} className="primary-button" type="submit">
                <Check size={16} />
                {t.saveImportantChange}
              </button>
            </form>
          )}
        </section>

        <section className="employee-settings-section">
          <div className="employee-section-header">
            <h3>{t.currentBalanceHours}</h3>
            <button disabled={loading} className="secondary-button" type="button" onClick={() => setAdjustmentsEditMode((value) => !value)}>
              {adjustmentsEditMode ? <X size={16} /> : <Pencil size={16} />}
              {adjustmentsEditMode ? t.cancel : t.editAdjustments}
            </button>
          </div>
          <div className="employee-values-grid">
            <EmployeeSettingValue label={t.currentVacationRemainingDays} value={formatShownNumber(currentRemainingVacationDays)} />
            <EmployeeSettingValue label={t.currentBalanceHours} value={`${formatShownNumber(currentBalanceHours)} h`} />
          </div>
          {adjustmentsEditMode && (
            <form
              className="employee-edit-form"
              onSubmit={(event) => {
                event.preventDefault()
                const parsedRemainingVacationDays = parseDecimalInput(targetRemainingVacationDays)
                const parsedBalanceHours = parseDecimalInput(targetBalanceHours)
                if (parsedRemainingVacationDays === undefined || parsedBalanceHours === undefined) {
                  setEmployeeValidationError(t.numericFieldsRequired)
                  return
                }
                setEmployeeValidationError('')
                setConfirmAction({
                  title: t.confirmAdjustmentTitle,
                  body: t.confirmAdjustmentBody,
                  confirmLabel: t.saveImportantChange,
                  onConfirm: async () => {
                    const saved = await onUpdate(user.id, {
                      targetRemainingVacationDays: parsedRemainingVacationDays,
                      targetBalanceHours: parsedBalanceHours,
                    })
                    if (saved) {
                      setAdjustmentsEditMode(false)
                    }
                    return saved
                  },
                })
              }}
            >
              <label>
                {t.currentVacationRemainingDays}
                <input
                  value={targetRemainingVacationDays}
                  step={0.5}
                  onChange={(event) => setTargetRemainingVacationDays(event.target.value)}
                  type="number"
                />
              </label>
              <label>
                {t.currentBalanceHours}
                <input
                  value={targetBalanceHours}
                  step={0.25}
                  onChange={(event) => setTargetBalanceHours(event.target.value)}
                  type="number"
                />
              </label>
              {employeeValidationError && <p className="form-error inline-form-error">{employeeValidationError}</p>}
              <button disabled={loading} className="primary-button" type="submit">
                <Check size={16} />
                {t.saveImportantChange}
              </button>
            </form>
          )}
        </section>

        {user.role === 'employee' && (
          <section className="employee-settings-section">
            <div className="employee-section-header">
              <h3>{t.responsibleAdmin}</h3>
              <button disabled={loading} className="secondary-button" type="button" onClick={() => setAdminEditMode((value) => !value)}>
                {adminEditMode ? <X size={16} /> : <Pencil size={16} />}
                {adminEditMode ? t.cancel : t.editResponsibleAdmin}
              </button>
            </div>
            <EmployeeSettingValue label={t.responsibleAdmin} value={responsibleAdmin ? displayUserName(responsibleAdmin) : t.allAdminsFallback} />
            {adminEditMode && (
              <form
                className="employee-edit-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  setConfirmAction({
                    title: t.confirmResponsibleAdminTitle,
                    body: t.confirmResponsibleAdminBody,
                    confirmLabel: t.saveImportantChange,
                    onConfirm: async () => {
                      const saved = await onUpdate(user.id, { responsibleAdminUserId })
                      if (saved) {
                        setAdminEditMode(false)
                      }
                      return saved
                    },
                  })
                }}
              >
                <label>
                  {t.responsibleAdmin}
                  <AppSelect
                    ariaLabel={t.responsibleAdmin}
                    value={responsibleAdminUserId}
                    options={[
                      { value: '', label: t.allAdminsFallback },
                      ...admins.map((admin) => ({ value: admin.id, label: displayUserName(admin) })),
                    ]}
                    onChange={setResponsibleAdminUserId}
                  />
                </label>
                <button disabled={loading} className="primary-button" type="submit">
                  <Check size={16} />
                  {t.saveImportantChange}
                </button>
              </form>
            )}
          </section>
        )}

        {!coreManaged && <section className="employee-settings-section danger-section">
          <div className="employee-section-header">
            <div>
              <h3>{t.removeUserDangerTitle}</h3>
              <small>{t.confirmRemoveUserBody}</small>
            </div>
            <button disabled={loading} className="secondary-button danger-button" type="button" onClick={() => setConfirmRemoveUser(true)}>
              <Trash2 size={16} />
              {t.removeUser}
            </button>
          </div>
        </section>}
      </div>
      {confirmAction && (
        <ConfirmDialog
          title={confirmAction.title}
          body={confirmAction.body}
          confirmLabel={confirmAction.confirmLabel}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmAction(null)}
          onConfirm={async () => {
            const action = confirmAction.onConfirm
            const saved = await action()
            if (saved) {
              setConfirmAction(null)
            }
          }}
        />
      )}
      {confirmRemoveUser && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-user-dialog-title">
            <h2 id="remove-user-dialog-title">{t.confirmRemoveUserTitle}</h2>
            <p>{t.confirmRemoveUserBody}</p>
            <label className="modal-checkbox">
              <input
                checked={exportBeforeRemove}
                type="checkbox"
                onChange={(event) => setExportBeforeRemove(event.target.checked)}
              />
              {t.exportBeforeRemove}
            </label>
            <div className="modal-actions">
              <button disabled={loading} className="secondary-button" type="button" onClick={() => setConfirmRemoveUser(false)}>
                {t.cancel}
              </button>
              <button
                disabled={loading}
                className="primary-button danger-button"
                type="button"
                onClick={async () => {
                  if (exportBeforeRemove) {
                    const exported = await onExportCsv(user.id, 'all', businessDateKey())
                    if (!exported) {
                      return
                    }
                  }
                  const removed = await onRemove(user.id)
                  if (removed) {
                    setConfirmRemoveUser(false)
                  }
                }}
              >
                <Trash2 size={16} />
                {exportBeforeRemove ? t.removeUser : t.removeWithoutExport}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EmployeeSettingValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="employee-setting-value">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ApprovedActionsPanel({
  state,
  selectedUserId,
  language,
  loading,
  t,
  onUndoApproval,
}: {
  state: StatePayload
  selectedUserId?: string
  language: Language
  loading: boolean
  t: T
  onUndoApproval: (requestId: string) => MutationResult
}) {
  const [confirmUndoRequest, setConfirmUndoRequest] = useState<RequestItem | null>(null)
  const userById = new Map(state.users.map((user) => [user.id, user]))
  const selectedUser = selectedUserId ? userById.get(selectedUserId) : undefined
  const approvedRequests = state.requests
    .filter((request) => request.userId === selectedUserId && request.status === 'approved')
    .sort((left, right) => (right.decidedAt ?? right.createdAt).localeCompare(left.decidedAt ?? left.createdAt))

  return (
    <section className="panel approved-actions-panel">
      <div className="panel-title">
        <RotateCcw size={18} />
        <h2>{t.approvedActions}</h2>
      </div>
      <div className="approved-actions-content">
        {selectedUser && <div className="selected-side-user"><span>{t.employee}</span><strong>{displayUserName(selectedUser)}</strong></div>}
        <div className="approved-action-list">
          {approvedRequests.length === 0 && <p className="muted">{t.noApprovedActions}</p>}
          {approvedRequests.map((request) => (
            <article key={request.id} className="approved-action-row">
              <div>
                <span className="status-chip approved">{t.approved}</span>
                <strong>{requestLabel(request.type, t)}</strong>
                <small>{requestDateDetail(request, language)}</small>
                {request.decidedAt && (
                  <small>
                    {t.approvedAt}: {formatDateTime(request.decidedAt, language)}
                  </small>
                )}
                {request.decidedBy && (
                  <small>
                    {t.approvedBy}: {displayUserName(userById.get(request.decidedBy))}
                  </small>
                )}
              </div>
              <button disabled={loading} className="secondary-button" type="button" onClick={() => setConfirmUndoRequest(request)}>
                <RotateCcw size={16} />
                {t.undoApproval}
              </button>
            </article>
          ))}
        </div>
      </div>
      {confirmUndoRequest && (
        <ConfirmDialog
          title={t.confirmUndoApprovalTitle}
          body={`${t.confirmUndoApprovalBody}${selectedUser ? ` ${displayUserName(selectedUser)}.` : ''}`}
          confirmLabel={t.undoApproval}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmUndoRequest(null)}
          onConfirm={async () => {
            const requestId = confirmUndoRequest.id
            const saved = await onUndoApproval(requestId)
            if (saved) {
              setConfirmUndoRequest(null)
            }
          }}
        />
      )}
    </section>
  )
}

function ImportCsvPanel({
  state,
  selectedUserId,
  loading,
  t,
  onImportCsv,
}: {
  state: StatePayload
  selectedUserId?: string
  loading: boolean
  t: T
  onImportCsv: (body: Record<string, unknown>) => MutationResult
}) {
  const employees = state.users.filter((user) => user.role === 'employee')
  const [userId, setUserId] = useState(employees[0]?.id ?? state.users[0]?.id ?? '')
  const [fileName, setFileName] = useState('zeitguru-export.csv')
  const [csv, setCsv] = useState('')
  const activeUserId = selectedUserId ?? userId
  const selectedUser = state.users.find((user) => user.id === activeUserId)

  useEffect(() => {
    if (selectedUserId) {
      setUserId(selectedUserId)
    }
  }, [selectedUserId])

  function submit(event: FormEvent) {
    event.preventDefault()
    onImportCsv({ userId: activeUserId, fileName, csv })
  }

  return (
    <section className="panel import-panel">
      <div className="panel-title">
        <Upload size={18} />
        <h2>{t.csvImport}</h2>
      </div>
      <form className="stacked-form" onSubmit={submit}>
        {selectedUser ? (
          <div className="selected-side-user">
            <span>{t.employee}</span>
            <strong>{displayUserName(selectedUser)}</strong>
          </div>
        ) : (
          <label>
            {t.employee}
            <AppSelect
              ariaLabel={t.employee}
              value={userId}
              options={employees.map((user) => ({ value: user.id, label: displayUserName(user) }))}
              onChange={setUserId}
            />
          </label>
        )}
        <label>
          {t.fileName}
          <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
        </label>
        <label>
          {t.csvContent}
          <textarea
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            placeholder="Datum;Beginn;Ende;Pause;Notiz"
            rows={7}
          />
        </label>
        <button disabled={loading || !activeUserId || csv.trim().length === 0} className="primary-button" type="submit">
          <Upload size={16} />
          {t.importCsv}
        </button>
      </form>
      <div className="import-list">
        <h3>{t.recentImports}</h3>
        {state.importBatches.length === 0 && <p className="muted">{t.noImports}</p>}
        {state.importBatches.slice(0, 4).map((batch) => (
          <article key={batch.id} className="import-row">
            <strong>{batch.fileName}</strong>
            <small>
              {batch.importedRows} {t.imported}, {batch.skippedRows} {t.skipped}
            </small>
            {batch.errors.slice(0, 2).map((error) => (
              <small key={error}>{error}</small>
            ))}
          </article>
        ))}
      </div>
    </section>
  )
}

function SettingsView({
  onUpdateOvertimePolicy,
  onRetryOvertimeAlerts,
  state,
  language,
  loading,
  t,
  onCreateBackup,
  onUpdateMailServer,
  onTestMailServer,
  onDeleteMailServer,
  onUpdateLicense,
  onDeleteLicense,
}: {
  onUpdateOvertimePolicy: (body: Record<string,unknown>) => MutationResult
  onRetryOvertimeAlerts: () => MutationResult
  state: StatePayload
  language: Language
  loading: boolean
  t: T
  onCreateBackup: () => MutationResult
  onUpdateMailServer: (body: Record<string, unknown>) => MutationResult
  onTestMailServer: () => MutationResult
  onDeleteMailServer: () => MutationResult
  onUpdateLicense: (body: Record<string, unknown>) => MutationResult
  onDeleteLicense: () => MutationResult
}) {
  return (
    <div className="settings-layout">
      {state.coreManaged ? <SuiteAdminLink title={language === 'de' ? 'Lizenz' : 'License'} description={language === 'de' ? 'Lizenzstatus und verfügbare Nutzerplätze für die gesamte Suite prüfen.' : 'Review license status and available seats for the whole suite.'} label={language === 'de' ? 'Lizenz in Core verwalten' : 'Manage license in Core'} href={(coreOfficeUrl || '/') + '#license'} /> : <LicensePanel
        licenseState={state.licenseState}
        language={language}
        loading={loading}
        t={t}
        onUpdate={onUpdateLicense}
        onDelete={onDeleteLicense}
      />}
      <MailServerPanel
        settings={state.mailServerSettings}
        loading={loading}
        t={t}
        onUpdate={onUpdateMailServer}
        onTest={onTestMailServer}
        onDelete={onDeleteMailServer}
      />
      <OvertimePolicyPanel state={state.overtimePolicy} users={state.users} language={language} loading={loading} readOnly={state.readOnly} onSave={onUpdateOvertimePolicy} onRetry={onRetryOvertimeAlerts}/>
      <BackupPanel state={state} loading={loading} t={t} onCreateBackup={onCreateBackup} />
    </div>
  )
}

function LicensePanel({
  licenseState,
  language,
  loading,
  t,
  onUpdate,
  onDelete,
}: {
  licenseState?: LicenseState
  language: Language
  loading: boolean
  t: T
  onUpdate: (body: Record<string, unknown>) => MutationResult
  onDelete: () => MutationResult
}) {
  const [licenseKey, setLicenseKey] = useState('')
  const [validationError, setValidationError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setValidationError('')
  }, [licenseState])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (licenseKey.trim().length === 0) {
      setValidationError(t.licenseKeyRequired)
      return
    }

    setValidationError('')
    const saved = await onUpdate({ licenseKey })
    if (saved) {
      setLicenseKey('')
    }
  }

  const details = licenseState?.details

  return (
    <section className="panel license-panel">
      <div className="panel-title">
        <ShieldCheck size={18} />
        <h2>{t.license}</h2>
      </div>

      {licenseState ? (
        <div
          className={classNames(
            'license-status-card',
            licenseState.status === 'community' || licenseState.status === 'licensed' ? 'valid' : 'warning',
          )}
        >
          <div>
            <span>{t.licenseStatus}</span>
            <strong>{licenseStatusLabel(licenseState, t)}</strong>
          </div>
          <p>{licenseState.message}</p>
        </div>
      ) : (
        <p className="mail-server-note">{t.noLicenseConfigured}</p>
      )}

      {licenseState && (
        <div className="license-status-grid">
          <div>
            <span>{t.activeUsers}</span>
            <strong>{formatShownNumber(licenseState.activeUsers)}</strong>
          </div>
          <div>
            <span>{t.activeUserLimit}</span>
            <strong>{formatShownNumber(licenseState.effectiveUserLimit)}</strong>
          </div>
          <div>
            <span>{t.freeUserLimit}</span>
            <strong>{formatShownNumber(licenseState.freeUserLimit)}</strong>
          </div>
        </div>
      )}

      {details && (
        <div className="license-details">
          <span>{t.holder}</span>
          <strong>{details.holderName}</strong>
          <span>{t.contact}</span>
          <strong>{details.contactEmail}</strong>
          <span>{t.plan}</span>
          <strong>{licensePlanLabel(details.plan, t)}</strong>
          <span>{t.issuedAt}</span>
          <strong>{displayDateOnlyLabel(details.issuedAt, language)}</strong>
          {details.validUntil && (
            <>
              <span>{t.validUntil}</span>
              <strong>{displayDateOnlyLabel(details.validUntil, language)}</strong>
            </>
          )}
        </div>
      )}

      {!licenseState?.licenseConfigured && <p className="mail-server-note">{t.noLicenseConfigured}</p>}

      <form className="stacked-form" onSubmit={submit}>
        <label>
          {t.licenseKey}
          <textarea
            value={licenseKey}
            className="license-key-input"
            onChange={(event) => setLicenseKey(event.target.value)}
            placeholder={t.licenseKeyPlaceholder}
            rows={4}
            spellCheck={false}
          />
        </label>
        {validationError && <p className="form-error inline-form-error">{validationError}</p>}
        <div className="mail-server-actions">
          <button disabled={loading || licenseKey.trim().length === 0} className="primary-button" type="submit">
            <Check size={16} />
            {t.saveLicense}
          </button>
          <button
            disabled={loading || !licenseState?.licenseConfigured}
            className="secondary-button danger-button"
            type="button"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={16} />
            {t.deleteLicense}
          </button>
        </div>
      </form>

      {confirmDelete && (
        <ConfirmDialog
          title={t.confirmDeleteLicenseTitle}
          body={t.confirmDeleteLicenseBody}
          confirmLabel={t.deleteLicense}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const saved = await onDelete()
            if (saved) {
              setConfirmDelete(false)
            }
          }}
        />
      )}
    </section>
  )
}

function MailServerPanel({
  settings,
  loading,
  t,
  onUpdate,
  onTest,
  onDelete,
}: {
  settings?: MailServerSettings
  loading: boolean
  t: T
  onUpdate: (body: Record<string, unknown>) => MutationResult
  onTest: () => MutationResult
  onDelete: () => MutationResult
}) {
  const [host, setHost] = useState(settings?.host ?? '')
  const [port, setPort] = useState(String(settings?.port ?? 587))
  const [secure, setSecure] = useState(Boolean(settings?.secure))
  const [user, setUser] = useState(settings?.user ?? '')
  const [password, setPassword] = useState('')
  const [fromAddress, setFromAddress] = useState(settings?.fromAddress ?? '')
  const [validationError, setValidationError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setHost(settings?.host ?? '')
    setPort(String(settings?.port ?? 587))
    setSecure(Boolean(settings?.secure))
    setUser(settings?.user ?? '')
    setPassword('')
    setFromAddress(settings?.fromAddress ?? '')
    setValidationError('')
  }, [settings])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsedPort = Number(port)
    if (!host.trim() || !fromAddress.trim() || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setValidationError(t.numericFieldsRequired)
      return
    }

    setValidationError('')
    const saved = await onUpdate({
      host,
      port: parsedPort,
      secure,
      user,
      password,
      fromAddress,
    })
    if (saved) {
      setPassword('')
    }
  }

  return (
    <section className="panel mail-server-panel">
      <div className="panel-title">
        <Mail size={18} />
        <h2>{t.mailServer}</h2>
      </div>
      {!settings && <p className="mail-server-note">{t.noMailServer}</p>}
      <form className="stacked-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t.smtpHost}
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="smtp.example.com" />
          </label>
          <label>
            {t.smtpPort}
            <input value={port} min={1} max={65535} step={1} type="number" onChange={(event) => setPort(event.target.value)} />
          </label>
          <label>
            {t.smtpUser}
            <input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="username" />
          </label>
          <label>
            {t.smtpPassword}
            <PasswordInput aria-label={t.smtpPassword} language={readSuiteLanguage()}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={settings?.passwordConfigured ? 'smtp-password-note' : undefined}
              autoComplete="new-password"
            />
            {settings?.passwordConfigured && <small className="field-note" id="smtp-password-note">{t.passwordSaved}. {t.passwordPlaceholder}</small>}
          </label>
        </div>
        <label>
          {t.smtpFrom}
          <input value={fromAddress} onChange={(event) => setFromAddress(event.target.value)} placeholder="Digital Core Office Time <time@example.com>" />
        </label>
        <label className="toggle-row">
          <input checked={secure} type="checkbox" onChange={(event) => setSecure(event.target.checked)} />
          <span>{t.smtpSecure}</span>
        </label>
        {validationError && <p className="form-error inline-form-error">{validationError}</p>}
        <div className="mail-server-actions">
          <button disabled={loading || host.trim().length === 0 || fromAddress.trim().length === 0} className="primary-button" type="submit">
            <Check size={16} />
            {t.saveMailServer}
          </button>
          <button disabled={loading || !settings} className="secondary-button" type="button" onClick={onTest}>
            <Send size={16} />
            {t.testMailServer}
          </button>
          <button disabled={loading || !settings} className="secondary-button danger-button" type="button" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} />
            {t.deleteMailServer}
          </button>
        </div>
      </form>
      {confirmDelete && (
        <ConfirmDialog
          title={t.confirmDeleteMailServerTitle}
          body={t.confirmDeleteMailServerBody}
          confirmLabel={t.deleteMailServer}
          cancelLabel={t.cancel}
          loading={loading}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const saved = await onDelete()
            if (saved) {
              setConfirmDelete(false)
            }
          }}
        />
      )}
    </section>
  )
}

function BackupPanel({
  state,
  loading,
  t,
  onCreateBackup,
}: {
  state: StatePayload
  loading: boolean
  t: T
  onCreateBackup: () => MutationResult
}) {
  return (
    <section className="panel backup-panel">
      <div className="panel-title">
        <Database size={18} />
        <h2>{t.backup}</h2>
      </div>
      <div className="backup-details">
        <span>{t.dataFile}</span>
        <code>{state.backup.dataFile}</code>
        <span>{t.backupFolder}</span>
        <code>{state.backup.backupDir}</code>
        <span>{t.lastBackup}</span>
        <code>{state.backup.lastWeeklyBackup ?? t.noneYet}</code>
      </div>
      <button disabled={loading} className="secondary-button backup-button" type="button" onClick={onCreateBackup}>
        <Database size={16} />
        {t.createBackup}
      </button>
    </section>
  )
}

function HolidayAdmin({
  state,
  loading,
  language,
  t,
  onLoadHolidayTemplateOptions,
  onUpdateHolidaySettings,
  onHolidayOverride,
  onUpdateOverride,
  onDeleteOverride,
}: {
  state: StatePayload
  loading: boolean
  language: Language
  t: T
  onLoadHolidayTemplateOptions: (settings: Partial<HolidaySettings>) => Promise<HolidayTemplateOptions>
  onUpdateHolidaySettings: (body: Record<string, unknown>) => MutationResult
  onHolidayOverride: (body: Record<string, unknown>) => MutationResult
  onUpdateOverride: (id: string, body: Record<string, unknown>) => MutationResult
  onDeleteOverride: (id: string) => MutationResult
}) {
  const [date, setDate] = useState(businessDateKey())
  const [name, setName] = useState('')
  const [type, setType] = useState<HolidayOverrideType>('custom')
  const [freePercent, setFreePercent] = useState('100')
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null)
  const [isEditingHoliday, setIsEditingHoliday] = useState(false)
  const [holidayValidationError, setHolidayValidationError] = useState('')
  const [templateCountry, setTemplateCountry] = useState(state.holidaySettings.country)
  const [templateState, setTemplateState] = useState(state.holidaySettings.state ?? '')
  const [templateRegion, setTemplateRegion] = useState(state.holidaySettings.region ?? '')
  const [templateLanguage, setTemplateLanguage] = useState(state.holidaySettings.language)
  const [templateOptions, setTemplateOptions] = useState(state.holidayTemplateOptions)
  const [templateValidationError, setTemplateValidationError] = useState('')
  const sortedHolidays = useMemo(() => [...state.holidays].sort((left, right) => left.date.localeCompare(right.date)), [state.holidays])

  useEffect(() => {
    setTemplateCountry(state.holidaySettings.country)
    setTemplateState(state.holidaySettings.state ?? '')
    setTemplateRegion(state.holidaySettings.region ?? '')
    setTemplateLanguage(state.holidaySettings.language)
    setTemplateOptions(state.holidayTemplateOptions)
    setTemplateValidationError('')
  }, [state.holidaySettings, state.holidayTemplateOptions])

  useEffect(() => {
    let active = true

    onLoadHolidayTemplateOptions({
      country: templateCountry,
      state: templateState || undefined,
      region: templateRegion || undefined,
      language: templateLanguage,
    })
      .then((options) => {
        if (!active) {
          return
        }
        setTemplateOptions(options)
        if (templateState && !options.states.some((option) => option.code === templateState)) {
          setTemplateState('')
          setTemplateRegion('')
        } else if (templateRegion && !options.regions.some((option) => option.code === templateRegion)) {
          setTemplateRegion('')
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setTemplateValidationError(error instanceof Error ? error.message : 'Failed to load holiday templates')
        }
      })

    return () => {
      active = false
    }
  }, [onLoadHolidayTemplateOptions, templateCountry, templateLanguage, templateRegion, templateState])

  function startHolidayEdit(holiday: Holiday) {
    const override = state.holidayOverrides.find((item) => item.id === holiday.id)
    setDate(holiday.date)
    setName(holidayDisplayName(holiday, language))
    setType('custom')
    setFreePercent(numberInputValue(holiday.freePercent))
    setEditingOverrideId(override?.id ?? null)
    setIsEditingHoliday(true)
    setHolidayValidationError('')
  }

  function startOverrideEdit(overrideId: string) {
    const override = state.holidayOverrides.find((item) => item.id === overrideId)
    if (!override) {
      return
    }

    setDate(override.date)
    setName(override.name)
    setType(override.type)
    setFreePercent(numberInputValue(override.freePercent))
    setEditingOverrideId(override.id)
    setIsEditingHoliday(true)
    setHolidayValidationError('')
  }

  function cancelEdit() {
    setDate(businessDateKey())
    setName('')
    setType('custom')
    setFreePercent('100')
    setEditingOverrideId(null)
    setIsEditingHoliday(false)
    setHolidayValidationError('')
  }

  async function submitTemplate(event: FormEvent) {
    event.preventDefault()
    if (!templateCountry) {
      setTemplateValidationError(t.holidayCountry)
      return
    }

    setTemplateValidationError('')
    const saved = await onUpdateHolidaySettings({
      country: templateCountry,
      state: templateState || undefined,
      region: templateRegion || undefined,
      language: templateLanguage,
    })
    if (!saved) {
      setTemplateValidationError('')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsedFreePercent = parseDecimalInput(freePercent)
    if (parsedFreePercent === undefined || parsedFreePercent < 0 || parsedFreePercent > 100) {
      setHolidayValidationError(t.numericFieldsRequired)
      return
    }
    const body = { date, name: name || t.manualHoliday, type, freePercent: parsedFreePercent }
    const saved = editingOverrideId
      ? await onUpdateOverride(editingOverrideId, body)
      : await onHolidayOverride(body)
    if (saved) {
      setName('')
      setFreePercent('100')
      setEditingOverrideId(null)
      setIsEditingHoliday(false)
      setHolidayValidationError('')
    }
  }

  return (
    <section className="panel holiday-admin-panel">
      <div className="panel-title">
        <CalendarDays size={18} />
        <h2>{t.holidayTemplates}</h2>
      </div>
      <form className="holiday-template-form" onSubmit={submitTemplate}>
        <label>
          {t.holidayCountry}
          <AppSelect
            ariaLabel={t.holidayCountry}
            value={templateCountry}
            options={templateOptions.countries.map((option) => ({ value: option.code, label: option.name }))}
            onChange={(nextCountry) => {
              setTemplateCountry(nextCountry)
              setTemplateState('')
              setTemplateRegion('')
            }}
          />
        </label>
        <label>
          {t.holidayState}
          <AppSelect
            ariaLabel={t.holidayState}
            value={templateState}
            disabled={templateOptions.states.length === 0}
            options={[
              { value: '', label: t.noHolidayState },
              ...templateOptions.states.map((option) => ({ value: option.code, label: option.name })),
            ]}
            onChange={(nextState) => {
              setTemplateState(nextState)
              setTemplateRegion('')
            }}
          />
        </label>
        <label>
          {t.holidayRegion}
          <AppSelect
            ariaLabel={t.holidayRegion}
            value={templateRegion}
            disabled={templateOptions.regions.length === 0}
            options={[
              { value: '', label: t.noHolidayRegion },
              ...templateOptions.regions.map((option) => ({ value: option.code, label: option.name })),
            ]}
            onChange={setTemplateRegion}
          />
        </label>
        <label>
          {t.holidayTemplateLanguage}
          <AppSelect
            ariaLabel={t.holidayTemplateLanguage}
            value={templateLanguage}
            options={[
              { value: 'de', label: 'Deutsch' },
              { value: 'en', label: 'English' },
            ]}
            onChange={setTemplateLanguage}
          />
        </label>
        <button disabled={loading || !templateCountry} className="primary-button" type="submit">
          <Check size={16} />
          {t.saveHolidayTemplate}
        </button>
        {templateValidationError && <p className="form-error inline-form-error">{templateValidationError}</p>}
        <p className="muted holiday-template-note">{t.manualHolidayHint}</p>
      </form>
      <form className="holiday-form" onSubmit={submit}>
        <label>
          {t.date}
          <DateField language={language} title={t.date} value={date} onChange={setDate} />
        </label>
        <label>
          {t.holidayName}
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t.action}
          <AppSelect
            ariaLabel={t.action}
            value={type}
            options={[
              { value: 'custom', label: t.addHoliday },
              { value: 'disabled', label: t.disableHoliday },
            ]}
            onChange={(nextType) => setType(nextType as HolidayOverrideType)}
          />
        </label>
        <label>
          {t.holidayFreePercent}
          <input
            value={freePercent}
            min={0}
            max={100}
            step={5}
            onChange={(event) => setFreePercent(event.target.value)}
            type="number"
          />
        </label>
        <div className="holiday-form-actions">
          <button disabled={loading} className="primary-button" type="submit">
            <Check size={16} />
            {isEditingHoliday ? t.save : t.apply}
          </button>
          {isEditingHoliday && (
            <button disabled={loading} className="secondary-button" type="button" onClick={cancelEdit}>
              <X size={16} />
              {t.cancelEdit}
            </button>
          )}
        </div>
        {holidayValidationError && <p className="form-error inline-form-error">{holidayValidationError}</p>}
      </form>
      <h3 className="override-list-title">{t.templatePublicHolidays}</h3>
      <div className="holiday-list">
        {sortedHolidays.slice(0, 18).map((holiday) => (
          <button
            key={`${holiday.id}-${holiday.date}`}
            className={classNames('holiday-item', holiday.source === 'custom' && 'custom')}
            title={t.editHoliday}
            type="button"
            onClick={() => startHolidayEdit(holiday)}
          >
            <span>
              {formatDateKey(holiday.date, language)} {holidayDisplayLabel(holiday, language)}
            </span>
            <Pencil size={14} />
          </button>
        ))}
      </div>
      <h3 className="override-list-title">{t.manualHolidayChanges}</h3>
      <div className="override-list">
        {state.holidayOverrides.length === 0 && <p className="muted">{t.noHolidayOverrides}</p>}
        {state.holidayOverrides.map((override) => (
          <article key={override.id} className="override-row">
            <span>
              {formatDateKey(override.date, language)} {override.name}
              <small>
                {override.type === 'custom' ? t.addHoliday : t.disableHoliday}
                {override.type === 'custom' ? `, ${formatShownNumber(override.freePercent)}%` : ''}
              </small>
            </span>
            <div className="row-actions">
              <button className="icon-button" title={t.editHoliday} type="button" onClick={() => startOverrideEdit(override.id)}>
                <Pencil size={16} />
              </button>
              <button className="icon-button" title={t.removeHolidayChange} type="button" onClick={() => onDeleteOverride(override.id)}>
                <X size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

export default App



