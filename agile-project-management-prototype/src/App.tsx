import { PasswordInput } from '@digital-core-office/suite-ui'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardList,
  Factory,
  Filter,
  Flag,
  LayoutGrid,
  LayoutDashboard,
  ListPlus,
  LogIn,
  Map,
  MonitorCog,
  Moon,
  Save,
  Search,
  ShieldCheck,
  Sun,
  Users,
} from 'lucide-react'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
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
} from '@digital-core-office/suite-ui'
import '@digital-core-office/suite-ui/styles.css'

import { emptyWorkspace, type Role, type Area, type Priority, type WorkType, type WorkStatus, type DecisionStatus, type WorkItem, type Stakeholder, type Decision, type AgileState, type WorkspaceSnapshot, type WorkspaceOperation, type WorkspaceCommand, type WorkspaceAudit } from './workspace'

type Tab = 'portfolio' | 'backlog' | 'board' | 'roadmap' | 'stakeholders' | 'decisions'
type Language = 'en' | 'de'
type Theme = 'light' | 'dark'

interface AuthUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'employee'
  active: boolean
  mustChangePassword: boolean
}

interface AuthState {
  loading: boolean
  submitting: boolean
  token: string
  user?: AuthUser
  error: string
  problem?: 'connection' | 'access'
}

interface DraftItem {
  title: string
  type: WorkType
  area: Area
  owner: Role
  stakeholder: string
  priority: Priority
  effort: string
  businessValue: string
  risk: string
  sprint: string
  release: string
  due: string
  dependsOn: string
  acceptance: string
}

const storageKey = 'digital-core-office.agile-prototype.v1'
const authTokenStorageKey = 'digital-core-office.agile-token'
const languageStorageKey = 'digital-core-office.agile-language'
const themeStorageKey = 'digital-core-office.agile-theme'
const agileBasePath = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '')
const agileApiBase =
  (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '') ||
  (agileBasePath && agileBasePath !== '/' ? agileBasePath : import.meta.env.PROD ? '' : 'http://localhost:4197')
const timeTrackingUrl = (import.meta.env.VITE_TIME_URL ?? 'http://localhost:4177').replace(/\/+$/, '')
const inventorySystemUrl = (import.meta.env.VITE_INVENTORY_URL ?? 'http://localhost:4187').replace(/\/+$/, '')
const configuredCoreOfficeUrl = (import.meta.env.VITE_CORE_URL ?? '').trim()
const coreOfficeUrl = configuredCoreOfficeUrl ? configuredCoreOfficeUrl.replace(/\/+$/, '') || '/' : ''
const enabledSuiteModules = new Set(
  String(import.meta.env.VITE_ENABLED_MODULES ?? 'time,inventory,agile').split(',').map((value) => value.trim()),
)
const isEmbeddedSuiteWorkspace = new URLSearchParams(window.location.search).get('embedded') === '1' && window.self !== window.top
const roles: Role[] = ['Sales', 'Project Management', 'Software Development', 'Hardware Development']
const areas: Area[] = ['Sales', 'Project', 'Software', 'Hardware']
const priorities: Priority[] = ['Critical', 'High', 'Medium', 'Low']
const workTypes: WorkType[] = ['Opportunity', 'Requirement', 'Epic', 'Story', 'Task', 'Bug', 'Decision']
const statuses: WorkStatus[] = ['Intake', 'Ready', 'In Progress', 'Blocked', 'Review', 'Done']
const decisionStatuses: DecisionStatus[] = ['Proposed', 'Accepted', 'Rejected']

const tabs: Array<{ id: Tab; icon: typeof LayoutDashboard }> = [
  { id: 'portfolio', icon: LayoutDashboard },
  { id: 'backlog', icon: ClipboardList },
  { id: 'board', icon: BarChart3 },
  { id: 'roadmap', icon: Map },
  { id: 'stakeholders', icon: Users },
  { id: 'decisions', icon: ShieldCheck },
]

const agileTranslations = {
  en: {
    appName: 'Digital Core Office Agile',
    signInSubtitle: 'Digital Core Office sign in',
    checkingSession: 'Checking session...',
    signInToContinue: 'Sign in to continue.',
    sessionExpired: 'Session expired.',
    emailOrPasswordIncorrect: 'Email or password is incorrect.',
    signInFailed: 'Sign in failed.',
    email: 'Email',
    password: 'Password',
    signingIn: 'Signing in',
    signIn: 'Sign in',
    stayLoggedIn: 'Stay logged in',
    forgotPasswordReset: 'Forgot your password? Reset it',
    language: 'Language',
    switchToDarkMode: 'Switch to dark mode',
    switchToLightMode: 'Switch to light mode',
    roleLens: 'Role lens',
    signOut: 'Sign out',
    systemNav: {
      label: 'Switch systems',
      time: 'Time',
      inventory: 'Inventory',
      openTime: 'Open Time Tracking',
      openInventory: 'Open Inventory Management',
    },
    tabs: {
      portfolio: 'Portfolio',
      backlog: 'Backlog',
      board: 'Sprint',
      roadmap: 'Roadmap',
      stakeholders: 'Stakeholders',
      decisions: 'Decisions',
    },
    newItem: 'New item',
    fields: {
      title: 'Title',
      type: 'Type',
      area: 'Area',
      owner: 'Owner',
      priority: 'Priority',
      effort: 'Effort',
      value: 'Value',
      risk: 'Risk',
      due: 'Due',
      stakeholder: 'Stakeholder',
      sprint: 'Sprint',
      release: 'Release',
      dependency: 'Dependency',
      acceptance: 'Acceptance',
      decision: 'Decision',
      notes: 'Notes',
    },
    saveItem: 'Save item',
    saveDecision: 'Save decision',
    filters: {
      searchPlaceholder: 'Search work, owners, releases',
      all: 'All',
    },
    portfolio: {
      openWork: 'Open work',
      done: 'done',
      blocked: 'Blocked',
      highRisk: 'high risk',
      businessValue: 'Business value',
      effort: 'effort',
      ownedOrAdjacent: 'owned or adjacent',
      blockedWork: 'Blocked work',
      noBlockedWork: 'No blocked work.',
      upcomingDueDates: 'Upcoming due dates',
    },
    backlog: {
      title: 'Backlog',
      work: 'Work',
      area: 'Area',
      status: 'Status',
      owner: 'Owner',
      value: 'Value',
      risk: 'Risk',
      due: 'Due',
      flow: 'Flow',
    },
    roadmap: {
      title: 'Roadmap',
    },
    stakeholders: {
      title: 'Stakeholder register',
      open: 'Open',
      blocked: 'Blocked',
      requests: 'Requests',
    },
    decisions: {
      log: 'Decision log',
      capture: 'Capture decision',
    },
    workCard: {
      owner: 'Owner',
      effort: 'Effort',
      value: 'Value',
      risk: 'Risk',
      moveLeft: 'Move left',
      moveRight: 'Move right',
    },
    roles: {
      Sales: 'Sales',
      'Project Management': 'Project Management',
      'Software Development': 'Software Development',
      'Hardware Development': 'Hardware Development',
    },
    areas: {
      Sales: 'Sales',
      Project: 'Project',
      Software: 'Software',
      Hardware: 'Hardware',
    },
    priorities: {
      Critical: 'Critical',
      High: 'High',
      Medium: 'Medium',
      Low: 'Low',
    },
    workTypes: {
      Opportunity: 'Opportunity',
      Requirement: 'Requirement',
      Epic: 'Epic',
      Story: 'Story',
      Task: 'Task',
      Bug: 'Bug',
      Decision: 'Decision',
    },
    statuses: {
      Intake: 'Intake',
      Ready: 'Ready',
      'In Progress': 'In Progress',
      Blocked: 'Blocked',
      Review: 'Review',
      Done: 'Done',
    },
    decisionStatuses: {
      Proposed: 'Proposed',
      Accepted: 'Accepted',
      Rejected: 'Rejected',
    },
  },
  de: {
    appName: 'Digital Core Office Agile',
    signInSubtitle: 'Digital Core Office Anmeldung',
    checkingSession: 'Sitzung wird geprueft...',
    signInToContinue: 'Melde dich an, um fortzufahren.',
    sessionExpired: 'Sitzung abgelaufen.',
    emailOrPasswordIncorrect: 'E-Mail oder Passwort ist falsch.',
    signInFailed: 'Anmeldung fehlgeschlagen.',
    email: 'E-Mail',
    password: 'Passwort',
    signingIn: 'Anmeldung laeuft',
    signIn: 'Anmelden',
    stayLoggedIn: 'Eingeloggt bleiben',
    forgotPasswordReset: 'Passwort vergessen? Zuruecksetzen',
    language: 'Sprache',
    switchToDarkMode: 'Dunkelmodus aktivieren',
    switchToLightMode: 'Hellmodus aktivieren',
    roleLens: 'Rollenansicht',
    signOut: 'Abmelden',
    systemNav: {
      label: 'System wechseln',
      time: 'Zeit',
      inventory: 'Inventar',
      openTime: 'Zeiterfassung oeffnen',
      openInventory: 'Inventarverwaltung oeffnen',
    },
    tabs: {
      portfolio: 'Portfolio',
      backlog: 'Backlog',
      board: 'Sprint',
      roadmap: 'Roadmap',
      stakeholders: 'Stakeholder',
      decisions: 'Entscheidungen',
    },
    newItem: 'Neuer Eintrag',
    fields: {
      title: 'Titel',
      type: 'Typ',
      area: 'Bereich',
      owner: 'Verantwortlich',
      priority: 'Prioritaet',
      effort: 'Aufwand',
      value: 'Wert',
      risk: 'Risiko',
      due: 'Faellig',
      stakeholder: 'Stakeholder',
      sprint: 'Sprint',
      release: 'Release',
      dependency: 'Abhaengigkeit',
      acceptance: 'Akzeptanz',
      decision: 'Entscheidung',
      notes: 'Notizen',
    },
    saveItem: 'Eintrag speichern',
    saveDecision: 'Entscheidung speichern',
    filters: {
      searchPlaceholder: 'Arbeit, Verantwortliche, Releases suchen',
      all: 'Alle',
    },
    portfolio: {
      openWork: 'Offene Arbeit',
      done: 'erledigt',
      blocked: 'Blockiert',
      highRisk: 'hohes Risiko',
      businessValue: 'Geschaeftswert',
      effort: 'Aufwand',
      ownedOrAdjacent: 'direkt oder angrenzend',
      blockedWork: 'Blockierte Arbeit',
      noBlockedWork: 'Keine blockierte Arbeit.',
      upcomingDueDates: 'Naechste Faelligkeiten',
    },
    backlog: {
      title: 'Backlog',
      work: 'Arbeit',
      area: 'Bereich',
      status: 'Status',
      owner: 'Verantwortlich',
      value: 'Wert',
      risk: 'Risiko',
      due: 'Faellig',
      flow: 'Fluss',
    },
    roadmap: {
      title: 'Roadmap',
    },
    stakeholders: {
      title: 'Stakeholder-Register',
      open: 'Offen',
      blocked: 'Blockiert',
      requests: 'Anfragen',
    },
    decisions: {
      log: 'Entscheidungslog',
      capture: 'Entscheidung erfassen',
    },
    workCard: {
      owner: 'Verantwortlich',
      effort: 'Aufwand',
      value: 'Wert',
      risk: 'Risiko',
      moveLeft: 'Nach links bewegen',
      moveRight: 'Nach rechts bewegen',
    },
    roles: {
      Sales: 'Vertrieb',
      'Project Management': 'Projektmanagement',
      'Software Development': 'Softwareentwicklung',
      'Hardware Development': 'Hardwareentwicklung',
    },
    areas: {
      Sales: 'Vertrieb',
      Project: 'Projekt',
      Software: 'Software',
      Hardware: 'Hardware',
    },
    priorities: {
      Critical: 'Kritisch',
      High: 'Hoch',
      Medium: 'Mittel',
      Low: 'Niedrig',
    },
    workTypes: {
      Opportunity: 'Chance',
      Requirement: 'Anforderung',
      Epic: 'Epic',
      Story: 'Story',
      Task: 'Aufgabe',
      Bug: 'Fehler',
      Decision: 'Entscheidung',
    },
    statuses: {
      Intake: 'Eingang',
      Ready: 'Bereit',
      'In Progress': 'In Arbeit',
      Blocked: 'Blockiert',
      Review: 'Review',
      Done: 'Erledigt',
    },
    decisionStatuses: {
      Proposed: 'Vorgeschlagen',
      Accepted: 'Angenommen',
      Rejected: 'Abgelehnt',
    },
  },
}

type AgileCopy = (typeof agileTranslations)['en']

const AgileCopyContext = createContext<AgileCopy>(agileTranslations.en)

function useAgileCopy() {
  return useContext(AgileCopyContext)
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

function initialLanguage(): Language {
  return readSuiteLanguage([languageStorageKey])
}

function initialTheme(): Theme {
  return readSuiteTheme([themeStorageKey])
}

function storedAgileAuthToken() {
  return localStorage.getItem(authTokenStorageKey) ?? sessionStorage.getItem(authTokenStorageKey) ?? ''
}

function rememberAgileAuthToken(token: string, stayLoggedIn: boolean) {
  localStorage.removeItem(authTokenStorageKey)
  sessionStorage.removeItem(authTokenStorageKey)
  if (token) {
    const storage = stayLoggedIn ? localStorage : sessionStorage
    storage.setItem(authTokenStorageKey, token)
  }
}

function clearAgileAuthToken() {
  localStorage.removeItem(authTokenStorageKey)
  sessionStorage.removeItem(authTokenStorageKey)
}

class SessionCheckError extends Error {
  readonly status: number
  constructor(status: number) { super('Session check failed.'); this.status = status }
}

function notifyCoreSessionRejected(status: number) {
  if ((status === 401 || status === 403) && window.parent !== window) {
    window.parent.postMessage({ type: 'dco:session-invalidated' }, window.location.origin)
  }
}

async function readAgileSession(path: string, token = '') {
  const response = await fetch(`${agileApiBase}${path}`, {
    cache: 'no-store', credentials: 'include', signal: AbortSignal.timeout(10_000),
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!response.ok) throw new SessionCheckError(response.status)
  const payload = await response.json() as { user: AuthUser; token: string; stayLoggedIn?: boolean }
  if (!payload.user?.id) throw new Error('Session response was incomplete.')
  return payload
}

async function readAgileWorkspace(token = '') {
  const response = await fetch(`${agileApiBase}/api/agile/workspace`, {
    credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (response.status === 401 || response.status === 403) throw new SessionCheckError(response.status)
  const payload = await response.json() as WorkspaceSnapshot & { message?: string }
  if (!response.ok) throw new Error(payload.message ?? 'Could not load the shared workspace.')
  return payload
}

function App() {
  const [auth, setAuth] = useState<AuthState>({ error: '', loading: true, submitting: false, token: '' })
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const state = workspace?.state ?? emptyWorkspace()
  const [workspaceError, setWorkspaceError] = useState('')
  const [workspaceReadError, setWorkspaceReadError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const sessionEpoch = useRef(0)
  const authCheckEpoch = useRef(0)
  const [sessionRetry, setSessionRetry] = useState(0)
  const refreshWorkspace = useRef<(() => void) | undefined>(undefined)
  const [pendingCommand, setPendingCommand] = useState<WorkspaceCommand | null>(null)
  const [audit, setAudit] = useState<WorkspaceAudit[]>([])
  const [legacyAuthorized, setLegacyAuthorized] = useState(false)
  const [hasLegacy, setHasLegacy] = useState(false)
  const [tab, setTab] = useState<Tab>('portfolio')
  const [role, setRole] = useState<Role>('Project Management')
  const [language, setLanguage] = useState<Language>(initialLanguage)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [query, setQuery] = useState('')
  const [areaFilter, setAreaFilter] = useState<Area | 'All'>('All')
  const [statusFilter, setStatusFilter] = useState<WorkStatus | 'All'>('All')
  const [draft, setDraft] = useState<DraftItem>(() => emptyDraft('Project Management', 'Sprint 1'))
  const [decisionTitle, setDecisionTitle] = useState('')
  const [decisionNotes, setDecisionNotes] = useState('')
  const copy = agileTranslations[language]

  useEffect(() => {
    document.title = copy.appName
  }, [copy.appName])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const syncSuitePreferences = (event: StorageEvent) => {
      if (event.key === suiteLanguageStorageKey) setLanguage(readSuiteLanguage([languageStorageKey]))
      if (event.key === suiteThemeStorageKey) setTheme(readSuiteTheme([themeStorageKey]))
    }
    window.addEventListener('storage', syncSuitePreferences)
    return () => window.removeEventListener('storage', syncSuitePreferences)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function bootstrapSession() {
      const epoch = ++authCheckEpoch.current
      const current = () => !cancelled && epoch === authCheckEpoch.current
      // Suite cookies are authoritative; never prefer a previous user's module token.
      let token = coreOfficeUrl ? '' : storedAgileAuthToken()
      if (coreOfficeUrl) clearAgileAuthToken()
      try {
        let payload: Awaited<ReturnType<typeof readAgileSession>> | undefined
        if (token) {
          try {
            payload = await readAgileSession('/api/agile/auth/session', token)
          } catch (reason) {
            if (!current()) return
            if (!(reason instanceof SessionCheckError) || reason.status !== 401) throw reason
            clearAgileAuthToken()
            token = ''
          }
        }
        const usedStoredToken = Boolean(payload)
        if (!payload) {
          payload = await readAgileSession('/api/agile/auth/sso-session')
          token = coreOfficeUrl ? '' : payload.token
        }
        // A returning workspace must refresh its permissions before reopening.
        const recoveredWorkspace = refreshWorkspace.current ? await readAgileWorkspace(token) : undefined
        if (current()) {
          if (!coreOfficeUrl && !usedStoredToken) rememberAgileAuthToken(payload.token, payload.stayLoggedIn === true)
          if (recoveredWorkspace) setWorkspace(recoveredWorkspace)
          setWorkspaceReadError('')
          setAuth({ error: '', loading: false, submitting: false, token, user: payload.user })
        }
      } catch (reason) {
        if (!current()) return
        if (reason instanceof SessionCheckError) notifyCoreSessionRejected(reason.status)
        if (reason instanceof SessionCheckError && reason.status === 401) {
          clearAgileAuthToken()
          setAuth({ error: '', loading: false, submitting: false, token: '' })
        } else {
          setAuth(previous => ({ ...previous, loading: false, submitting: false,
            problem: reason instanceof SessionCheckError && reason.status === 403 ? 'access' : 'connection' }))
        }
      }
    }

    void bootstrapSession()
    return () => {
      cancelled = true
    }
  }, [sessionRetry])

  useEffect(() => {
    const epoch = ++sessionEpoch.current
    let cancelled = false
    setWorkspace(null)
    setAudit([])
    setPendingCommand(null)
    setWorkspaceError('')
    setWorkspaceReadError('')
    setDraft(emptyDraft('Project Management', 'Sprint 1'))
    setDecisionTitle('')
    setDecisionNotes('')
    setLegacyAuthorized(false)
    setHasLegacy(false)
    if (!auth.user) return
    try { setHasLegacy(Boolean(localStorage.getItem(storageKey))) } catch { /* Storage may be disabled. */ }
    async function refresh() {
      if (savingRef.current) return
      try {
        const identity = await readAgileSession('/api/agile/auth/session', auth.token)
        if (cancelled || epoch !== sessionEpoch.current) return
        if (identity.user.id !== auth.user?.id) {
          setAuth(current => ({ ...current, user: identity.user }))
          return
        }
        const payload = await readAgileWorkspace(auth.token)
        if (!cancelled && epoch === sessionEpoch.current && !savingRef.current) {
          setWorkspace(payload)
          setWorkspaceReadError('')
          setAuth(current => current.problem ? { ...current, problem: undefined } : current)
        }
      } catch (error) {
        if (cancelled || epoch !== sessionEpoch.current) return
        if (error instanceof SessionCheckError) {
          notifyCoreSessionRejected(error.status)
          if (error.status === 401) {
            ++authCheckEpoch.current
            clearAgileAuthToken(); setAuth({ token: '', loading: false, submitting: false, error: '' })
          } else if (error.status === 403) {
            setAuth(current => ({ ...current, problem: 'access' }))
          }
        }
        setWorkspaceReadError(error instanceof Error ? error.message : 'Workspace unavailable.')
      }
    }
    void refresh()
    refreshWorkspace.current = () => { void refresh() }
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => { cancelled = true; refreshWorkspace.current = undefined; window.clearInterval(timer) }
  }, [auth.user?.id, auth.token])

  async function sendCommand(operation: WorkspaceOperation, retry?: WorkspaceCommand) {
    if (!workspace || !workspace.permissions.editWork || savingRef.current || (pendingCommand && !retry)) return false
    const command: WorkspaceCommand = retry ? { ...retry, revision: workspace.revision } : { requestId: crypto.randomUUID(), revision: workspace.revision, operation }
    const epoch = sessionEpoch.current
    savingRef.current = true; setSaving(true); setWorkspaceError(''); setPendingCommand(command)
    try {
      const response = await fetch(`${agileApiBase}/api/agile/workspace/commands`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        body: JSON.stringify(command),
      })
      const payload = await response.json() as WorkspaceSnapshot & { message?: string }
      if (epoch !== sessionEpoch.current) return false
      if (!response.ok) {
        if (response.status === 409) {
          const latestResponse = await fetch(`${agileApiBase}/api/agile/workspace`, { credentials: 'include', cache: 'no-store', headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : undefined })
          if (latestResponse.ok && epoch === sessionEpoch.current) setWorkspace(await latestResponse.json() as WorkspaceSnapshot)
        } else if (response.status >= 400 && response.status < 500) {
          setPendingCommand(null)
        }
        throw new Error(payload.message ?? 'The change was not saved.')
      }
      setWorkspace(payload); setPendingCommand(null)
      if (operation.type === 'create_item') { setDraft(emptyDraft(role, payload.state.activeSprint)); setTab('backlog') }
      if (operation.type === 'create_decision') { setDecisionTitle(''); setDecisionNotes(''); setTab('decisions') }
      return true
    } catch (error) {
      if (epoch === sessionEpoch.current) setWorkspaceError(error instanceof Error ? error.message : 'Save failed. Retry the pending change.')
      return false
    } finally { savingRef.current = false; setSaving(false) }
  }

  function downloadJson(value: unknown, filename: string) {
    const blob = new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a')
    link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function exportWorkspace() {
    try {
      const response = await fetch(`${agileApiBase}/api/agile/workspace/export`, { credentials: 'include', cache: 'no-store', headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : undefined })
      if (!response.ok) throw new Error('Export failed. Please try again.')
      downloadJson(await response.json(), `agile-workspace-${todayKey()}.json`)
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : 'Export failed.') }
  }

  async function recoverLegacy(importData: boolean) {
    if (!legacyAuthorized || !workspace?.permissions.importWorkspace) return
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) throw new Error('No legacy browser workspace was found.')
      // Keep the original bytes and original key; failed imports cannot destroy the only copy.
      downloadJson(raw, `agile-legacy-backup-${todayKey()}.json`)
      if (importData) await sendCommand({ type: 'import_workspace', state: JSON.parse(raw) as AgileState })
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : 'Recovery failed; the original browser copy remains intact.') }
  }

  async function importWorkspaceFile(file?: File) {
    if (!file || !workspace?.permissions.importWorkspace) return
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('The import exceeds 8 MB.')
      const payload = JSON.parse(await file.text()) as AgileState | { state: AgileState }
      await sendCommand({ type: 'import_workspace', state: 'state' in payload ? payload.state : payload })
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : 'Import failed. Your source file is unchanged.') }
  }

  async function loadAudit() {
    try {
      const response = await fetch(`${agileApiBase}/api/agile/workspace/audit`, { credentials: 'include', cache: 'no-store', headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : undefined })
      if (!response.ok) throw new Error('Could not load change history.')
      setAudit((await response.json() as { entries: WorkspaceAudit[] }).entries)
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : 'Could not load change history.') }
  }

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return state.items.filter((item) => {
      const matchesQuery =
        !normalizedQuery ||
        [item.title, item.type, item.area, item.owner, item.stakeholder, item.release, item.acceptance, item.dependsOn]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery)
      const matchesArea = areaFilter === 'All' || item.area === areaFilter
      const matchesStatus = statusFilter === 'All' || item.status === statusFilter
      return matchesQuery && matchesArea && matchesStatus
    })
  }, [areaFilter, query, state.items, statusFilter])

  const roleItems = useMemo(() => state.items.filter((item) => item.owner === role || item.area === roleToArea(role)), [role, state.items])
  const metrics = useMemo(() => portfolioMetrics(state.items), [state.items])
  const blockedItems = state.items.filter((item) => item.status === 'Blocked')
  const dueSoonItems = state.items
    .filter((item) => item.status !== 'Done')
    .sort((left, right) => left.due.localeCompare(right.due))
    .slice(0, 5)

  function saveItem(event: FormEvent) {
    event.preventDefault()
    const title = draft.title.trim()
    if (!title) return

    const item: WorkItem = {
      id: makeId(),
      title,
      type: draft.type,
      area: draft.area,
      status: 'Intake',
      owner: draft.owner,
      stakeholder: draft.stakeholder.trim() || roleLabel(draft.owner),
      priority: draft.priority,
      effort: clampNumber(Number(draft.effort), 1, 40),
      businessValue: clampNumber(Number(draft.businessValue), 1, 10),
      risk: clampNumber(Number(draft.risk), 1, 5),
      sprint: draft.sprint.trim() || state.activeSprint,
      release: draft.release.trim() || 'Unassigned',
      due: draft.due || todayKey(),
      dependsOn: draft.dependsOn.trim(),
      acceptance: draft.acceptance.trim() || 'Acceptance criteria pending.',
      updatedAt: new Date().toISOString(),
    }

    void sendCommand({ type: 'create_item', item })
  }

  function updateItem(id: string, patch: Partial<WorkItem>) {
    void sendCommand({ type: 'update_item', id, patch })
  }

  function moveItem(id: string, direction: -1 | 1) {
    const item = state.items.find((candidate) => candidate.id === id)
    if (!item) return
    const index = statuses.indexOf(item.status)
    const nextStatus = statuses[Math.min(statuses.length - 1, Math.max(0, index + direction))]
    updateItem(id, { status: nextStatus })
  }

  function saveDecision(event: FormEvent) {
    event.preventDefault()
    const title = decisionTitle.trim()
    if (!title) return

    const decision: Decision = {
      id: makeId(),
      title,
      owner: role,
      impact: roleToArea(role),
      status: 'Proposed',
      date: todayKey(),
      notes: decisionNotes.trim() || 'Decision context pending.',
    }
    void sendCommand({ type: 'create_decision', decision })
  }

  function updateDecision(id: string, status: Decision['status']) {
    void sendCommand({ type: 'update_decision', id, status })
  }

  function selectLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage)
    writeSuiteLanguage(nextLanguage, [languageStorageKey])
  }

  function selectTheme(nextTheme: Theme) {
    setTheme(nextTheme)
    writeSuiteTheme(nextTheme, [themeStorageKey])
  }

  async function login(email: string, password: string, stayLoggedIn: boolean) {
    ++authCheckEpoch.current
    setAuth((current) => ({ ...current, error: '', submitting: true }))
    try {
      const response = await fetch(`${agileApiBase}/api/agile/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, stayLoggedIn }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as { message?: string } | undefined
        throw new Error(payload?.message ?? copy.emailOrPasswordIncorrect)
      }
      const payload = (await response.json()) as { user: AuthUser; token: string }
      if (!coreOfficeUrl) rememberAgileAuthToken(payload.token, stayLoggedIn)
      setAuth({ error: '', loading: false, submitting: false, token: coreOfficeUrl ? '' : payload.token, user: payload.user })
    } catch (error) {
      setAuth((current) => ({
        ...current,
        error: error instanceof Error ? error.message : copy.signInFailed,
        loading: false,
        submitting: false,
      }))
    }
  }

  async function logout() {
    ++authCheckEpoch.current
    const token = auth.token
    try {
      const response = await fetch(`${agileApiBase}/api/agile/auth/logout`, {
        method: 'POST', credentials: 'include',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      })
      if (!response.ok) throw new Error('Sign-out could not be completed. Please try again.')
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Sign-out could not be completed. Please try again.')
      return
    }
    ++sessionEpoch.current
    setWorkspace(null); setPendingCommand(null); setAudit([]); setLegacyAuthorized(false)
    clearAgileAuthToken()
    setAuth({ error: '', loading: false, submitting: false, token: '' })
  }

  if (auth.loading) {
    return (
      <AgileCopyContext.Provider value={copy}>
        <AuthStatus message={copy.checkingSession} />
      </AgileCopyContext.Provider>
    )
  }

  if (auth.problem) {
    return <main className="auth-screen"><section className="auth-panel" aria-live="polite">
      <h1>{auth.problem === 'access'
        ? language === 'de' ? 'Zugriff konnte nicht bestätigt werden' : 'Access could not be verified'
        : language === 'de' ? 'Verbindung unterbrochen' : 'Connection interrupted'}</h1>
      <p>{auth.problem === 'access'
        ? language === 'de' ? 'Der Zugriff wurde abgelehnt. Prüfen Sie Ihre Verbindung oder wenden Sie sich an einen Administrator.' : 'Access was refused. Check your connection or contact an administrator.'
        : language === 'de' ? 'Ihre Anmeldung konnte nicht geprüft werden. Prüfen Sie die Verbindung und versuchen Sie es erneut.' : 'We could not check your sign-in. Check your connection and try again.'}</p>
      <button className="primary-action" type="button" onClick={() => {
        setAuth(current => ({ ...current, loading: true }))
        setSessionRetry(current => current + 1)
      }}>{language === 'de' ? 'Erneut versuchen' : 'Try again'}</button>
    </section></main>
  }

  if (!auth.user) {
    return (
      <AgileCopyContext.Provider value={copy}>
        <LoginView
          error={auth.error}
          language={language}
          loading={auth.submitting}
          theme={theme}
          onLanguage={selectLanguage}
          onLogin={login}
          onTheme={selectTheme}
        />
      </AgileCopyContext.Provider>
    )
  }

  const agileProductPath = agileBasePath ? `${agileBasePath}/` : '/'
  const suiteProducts: SuiteProductDefinition[] = [
    ...(coreOfficeUrl ? [{ id: 'core' as const, path: coreOfficeUrl || '/', label: 'Core' }] : []),
    ...(enabledSuiteModules.has('time') ? [{ id: 'time' as const, path: timeTrackingUrl, label: language === 'de' ? 'Zeit' : 'Time' }] : []),
    ...(enabledSuiteModules.has('inventory') ? [{ id: 'inventory' as const, path: inventorySystemUrl, label: language === 'de' ? 'Inventar' : 'Inventory' }] : []),
    ...(enabledSuiteModules.has('agile') ? [{ id: 'agile' as const, path: agileProductPath, label: 'Agile' }] : []),
  ]
  const agileNavigation: SuiteNavItem[] = tabs.map((item) => ({
    id: item.id,
    label: copy.tabs[item.id],
    icon: item.icon,
    active: tab === item.id,
    onSelect: () => setTab(item.id),
  }))

  return (
    <AgileCopyContext.Provider value={copy}>
    <main className="app-shell">
      <SuiteShellHeader
        currentProduct="agile"
        identityLine={`${auth.user.name} · ${state.releaseGoal}`}
        language={language}
        navigation={agileNavigation}
        navigationExtras={(
          <>
          <label className="role-lens-control">
            <span className="sr-only">{copy.roleLens}</span>
            <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {roles.map((item) => (
                <option key={item} value={item}>{copy.roles[item]}</option>
              ))}
            </select>
          </label>
          </>
        )}
        navigationLabel={copy.appName}
        onLanguageChange={selectLanguage}
        onLogout={() => void logout()}
        onThemeChange={selectTheme}
        productTitle={copy.appName}
        products={suiteProducts}
        theme={theme}
        workspaceOnly={isEmbeddedSuiteWorkspace}
      />

      <section className="workspace-sync" aria-label={language === 'de' ? 'Gemeinsamer Arbeitsbereich' : 'Shared workspace'}>
        <div className="workspace-sync-actions">
          <span role="status">{saving ? (language === 'de' ? 'Wird gespeichert…' : 'Saving…') : workspace ? `${language === 'de' ? 'Auf dem Server gespeichert · Version' : 'Saved on server · revision'} ${workspace.revision}` : (language === 'de' ? 'Arbeitsbereich wird geladen…' : 'Loading workspace…')}</span>
          <button disabled={!workspace || saving} type="button" onClick={() => void exportWorkspace()}>{language === 'de' ? 'Exportieren' : 'Export'}</button>
          <button disabled={!workspace} type="button" onClick={() => void loadAudit()}>{language === 'de' ? 'Änderungsverlauf' : 'Change history'}</button>
          {workspace?.permissions.importWorkspace && <label>{language === 'de' ? 'Datei importieren' : 'Import file'}<input aria-label={language === 'de' ? 'Arbeitsbereich importieren' : 'Import workspace'} accept="application/json,.json" disabled={saving || Boolean(pendingCommand)} type="file" onChange={event => { void importWorkspaceFile(event.target.files?.[0]); event.target.value = '' }} /></label>}
        </div>
        {workspace && !workspace.permissions.editWork && <p>{language === 'de' ? 'Dieser Arbeitsbereich ist schreibgeschützt.' : 'This workspace is read-only.'}</p>}
        {workspaceError && <p className="workspace-error" role="alert">{workspaceError}</p>}
        {workspaceReadError && <p className="workspace-error" role="alert">{workspaceReadError}</p>}
        {workspaceReadError && <button type="button" disabled={saving} onClick={() => refreshWorkspace.current?.()}>{language === 'de' ? 'Erneut versuchen' : 'Try again'}</button>}
        {pendingCommand && !saving && <div className="workspace-pending">
          <p>{language === 'de' ? 'Die Änderung bleibt erhalten. Prüfe den aktuellen Stand vor einem erneuten Versuch.' : 'Your pending change is retained. Review the latest state before retrying.'}</p>
          <button type="button" onClick={() => void sendCommand(pendingCommand.operation, pendingCommand)}>{language === 'de' ? 'Änderung erneut versuchen' : 'Retry pending change'}</button>
          <button type="button" onClick={() => { downloadJson(pendingCommand, `agile-pending-change-${todayKey()}.json`); setPendingCommand(null) }}>{language === 'de' ? 'Änderung exportieren und schließen' : 'Export pending change and close'}</button>
        </div>}
        {hasLegacy && workspace?.permissions.importWorkspace && <details className="workspace-recovery">
          <summary>{language === 'de' ? 'Alten Browser-Arbeitsbereich wiederherstellen' : 'Recover an older browser workspace'}</summary>
          <p>{language === 'de' ? 'Dieser Browser enthält einen alten Arbeitsbereich ohne Kontozuordnung. Er wird nicht automatisch geöffnet. Importierte Daten werden mit allen berechtigten Nutzern dieser Installation geteilt. Die Originalkopie bleibt erhalten; Konflikte werden nicht überschrieben.' : 'This browser contains an older workspace without an account owner. It is never opened automatically. Imported data will be shared with authorized users of this installation. The original copy is retained; conflicts are never overwritten.'}</p>
          <label><input checked={legacyAuthorized} onChange={event => setLegacyAuthorized(event.target.checked)} type="checkbox" />{language === 'de' ? 'Ich habe diesen Browser-Arbeitsbereich erstellt oder bin zur Wiederherstellung berechtigt.' : 'I created this browser workspace or am authorized to recover it.'}</label>
          <button disabled={!legacyAuthorized || saving || Boolean(pendingCommand)} type="button" onClick={() => void recoverLegacy(false)}>{language === 'de' ? 'Originalkopie exportieren' : 'Export original copy'}</button>
          <button disabled={!legacyAuthorized || saving || Boolean(pendingCommand)} type="button" onClick={() => void recoverLegacy(true)}>{language === 'de' ? 'Sichern und in gemeinsamen Arbeitsbereich importieren' : 'Back up and import into shared workspace'}</button>
        </details>}
        {audit.length > 0 && <details open className="workspace-audit"><summary>{language === 'de' ? 'Letzte Änderungen' : 'Recent changes'}</summary><ol>{audit.map(entry => <li key={entry.id}><time>{new Date(entry.createdAt).toLocaleString(language)}</time> · {entry.actorName} · {entry.action.replaceAll('_', ' ')} · v{entry.revision}</li>)}</ol></details>}
      </section>

      <fieldset disabled={!workspace || !workspace.permissions.editWork || saving || Boolean(pendingCommand)} className={`workbench dco-suite-content workspace-fields ${tab === 'board' ? 'board-workbench' : ''}`}>
        <aside className="side-panel">
          <PanelTitle icon={<ListPlus size={18} />} title={copy.newItem} />
          <form className="item-form" onSubmit={saveItem}>
            <label>
              <span>{copy.fields.title}</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <div className="form-grid">
              <label>
                <span>{copy.fields.type}</span>
                <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as WorkType })}>
                  {workTypes.map((item) => (
                    <option key={item} value={item}>{copy.workTypes[item]}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.fields.area}</span>
                <select value={draft.area} onChange={(event) => setDraft({ ...draft, area: event.target.value as Area })}>
                  {areas.map((item) => (
                    <option key={item} value={item}>{copy.areas[item]}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.fields.owner}</span>
                <select value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value as Role })}>
                  {roles.map((item) => (
                    <option key={item} value={item}>{copy.roles[item]}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.fields.priority}</span>
                <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as Priority })}>
                  {priorities.map((item) => (
                    <option key={item} value={item}>{copy.priorities[item]}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.fields.effort}</span>
                <input min="1" type="number" value={draft.effort} onChange={(event) => setDraft({ ...draft, effort: event.target.value })} />
              </label>
              <label>
                <span>{copy.fields.value}</span>
                <input min="1" max="10" type="number" value={draft.businessValue} onChange={(event) => setDraft({ ...draft, businessValue: event.target.value })} />
              </label>
              <label>
                <span>{copy.fields.risk}</span>
                <input min="1" max="5" type="number" value={draft.risk} onChange={(event) => setDraft({ ...draft, risk: event.target.value })} />
              </label>
              <label>
                <span>{copy.fields.due}</span>
                <input type="date" value={draft.due} onChange={(event) => setDraft({ ...draft, due: event.target.value })} />
              </label>
            </div>
            <label>
              <span>{copy.fields.stakeholder}</span>
              <input value={draft.stakeholder} onChange={(event) => setDraft({ ...draft, stakeholder: event.target.value })} />
            </label>
            <div className="form-grid">
              <label>
                <span>{copy.fields.sprint}</span>
                <input value={draft.sprint} onChange={(event) => setDraft({ ...draft, sprint: event.target.value })} />
              </label>
              <label>
                <span>{copy.fields.release}</span>
                <input value={draft.release} onChange={(event) => setDraft({ ...draft, release: event.target.value })} />
              </label>
            </div>
            <label>
              <span>{copy.fields.dependency}</span>
              <input value={draft.dependsOn} onChange={(event) => setDraft({ ...draft, dependsOn: event.target.value })} />
            </label>
            <label>
              <span>{copy.fields.acceptance}</span>
              <textarea rows={3} value={draft.acceptance} onChange={(event) => setDraft({ ...draft, acceptance: event.target.value })} />
            </label>
            <button className="primary-action" type="submit">
              <Save size={18} />
              <span>{copy.saveItem}</span>
            </button>
          </form>
        </aside>

        <section className="main-panel">
          <Filters
            areaFilter={areaFilter}
            query={query}
            statusFilter={statusFilter}
            onArea={setAreaFilter}
            onQuery={setQuery}
            onStatus={setStatusFilter}
          />

          {tab === 'portfolio' && (
            <PortfolioView blockedItems={blockedItems} dueSoonItems={dueSoonItems} metrics={metrics} role={role} roleItems={roleItems} />
          )}
          {tab === 'backlog' && <BacklogView items={filteredItems} onMove={moveItem} onUpdate={updateItem} />}
          {tab === 'board' && <BoardView items={filteredItems} onMove={moveItem} onUpdate={updateItem} />}
          {tab === 'roadmap' && <RoadmapView items={filteredItems} />}
          {tab === 'stakeholders' && <StakeholdersView items={state.items} stakeholders={state.stakeholders} />}
          {tab === 'decisions' && (
            <DecisionsView
              canApprove={workspace?.permissions.approveDecisions === true}
              decisionNotes={decisionNotes}
              decisionTitle={decisionTitle}
              decisions={state.decisions}
              onDecisionNotes={setDecisionNotes}
              onDecisionTitle={setDecisionTitle}
              onSaveDecision={saveDecision}
              onUpdateDecision={updateDecision}
            />
          )}
        </section>
      </fieldset>
    </main>
    </AgileCopyContext.Provider>
  )
}

function ThemeToggle({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  const copy = useAgileCopy()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = theme === 'dark' ? copy.switchToLightMode : copy.switchToDarkMode

  return (
    <button aria-label={label} className="icon-button" title={label} type="button" onClick={() => onTheme(nextTheme)}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}

function AuthStatus({ message }: { message: string }) {
  const copy = useAgileCopy()
  return <SuiteLoadingScreen message={message} product="agile" title={copy.appName} />
}

function LoginView({
  error,
  language,
  loading,
  theme,
  onLanguage,
  onLogin,
  onTheme,
}: {
  error: string
  language: Language
  loading: boolean
  theme: Theme
  onLanguage: (language: Language) => void
  onLogin: (email: string, password: string, stayLoggedIn: boolean) => Promise<void>
  onTheme: (theme: Theme) => void
}) {
  const copy = useAgileCopy()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [stayLoggedIn, setStayLoggedIn] = useState(false)

  function submit(event: FormEvent) {
    event.preventDefault()
    void onLogin(email, password, stayLoggedIn)
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div className="brand auth-brand">
          <span className="brand-mark"><DigitalCoreOfficeLogo size={24} /></span>
          <div>
            <h1>{copy.appName}</h1>
            <p>{copy.signInSubtitle}</p>
          </div>
        </div>
        {coreOfficeUrl && (
          <a className="primary-action" href={coreOfficeUrl}>
            <LayoutGrid size={18} />
            <span>Digital Core Office SSO</span>
          </a>
        )}
        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>{copy.email}</span>
            <input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            <span>{copy.password}</span>
            <PasswordInput aria-label={copy.password} language={language} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <label className="login-stay-row">
            <input checked={stayLoggedIn} type="checkbox" onChange={(event) => setStayLoggedIn(event.target.checked)} />
            <span>{copy.stayLoggedIn}</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-action" disabled={loading || !email || !password} type="submit">
            <LogIn size={18} />
            <span>{loading ? copy.signingIn : copy.signIn}</span>
          </button>
          <a className="forgot-password-link" href={coreOfficeUrl || `${timeTrackingUrl}/?forgot=1${email ? `&email=${encodeURIComponent(email)}` : ''}`}>
            {copy.forgotPasswordReset}
          </a>
        </form>
        <div className="auth-preferences">
          <label>
            <span>{copy.language}</span>
            <select value={language} onChange={(event) => onLanguage(event.target.value as Language)}>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
          <ThemeToggle theme={theme} onTheme={onTheme} />
        </div>
      </section>
    </main>
  )
}

function Filters({
  areaFilter,
  query,
  statusFilter,
  onArea,
  onQuery,
  onStatus,
}: {
  areaFilter: Area | 'All'
  query: string
  statusFilter: WorkStatus | 'All'
  onArea: (area: Area | 'All') => void
  onQuery: (query: string) => void
  onStatus: (status: WorkStatus | 'All') => void
}) {
  const copy = useAgileCopy()

  return (
    <div className="filters">
      <label className="search-field">
        <Search size={18} />
        <input placeholder={copy.filters.searchPlaceholder} value={query} onChange={(event) => onQuery(event.target.value)} />
      </label>
      <label>
        <Filter size={16} />
        <select value={areaFilter} onChange={(event) => onArea(event.target.value as Area | 'All')}>
          <option value="All">{copy.filters.all}</option>
          {areas.map((area) => (
            <option key={area} value={area}>{copy.areas[area]}</option>
          ))}
        </select>
      </label>
      <label>
        <BadgeCheck size={16} />
        <select value={statusFilter} onChange={(event) => onStatus(event.target.value as WorkStatus | 'All')}>
          <option value="All">{copy.filters.all}</option>
          {statuses.map((status) => (
            <option key={status} value={status}>{copy.statuses[status]}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

function PortfolioView({
  blockedItems,
  dueSoonItems,
  metrics,
  role,
  roleItems,
}: {
  blockedItems: WorkItem[]
  dueSoonItems: WorkItem[]
  metrics: ReturnType<typeof portfolioMetrics>
  role: Role
  roleItems: WorkItem[]
}) {
  const copy = useAgileCopy()

  return (
    <div className="portfolio-grid">
      <Metric icon={<ClipboardList size={20} />} label={copy.portfolio.openWork} value={String(metrics.open)} detail={`${metrics.done} ${copy.portfolio.done}`} />
      <Metric icon={<AlertTriangle size={20} />} label={copy.portfolio.blocked} value={String(metrics.blocked)} detail={`${metrics.highRisk} ${copy.portfolio.highRisk}`} tone={metrics.blocked > 0 ? 'warning' : 'normal'} />
      <Metric icon={<Flag size={20} />} label={copy.portfolio.businessValue} value={String(metrics.value)} detail={`${metrics.effort} ${copy.portfolio.effort}`} />
      <Metric icon={<Users size={20} />} label={copy.roles[role]} value={String(roleItems.length)} detail={copy.portfolio.ownedOrAdjacent} />

      <section className="panel two-column">
        <PanelTitle icon={<AlertTriangle size={18} />} title={copy.portfolio.blockedWork} />
        <div className="compact-list">
          {blockedItems.length === 0 && <p className="muted">{copy.portfolio.noBlockedWork}</p>}
          {blockedItems.map((item) => (
            <CompactItem item={item} key={item.id} />
          ))}
        </div>
      </section>

      <section className="panel two-column">
        <PanelTitle icon={<CalendarDays size={18} />} title={copy.portfolio.upcomingDueDates} />
        <div className="compact-list">
          {dueSoonItems.map((item) => (
            <CompactItem item={item} key={item.id} />
          ))}
        </div>
      </section>
    </div>
  )
}

function BacklogView({
  items,
  onMove,
  onUpdate,
}: {
  items: WorkItem[]
  onMove: (id: string, direction: -1 | 1) => void
  onUpdate: (id: string, patch: Partial<WorkItem>) => void
}) {
  const copy = useAgileCopy()

  return (
    <section className="panel">
      <PanelTitle icon={<ClipboardList size={18} />} title={copy.backlog.title} />
      <div className="table-wrap">
        <table className="dco-responsive-table">
          <thead>
            <tr>
              <th>{copy.backlog.work}</th>
              <th>{copy.backlog.area}</th>
              <th>{copy.backlog.status}</th>
              <th>{copy.backlog.owner}</th>
              <th>{copy.backlog.value}</th>
              <th>{copy.backlog.risk}</th>
              <th>{copy.backlog.due}</th>
              <th>{copy.backlog.flow}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td data-label={copy.backlog.work}>
                  <strong>{item.title}</strong>
                  <small>{copy.workTypes[item.type]} · {item.release}</small>
                </td>
                <td data-label={copy.backlog.area}><AreaPill area={item.area} /></td>
                <td data-label={copy.backlog.status}>
                  <StatusSelect item={item} onUpdate={onUpdate} />
                </td>
                <td data-label={copy.backlog.owner}>{copy.roles[item.owner]}</td>
                <td data-label={copy.backlog.value}>{item.businessValue}</td>
                <td data-label={copy.backlog.risk}>{item.risk}</td>
                <td data-label={copy.backlog.due}>{formatShortDate(item.due)}</td>
                <td data-label={copy.backlog.flow}>
                  <FlowButtons item={item} onMove={onMove} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function BoardView({
  items,
  onMove,
  onUpdate,
}: {
  items: WorkItem[]
  onMove: (id: string, direction: -1 | 1) => void
  onUpdate: (id: string, patch: Partial<WorkItem>) => void
}) {
  const copy = useAgileCopy()

  return (
    <div className="board">
      {statuses.map((status) => {
        const columnItems = items.filter((item) => item.status === status)
        return (
          <section className="board-column" key={status}>
            <header>
              <h2>{copy.statuses[status]}</h2>
              <span>{columnItems.length}</span>
            </header>
            <div className="card-stack">
              {columnItems.map((item) => (
                <WorkCard item={item} key={item.id} onMove={onMove} onUpdate={onUpdate} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function RoadmapView({ items }: { items: WorkItem[] }) {
  const copy = useAgileCopy()
  const releases = groupBy(items, (item) => item.release || 'Unassigned')
  return (
    <section className="panel">
      <PanelTitle icon={<Map size={18} />} title={copy.roadmap.title} />
      <div className="roadmap">
        {Object.entries(releases).map(([release, releaseItems]) => {
          const done = releaseItems.filter((item) => item.status === 'Done').length
          const percent = Math.round((done / Math.max(releaseItems.length, 1)) * 100)
          return (
            <article className="release-lane" key={release}>
              <div className="release-head">
                <h2>{release}</h2>
                <span>{percent}%</span>
              </div>
              <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
              <div className="compact-list">
                {releaseItems
                  .slice()
                  .sort((left, right) => left.due.localeCompare(right.due))
                  .map((item) => (
                    <CompactItem item={item} key={item.id} />
                  ))}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function StakeholdersView({ items, stakeholders }: { items: WorkItem[]; stakeholders: Stakeholder[] }) {
  const copy = useAgileCopy()

  return (
    <section className="panel">
      <PanelTitle icon={<Users size={18} />} title={copy.stakeholders.title} />
      <div className="stakeholder-grid">
        {stakeholders.map((stakeholder) => {
          const owned = items.filter((item) => item.owner === stakeholder.role || item.stakeholder === stakeholder.name)
          const blocked = owned.filter((item) => item.status === 'Blocked').length
          return (
            <article className="stakeholder-card" key={stakeholder.id}>
              <header>
                <RoleIcon role={stakeholder.role} />
                <div>
                  <h2>{stakeholder.name}</h2>
                  <p>{copy.roles[stakeholder.role]}</p>
                </div>
              </header>
              <dl>
                <div><dt>{copy.stakeholders.open}</dt><dd>{owned.filter((item) => item.status !== 'Done').length}</dd></div>
                <div><dt>{copy.stakeholders.blocked}</dt><dd>{blocked}</dd></div>
                <div><dt>{copy.stakeholders.requests}</dt><dd>{stakeholder.openRequests}</dd></div>
              </dl>
              <p>{stakeholder.focus}</p>
              <small>{stakeholder.cadence}</small>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function DecisionsView({
  canApprove,
  decisionNotes,
  decisionTitle,
  decisions,
  onDecisionNotes,
  onDecisionTitle,
  onSaveDecision,
  onUpdateDecision,
}: {
  canApprove: boolean
  decisionNotes: string
  decisionTitle: string
  decisions: Decision[]
  onDecisionNotes: (value: string) => void
  onDecisionTitle: (value: string) => void
  onSaveDecision: (event: FormEvent) => void
  onUpdateDecision: (id: string, status: Decision['status']) => void
}) {
  const copy = useAgileCopy()

  return (
    <div className="decision-layout">
      <section className="panel">
        <PanelTitle icon={<ShieldCheck size={18} />} title={copy.decisions.log} />
        <div className="compact-list">
          {decisions.map((decision) => (
            <article className="decision-row" key={decision.id}>
              <div>
                <strong>{decision.title}</strong>
                <small>{copy.roles[decision.owner]} · {copy.areas[decision.impact]} · {formatShortDate(decision.date)}</small>
                <p>{decision.notes}</p>
              </div>
              <select disabled={!canApprove} title={!canApprove ? 'Administrator approval is required.' : undefined} value={decision.status} onChange={(event) => onUpdateDecision(decision.id, event.target.value as Decision['status'])}>
                {decisionStatuses.map((status) => (
                  <option key={status} value={status}>{copy.decisionStatuses[status]}</option>
                ))}
              </select>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <PanelTitle icon={<Save size={18} />} title={copy.decisions.capture} />
        <form className="item-form" onSubmit={onSaveDecision}>
          <label>
            <span>{copy.fields.decision}</span>
            <input value={decisionTitle} onChange={(event) => onDecisionTitle(event.target.value)} />
          </label>
          <label>
            <span>{copy.fields.notes}</span>
            <textarea rows={5} value={decisionNotes} onChange={(event) => onDecisionNotes(event.target.value)} />
          </label>
          <button className="primary-action" type="submit">
            <Save size={18} />
            <span>{copy.saveDecision}</span>
          </button>
        </form>
      </section>
    </div>
  )
}

function WorkCard({
  item,
  onMove,
  onUpdate,
}: {
  item: WorkItem
  onMove: (id: string, direction: -1 | 1) => void
  onUpdate: (id: string, patch: Partial<WorkItem>) => void
}) {
  const copy = useAgileCopy()

  return (
    <article className={`work-card priority-${item.priority.toLowerCase()}`}>
      <header>
        <AreaPill area={item.area} />
        <span className="priority">{copy.priorities[item.priority]}</span>
      </header>
      <h3>{item.title}</h3>
      <p>{item.acceptance}</p>
      <dl>
        <div><dt>{copy.workCard.owner}</dt><dd>{copy.roles[item.owner]}</dd></div>
        <div><dt>{copy.workCard.effort}</dt><dd>{item.effort}</dd></div>
        <div><dt>{copy.workCard.value}</dt><dd>{item.businessValue}</dd></div>
        <div><dt>{copy.workCard.risk}</dt><dd>{item.risk}</dd></div>
      </dl>
      {item.dependsOn && <div className="dependency"><AlertTriangle size={14} />{item.dependsOn}</div>}
      <footer>
        <StatusSelect item={item} onUpdate={onUpdate} />
        <FlowButtons item={item} onMove={onMove} />
      </footer>
    </article>
  )
}

function StatusSelect({ item, onUpdate }: { item: WorkItem; onUpdate: (id: string, patch: Partial<WorkItem>) => void }) {
  const copy = useAgileCopy()

  return (
    <select value={item.status} onChange={(event) => onUpdate(item.id, { status: event.target.value as WorkStatus })}>
      {statuses.map((status) => (
        <option key={status} value={status}>{copy.statuses[status]}</option>
      ))}
    </select>
  )
}

function FlowButtons({ item, onMove }: { item: WorkItem; onMove: (id: string, direction: -1 | 1) => void }) {
  const copy = useAgileCopy()

  return (
    <div className="flow-buttons">
      <button disabled={item.status === statuses[0]} title={copy.workCard.moveLeft} type="button" onClick={() => onMove(item.id, -1)}>
        <ArrowLeft size={16} />
      </button>
      <button disabled={item.status === statuses[statuses.length - 1]} title={copy.workCard.moveRight} type="button" onClick={() => onMove(item.id, 1)}>
        <ArrowRight size={16} />
      </button>
    </div>
  )
}

function CompactItem({ item }: { item: WorkItem }) {
  const copy = useAgileCopy()

  return (
    <article className="compact-item">
      <span className={`status-dot ${statusClass(item.status)}`} />
      <div>
        <strong>{item.title}</strong>
        <small>{copy.statuses[item.status]} · {copy.roles[item.owner]} · {formatShortDate(item.due)}</small>
      </div>
    </article>
  )
}

function Metric({
  detail,
  icon,
  label,
  tone = 'normal',
  value,
}: {
  detail: string
  icon: ReactNode
  label: string
  tone?: 'normal' | 'warning'
  value: string
}) {
  return (
    <article className={`metric ${tone}`}>
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  )
}

function AreaPill({ area }: { area: Area }) {
  const copy = useAgileCopy()

  return <span className={`area-pill area-${area.toLowerCase()}`}>{copy.areas[area]}</span>
}

function RoleIcon({ role }: { role: Role }) {
  const icon =
    role === 'Sales' ? <BriefcaseBusiness size={18} /> :
    role === 'Project Management' ? <Boxes size={18} /> :
    role === 'Software Development' ? <MonitorCog size={18} /> :
    <Factory size={18} />
  return <span className="role-icon">{icon}</span>
}

function portfolioMetrics(items: WorkItem[]) {
  return items.reduce(
    (metrics, item) => ({
      open: metrics.open + (item.status === 'Done' ? 0 : 1),
      done: metrics.done + (item.status === 'Done' ? 1 : 0),
      blocked: metrics.blocked + (item.status === 'Blocked' ? 1 : 0),
      highRisk: metrics.highRisk + (item.risk >= 4 ? 1 : 0),
      value: metrics.value + item.businessValue,
      effort: metrics.effort + item.effort,
    }),
    { blocked: 0, done: 0, effort: 0, highRisk: 0, open: 0, value: 0 },
  )
}

function roleToArea(role: Role): Area {
  if (role === 'Project Management') return 'Project'
  if (role === 'Software Development') return 'Software'
  if (role === 'Hardware Development') return 'Hardware'
  return 'Sales'
}

function roleLabel(role: Role) {
  if (role === 'Project Management') return 'Project Office'
  if (role === 'Software Development') return 'Software Team'
  if (role === 'Hardware Development') return 'Hardware Lab'
  return 'Sales Desk'
}

function emptyDraft(role: Role, sprint: string): DraftItem {
  return {
    title: '',
    type: 'Story',
    area: roleToArea(role),
    owner: role,
    stakeholder: roleLabel(role),
    priority: 'Medium',
    effort: '3',
    businessValue: '6',
    risk: '2',
    sprint,
    release: '2026.07 Pilot',
    due: todayKey(),
    dependsOn: '',
    acceptance: '',
  }
}

function makeId() {
  return `apm-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`
}

function todayKey() {
  return new Date().toISOString().slice(0, 10)
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function formatShortDate(value: string) {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const groupKey = key(item)
    groups[groupKey] = groups[groupKey] ?? []
    groups[groupKey].push(item)
    return groups
  }, {})
}

function statusClass(status: WorkStatus) {
  return status.toLowerCase().replace(/\s+/g, '-')
}

export default App
