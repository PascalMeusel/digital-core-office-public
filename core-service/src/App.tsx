import { PasswordInput } from '@digital-core-office/suite-ui'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Boxes, KanbanSquare, QrCode, RefreshCcw, ShieldCheck, Smartphone, Timer, Users } from 'lucide-react'
import QRCode from 'qrcode'
import {
  SuiteShellHeader,
  isDigitalCoreOfficeAndroidApp,
  readSuiteLanguage,
  readSuiteTheme,
  writeSuiteLanguage,
  writeSuiteTheme,
  type SuiteLanguage,
  type SuiteProductDefinition,
  type SuiteProductId,
  type SuiteTheme,
} from '@digital-core-office/suite-ui'
import '@digital-core-office/suite-ui/styles.css'
import UserDirectory from './UserDirectory'
import DeviceSignIn from './DeviceSignIn'

interface CoreUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'employee'
  active: boolean
  mustChangePassword: boolean
}

interface CoreModule {
  id: Exclude<SuiteProductId, 'core'>
  label: string
  labelDe: string
  path: string
  readOnly?: boolean
}

interface LicenseSummary {
  status: string
  valid: boolean
  activeUsers: number
  effectiveUserLimit: number
  freeUserLimit: number
  details?: { holderName?: string; validUntil?: string; plan?: string }
  message?: string
}

interface SessionPayload {
  user: CoreUser
  modules: CoreModule[]
  license?: LicenseSummary
}

type Screen = 'home' | 'login' | 'forgot' | 'reset' | 'change-password'

function productFromPath(pathname: string): SuiteProductId {
  const firstSegment = pathname.split('/').filter(Boolean)[0]
  return firstSegment === 'time' || firstSegment === 'inventory' || firstSegment === 'agile' ? firstSegment : 'core'
}

const moduleIcons = {
  time: Timer,
  inventory: Boxes,
  agile: KanbanSquare,
}

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    signal: options?.signal ?? (url === '/api/core/session' ? AbortSignal.timeout(10_000) : undefined),
    headers: options?.body ? { 'Content-Type': 'application/json', ...options.headers } : options?.headers,
  })
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new RequestError((payload as { message?: string } | undefined)?.message ?? 'Request failed.', response.status)
  }
  return payload as T
}

function clearLegacySessions() {
  for (const key of ['time-tracker-token', 'digital-core-office.agile-token', 'inventorySystem.sessionToken']) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key) } catch { /* Storage may be disabled. */ }
  }
}

function broadcastIdentityChange() {
  clearLegacySessions()
  try { localStorage.setItem('digital-core-office.identity-change', `${Date.now()}:${Math.random()}`) } catch { /* Storage may be disabled. */ }
}

export default function App() {
  const resetToken = new URLSearchParams(window.location.search).get('reset') ?? ''
  const [language, setLanguageState] = useState<SuiteLanguage>(() => readSuiteLanguage())
  const [theme, setThemeState] = useState<SuiteTheme>(() => readSuiteTheme())
  const [screen, setScreen] = useState<Screen>(resetToken ? 'reset' : 'login')
  const [session, setSession] = useState<SessionPayload | null>(null)
  const [modules, setModules] = useState<CoreModule[]>([])
  const [loading, setLoading] = useState(true)
  const [sessionUnavailable, setSessionUnavailable] = useState(false)
  const [sessionRetry, setSessionRetry] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeProduct, setActiveProduct] = useState<SuiteProductId>(() => productFromPath(window.location.pathname))
  const identityEpoch = useRef(0)
  const workspaceFrame = useRef<HTMLIFrameElement>(null)

  const copy = language === 'de' ? {
    appName: 'Digital Core Office',
    identity: 'Ein Konto für alle aktivierten Systeme',
    home: 'Übersicht',
    welcome: 'Willkommen',
    choose: 'Wählen Sie ein System, um weiterzuarbeiten.',
    signIn: 'Anmelden',
    signingIn: 'Anmeldung läuft…',
    email: 'E-Mail',
    password: 'Passwort',
    stay: 'Angemeldet bleiben',
    forgot: 'Passwort vergessen?',
    resetTitle: 'Passwort zurücksetzen',
    requestReset: 'Link anfordern',
    resetSent: 'Wenn das Konto existiert, wurde ein Link zum Zurücksetzen gesendet.',
    newPassword: 'Neues Passwort',
    currentPassword: 'Aktuelles Passwort',
    confirmPassword: 'Passwort bestätigen',
    savePassword: 'Passwort speichern',
    passwordSaved: 'Das Passwort wurde gespeichert. Bitte melden Sie sich erneut an.',
    passwordRules: 'Das neue Passwort muss 14 bis 500 Zeichen lang sein.',
    back: 'Zurück zur Anmeldung',
    administrator: 'Administrator',
    employee: 'Mitarbeiter',
    license: 'Lizenz und Benutzer',
    activeUsers: 'Aktive Benutzer',
    status: 'Status',
    validUntil: 'Gültig bis',
    open: 'Öffnen',
    loading: 'Digital Core Office wird geladen…',
    connectionTitle: 'Verbindung unterbrochen',
    connectionHelp: 'Ihre Anmeldung konnte nicht geprüft werden. Prüfen Sie die Verbindung und versuchen Sie es erneut.',
    retry: 'Erneut versuchen',
  } : {
    appName: 'Digital Core Office',
    identity: 'One account for every enabled system',
    home: 'Overview',
    welcome: 'Welcome',
    choose: 'Choose a system to continue working.',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    email: 'Email',
    password: 'Password',
    stay: 'Stay signed in',
    forgot: 'Forgot password?',
    resetTitle: 'Reset password',
    requestReset: 'Request link',
    resetSent: 'If the account exists, a reset link has been sent.',
    newPassword: 'New password',
    currentPassword: 'Current password',
    confirmPassword: 'Confirm password',
    savePassword: 'Save password',
    passwordSaved: 'The password was saved. Please sign in again.',
    passwordRules: 'The new password must contain 14 to 500 characters.',
    back: 'Back to sign in',
    administrator: 'Administrator',
    employee: 'Employee',
    license: 'License and users',
    activeUsers: 'Active users',
    status: 'Status',
    validUntil: 'Valid until',
    open: 'Open',
    loading: 'Loading Digital Core Office…',
    connectionTitle: 'Connection interrupted',
    connectionHelp: 'We could not check your sign-in. Check your connection and try again.',
    retry: 'Try again',
  }

  const setTheme = useCallback((nextTheme: SuiteTheme) => {
    writeSuiteTheme(nextTheme)
    setThemeState(nextTheme)
  }, [])

  const setLanguage = useCallback((nextLanguage: SuiteLanguage) => {
    writeSuiteLanguage(nextLanguage)
    setLanguageState(nextLanguage)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.lang = language
  }, [language, theme])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      const epoch = ++identityEpoch.current
      try {
        if (resetToken) return
        const payload = await requestJson<SessionPayload>('/api/core/session')
        if (!cancelled && epoch === identityEpoch.current) {
          setSession(payload)
          setSessionUnavailable(false)
          setModules(payload.modules)
          setScreen(current => current === 'forgot' ? current : payload.user.mustChangePassword ? 'change-password' : 'home')
        }
      } catch (reason) {
        if (cancelled || epoch !== identityEpoch.current || resetToken) return
        if (reason instanceof RequestError && reason.status === 401) {
          clearLegacySessions()
          setSession(null)
          setSessionUnavailable(false)
          setScreen(current => current === 'forgot' ? current : 'login')
          // The public catalog is optional; its availability must not decide whether someone is signed in.
          void requestJson<{ modules: CoreModule[] }>('/api/core/modules').then(payload => {
            if (!cancelled && epoch === identityEpoch.current) setModules(payload.modules)
          }).catch(() => {})
        } else {
          setSessionUnavailable(true)
        }
      } finally {
        if (!cancelled && epoch === identityEpoch.current) setLoading(false)
      }
    }
    void boot()
    return () => { cancelled = true }
  }, [resetToken, sessionRetry])

  useEffect(() => {
    const syncProductFromHistory = () => setActiveProduct(productFromPath(window.location.pathname))
    window.addEventListener('popstate', syncProductFromHistory)
    return () => window.removeEventListener('popstate', syncProductFromHistory)
  }, [])

  useEffect(() => {
    async function revalidate() {
      if (resetToken) return
      const epoch = ++identityEpoch.current
      try {
        const payload = await requestJson<SessionPayload>('/api/core/session')
        if (epoch !== identityEpoch.current) return
        setSession(payload); setModules(payload.modules)
        setSessionUnavailable(false)
        setScreen(current => current === 'forgot' ? current : payload.user.mustChangePassword ? 'change-password' : 'home')
      } catch (reason) {
        if (epoch !== identityEpoch.current) return
        if (reason instanceof RequestError && reason.status === 401) {
          clearLegacySessions(); setSession(null)
          setSessionUnavailable(false)
          // Returning from a password manager or another window must keep the reset form and its input.
          setScreen(current => current === 'forgot' ? current : 'login')
        } else {
          setSessionUnavailable(true)
        }
      } finally {
        if (epoch === identityEpoch.current) setLoading(false)
      }
    }
    const storageChanged = (event: StorageEvent) => { if (event.key === 'digital-core-office.identity-change') void revalidate() }
    const workspaceSessionChanged = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== workspaceFrame.current?.contentWindow) return
      if (event.data?.type === 'dco:session-invalidated') void revalidate()
    }
    // An explicit sign-in/out in another tab changes identity; merely focusing this page does not.
    window.addEventListener('storage', storageChanged)
    window.addEventListener('message', workspaceSessionChanged)
    return () => {
      window.removeEventListener('storage', storageChanged)
      window.removeEventListener('message', workspaceSessionChanged)
    }
  }, [resetToken])

  useEffect(() => {
    if (!session || activeProduct === 'core') return
    if (session.modules.some((module) => module.id === activeProduct)) return
    window.history.replaceState(null, '', '/')
    setActiveProduct('core')
  }, [activeProduct, session])

  const suiteProducts = useMemo<SuiteProductDefinition[]>(() => [
    { id: 'core', path: '/', label: 'Core' },
    ...modules.map((module) => ({
      id: module.id,
      path: module.path,
      label: language === 'de' ? module.labelDe : module.label,
    })),
  ], [language, modules])

  const activeModule = activeProduct === 'core' ? undefined : session?.modules.find((module) => module.id === activeProduct)
  const displayedProduct: SuiteProductId = activeModule ? activeProduct : 'core'
  const productTitle = displayedProduct === 'time'
    ? 'Digital Core Office Time'
    : displayedProduct === 'inventory'
      ? language === 'de' ? 'Digital Core Office Inventar' : 'Digital Core Office Inventory'
      : displayedProduct === 'agile'
        ? 'Digital Core Office Agile'
        : copy.appName
  const workspaceSource = activeModule
    ? `${activeModule.path.replace(/\/+$/, '')}/index.html?embedded=1`
    : ''

  useEffect(() => {
    document.title = productTitle
  }, [productTitle])

  useEffect(() => {
    if (loading || !session || screen !== 'home' || activeModule) return
    const target = window.location.hash.slice(1)
    if (target === 'users' || target === 'license') document.getElementById(target)?.scrollIntoView({ block: 'start' })
  }, [loading, session, screen, activeModule])

  function openProduct(product: SuiteProductId, replace = false) {
    if (product !== 'core' && !modules.some((module) => module.id === product)) return
    const path = product === 'core'
      ? '/'
      : modules.find((module) => module.id === product)?.path ?? `/${product}/`
    window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
    setActiveProduct(product)
    setScreen('home')
    setError('')
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    ++identityEpoch.current
    setSubmitting(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const payload = await requestJson<SessionPayload>('/api/core/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
          stayLoggedIn: form.get('stayLoggedIn') === 'on',
        }),
      })
      ++identityEpoch.current
      broadcastIdentityChange()
      setSession(payload)
      setModules(payload.modules)
      setScreen(payload.user.mustChangePassword ? 'change-password' : 'home')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Sign in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const completeQrLogin = useCallback((payload: SessionPayload) => {
    ++identityEpoch.current
    broadcastIdentityChange()
    setSession(payload)
    setModules(payload.modules)
    setScreen(payload.user.mustChangePassword ? 'change-password' : 'home')
    setError('')
  }, [])

  async function logout() {
    ++identityEpoch.current
    setSubmitting(true)
    try {
      await requestJson<void>('/api/core/auth/logout', { method: 'POST', body: '{}' })
      ++identityEpoch.current
      broadcastIdentityChange()
      setSession(null); setScreen('login')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign out failed. Please try again.') }
    finally { setSubmitting(false) }
  }

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    const email = new FormData(event.currentTarget).get('email')
    try {
      await requestJson('/api/core/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) })
      setNotice(copy.resetSent)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Request failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function completeReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    if (password !== form.get('confirmation')) {
      setError(language === 'de' ? 'Die Passwörter stimmen nicht überein.' : 'Passwords do not match.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await requestJson('/api/core/auth/password-reset/complete', { method: 'POST', body: JSON.stringify({ token: resetToken, password }) })
      ++identityEpoch.current
      broadcastIdentityChange()
      window.history.replaceState(null, '', '/')
      setNotice(copy.passwordSaved)
      setScreen('login')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password reset failed.')
    } finally {
      setSubmitting(false)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    if (password !== form.get('confirmation')) {
      setError(language === 'de' ? 'Die Passwörter stimmen nicht überein.' : 'Passwords do not match.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await requestJson('/api/core/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.get('currentPassword'), password }),
      })
      ++identityEpoch.current
      broadcastIdentityChange()
      setSession(null)
      setNotice(copy.passwordSaved)
      setScreen('login')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password change failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const identity = !loading && !sessionUnavailable && session?.user
    ? `${session.user.name} · ${session.user.role === 'admin' ? copy.administrator : copy.employee}`
    : copy.identity

  return (
    <main data-native={isDigitalCoreOfficeAndroidApp() || undefined} className={`core-shell ${!sessionUnavailable && screen === 'home' && session && activeModule ? 'core-shell-workspace' : ''}`}>
      {!loading && !sessionUnavailable && screen === 'home' && session && !session.user.mustChangePassword && isDigitalCoreOfficeAndroidApp()
        ? <DeviceSignIn key={session.user.id} user={session.user} language={language} /> : null}
      <SuiteShellHeader
        currentProduct={session ? displayedProduct : 'core'}
        disabled={submitting || loading || sessionUnavailable}
        identityLine={identity}
        language={language}
        navigation={[]}
        navigationLabel={copy.home}
        onLanguageChange={setLanguage}
        onLogout={() => void logout()}
        onProductNavigate={(product, event) => {
          event.preventDefault()
          if (session && !loading && !sessionUnavailable) openProduct(product.id)
        }}
        onThemeChange={setTheme}
        productTitle={productTitle}
        products={suiteProducts}
        showLogout={!loading && !sessionUnavailable && Boolean(session?.user)}
        theme={theme}
      />

      <section className={`core-content dco-suite-content ${!sessionUnavailable && screen === 'home' && session && activeModule ? 'core-content-workspace' : ''}`}>
        {loading ? (
          <section className="core-panel core-auth-panel" aria-live="polite">
            <div className="core-loading-mark" />
            <strong>{copy.loading}</strong>
          </section>
        ) : sessionUnavailable ? (
          <section className="core-panel core-auth-panel" aria-live="polite">
            <h2>{copy.connectionTitle}</h2>
            <p>{copy.connectionHelp}</p>
            <button className="core-primary" type="button" onClick={() => {
              setLoading(true)
              setSessionUnavailable(false)
              setSessionRetry(current => current + 1)
            }}>{copy.retry}</button>
          </section>
        ) : screen === 'home' && session && activeModule ? (
          error && <p role="alert" className="core-banner core-banner-error">{error}</p>
        ) : screen === 'home' && session ? (
          <>
            <header className="core-page-heading">
              <div>
                <span className="core-eyebrow">Digital Core Office</span>
                <h2>{copy.welcome}, {session.user.name}</h2>
                <p>{copy.choose}</p>
              </div>
            </header>
            {notice && <p className="core-banner core-banner-success">{notice}</p>}
            {error && <p role="alert" className="core-banner core-banner-error">{error}</p>}
            <section className="core-module-grid" aria-label={copy.choose}>
              {session.modules.map((module) => {
                const Icon = moduleIcons[module.id]
                return (
                  <button className="core-module-card" data-module={module.id} key={module.id} type="button" onClick={() => openProduct(module.id)}>
                    <span className="core-module-icon"><Icon aria-hidden="true" size={22} /></span>
                    <span>
                      <strong>{language === 'de' ? module.labelDe : module.label}</strong>
                      <small>{language === 'de' ? module.label : module.labelDe}</small>
                      {module.readOnly && <small>{language === 'de' ? 'Nur Lesen und Exportieren' : 'View and export only'}</small>}
                    </span>
                    <span className="core-module-open">{copy.open}<ArrowUpRight aria-hidden="true" size={16} /></span>
                  </button>
                )
              })}
            </section>
            {session.user.role === 'admin' && session.license && (
              <section className="core-panel core-license-panel" id="license">
                <div className="core-panel-title">
                  <ShieldCheck aria-hidden="true" size={19} />
                  <h3>{copy.license}</h3>
                </div>
                <dl className="core-license-grid">
                  <div><dt>{copy.status}</dt><dd>{session.license.status}</dd></div>
                  <div><dt>{copy.activeUsers}</dt><dd><Users size={16} />{session.license.activeUsers} / {session.license.effectiveUserLimit === Number.MAX_SAFE_INTEGER ? (language === 'de' ? 'Unbegrenzt' : 'Unlimited') : session.license.effectiveUserLimit}</dd></div>
                  {session.license.details?.validUntil && <div><dt>{copy.validUntil}</dt><dd>{new Intl.DateTimeFormat(language).format(new Date(session.license.details.validUntil))}</dd></div>}
                </dl>
                {!session.license.valid && <p role="status">{language === 'de' ? 'Lizenz prüfen: Ihre Daten bleiben zum Lesen und Exportieren verfügbar.' : 'Your license needs attention. Your data remains available to view and export.'}</p>}
                <form className="core-form" onSubmit={async (event) => {
                  event.preventDefault(); setError('')
                  const licenseKey = new FormData(event.currentTarget).get('licenseKey')
                  try {
                    await requestJson('/api/core/license', { method: 'PUT', body: JSON.stringify({ licenseKey }) })
                    const payload = await requestJson<SessionPayload>('/api/core/session'); setSession(payload); setModules(payload.modules)
                    setNotice(language === 'de' ? 'Lizenz gespeichert.' : 'License saved.')
                  } catch (reason) { setError(reason instanceof Error ? reason.message : 'License could not be saved.') }
                }}>
                  <label>{language === 'de' ? 'Signierte Lizenz installieren' : 'Install signed license'}<textarea name="licenseKey" required rows={3} /></label>
                  <button className="core-primary" type="submit">{language === 'de' ? 'Lizenz speichern' : 'Save license'}</button>
                </form>
              </section>
            )}
            {session.user.role === 'admin' && <UserDirectory language={language} currentUserId={session.user.id} enabledModules={modules.map((module) => module.id)} />}
          </>
        ) : (
          <section className={`core-panel core-auth-panel${screen === 'login' ? ' core-auth-panel-login' : ''}`}>
            <span className="core-eyebrow">Digital Core Office</span>
            <h2>{screen === 'forgot' ? copy.forgot : screen === 'reset' ? copy.resetTitle : screen === 'change-password' ? copy.savePassword : copy.signIn}</h2>
            <p>{screen === 'login' ? copy.identity : copy.identity}</p>
            {notice && <p className="core-banner core-banner-success">{notice}</p>}
            {error && <p role="alert" className="core-banner core-banner-error">{error}</p>}

            {screen === 'login' && (
              <div className="core-login-grid">
                <form className="core-form" onSubmit={login}>
                  <label><span>{copy.email}</span><input autoComplete="username" name="email" required type="email" /></label>
                  <label><span>{copy.password}</span><PasswordInput aria-label={copy.password} language={language} autoComplete="current-password" name="password" required /></label>
                  <label className="core-check"><input name="stayLoggedIn" type="checkbox" /><span>{copy.stay}</span></label>
                  <button className="core-primary" disabled={submitting} type="submit">{submitting ? copy.signingIn : copy.signIn}</button>
                  <button className="core-link-button" type="button" onClick={() => { setError(''); setNotice(''); setScreen('forgot') }}>{copy.forgot}</button>
                </form>
                <CoreQrLogin language={language} onClaimed={completeQrLogin} />
              </div>
            )}
            {screen === 'forgot' && (
              <form className="core-form" onSubmit={requestReset}>
                <label><span>{copy.email}</span><input autoComplete="email" name="email" required type="email" /></label>
                <button className="core-primary" disabled={submitting} type="submit">{copy.requestReset}</button>
                <button className="core-link-button" type="button" onClick={() => setScreen('login')}>{copy.back}</button>
              </form>
            )}
            {screen === 'reset' && (
              <form className="core-form" onSubmit={completeReset}>
                <p id="core-password-rules">{copy.passwordRules}</p>
                <label><span>{copy.newPassword}</span><PasswordInput aria-label={copy.newPassword} language={language} aria-describedby="core-password-rules" autoComplete="new-password" minLength={14} maxLength={500} name="password" required /></label>
                <label><span>{copy.confirmPassword}</span><PasswordInput aria-label={copy.confirmPassword} language={language} aria-describedby="core-password-rules" autoComplete="new-password" minLength={14} maxLength={500} name="confirmation" required /></label>
                <button className="core-primary" disabled={submitting} type="submit">{copy.savePassword}</button>
              </form>
            )}
            {screen === 'change-password' && (
              <form className="core-form" onSubmit={changePassword}>
                <p id="core-password-rules">{copy.passwordRules}</p>
                <label><span>{copy.currentPassword}</span><PasswordInput aria-label={copy.currentPassword} language={language} autoComplete="current-password" name="currentPassword" required /></label>
                <label><span>{copy.newPassword}</span><PasswordInput aria-label={copy.newPassword} language={language} aria-describedby="core-password-rules" autoComplete="new-password" minLength={14} maxLength={500} name="password" required /></label>
                <label><span>{copy.confirmPassword}</span><PasswordInput aria-label={copy.confirmPassword} language={language} aria-describedby="core-password-rules" autoComplete="new-password" minLength={14} maxLength={500} name="confirmation" required /></label>
                <button className="core-primary" disabled={submitting} type="submit">{copy.savePassword}</button>
              </form>
            )}
          </section>
        )}
        {/* Keep unsent module drafts mounted during recovery, but hide and disable
            the workspace until Core verifies identity and module access again. */}
        {screen === 'home' && session && activeModule && <iframe
          ref={workspaceFrame}
          className="core-workspace-frame"
          key={`${session.user.id}:${activeModule.id}`}
          src={workspaceSource}
          hidden={loading || sessionUnavailable}
          inert={loading || sessionUnavailable}
          style={loading || sessionUnavailable ? { display: 'none' } : undefined}
          title={language === 'de' ? `${activeModule.labelDe} Arbeitsbereich` : `${activeModule.label} workspace`}
        />}
      </section>
    </main>
  )
}

function CoreQrLogin({ language, onClaimed }: { language: SuiteLanguage; onClaimed: (payload: SessionPayload) => void }) {
  const de = language === 'de'
  const [enabled, setEnabled] = useState(false)
  const [creating, setCreating] = useState(false)
  const [token, setToken] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [status, setStatus] = useState(de ? 'Warte auf Scan…' : 'Waiting for scan…')
  const [error, setError] = useState('')
  const creationEpoch = useRef(0)
  const creationRequest = useRef<AbortController | undefined>(undefined)

  const createChallenge = useCallback(async () => {
    const epoch = ++creationEpoch.current
    creationRequest.current?.abort()
    const controller = new AbortController()
    creationRequest.current = controller
    setEnabled(true)
    setCreating(true)
    setToken('')
    setExpiresAt('')
    setQrImage('')
    setError('')
    setStatus(de ? 'Warte auf Scan…' : 'Waiting for scan…')
    try {
      const payload = await requestJson<{ token: string; expiresAt: string }>('/api/core/auth/qr-login/challenges', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      })
      // Keep the payload identical to the existing Inventory desktop-login QR so
      // already-installed app builds can approve the new suite-wide challenge.
      const image = await QRCode.toDataURL(payload.token, { margin: 1, width: 260 })
      if (epoch !== creationEpoch.current) return
      setToken(payload.token)
      setExpiresAt(payload.expiresAt)
      setQrImage(image)
    } catch (requestError) {
      if (epoch !== creationEpoch.current) return
      setError(requestError instanceof Error ? requestError.message : de ? 'QR-Anmeldung konnte nicht gestartet werden.' : 'QR sign-in could not be started.')
    } finally {
      if (epoch === creationEpoch.current) {
        creationRequest.current = undefined
        setCreating(false)
      }
    }
  }, [de])

  useEffect(() => () => {
    ++creationEpoch.current
    creationRequest.current?.abort()
  }, [])

  function closeChallenge() {
    ++creationEpoch.current
    creationRequest.current?.abort()
    creationRequest.current = undefined
    setEnabled(false)
    setCreating(false)
    setToken('')
    setExpiresAt('')
    setQrImage('')
    setError('')
  }

  useEffect(() => {
    if (!enabled || !token) return undefined
    let stopped = false
    let finished = false
    let inFlight = false
    let lastAttemptAt = performance.now()
    let timer: number | undefined
    const controller = new AbortController()
    const interval = 5_000
    const epoch = creationEpoch.current
    const current = () => !stopped && creationEpoch.current === epoch

    function schedule() {
      if (timer !== undefined) window.clearTimeout(timer)
      if (!current() || finished || inFlight || document.hidden) return
      timer = window.setTimeout(poll, Math.max(0, interval - (performance.now() - lastAttemptAt)))
    }

    async function poll() {
      if (!current() || finished || inFlight || document.hidden) return
      inFlight = true
      lastAttemptAt = performance.now()
      try {
        const response = await fetch('/api/core/auth/qr-login/challenges/claim', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        })
        if (!current()) return
        if (response.status === 202) return
        const payload = await response.json().catch(() => undefined) as SessionPayload | { message?: string } | undefined
        if (!current()) return
        if (!response.ok) throw new Error(payload && 'message' in payload ? payload.message : undefined)
        finished = true
        setStatus(de ? 'Freigegeben – Anmeldung läuft…' : 'Approved — signing in…')
        onClaimed(payload as SessionPayload)
      } catch (requestError) {
        finished = true
        if (current()) setError(requestError instanceof Error ? requestError.message : de ? 'QR-Anmeldung fehlgeschlagen.' : 'QR sign-in failed.')
      } finally {
        inFlight = false
        // Measure the gap after completion as well: slow requests must not cause
        // overlapping requests or an immediate retry burst when a tab resumes.
        lastAttemptAt = performance.now()
        schedule()
      }
    }

    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [de, enabled, onClaimed, token])

  return (
    <section className="core-login-qr" aria-label={de ? 'Mit App anmelden' : 'Sign in with app'}>
      <div className="core-login-qr-heading">
        <span><QrCode aria-hidden="true" size={18} /></span>
        <div>
          <h3>{de ? 'Mit der App anmelden' : 'Sign in with the app'}</h3>
          <p>{enabled
            ? de ? 'Inventar-App öffnen, Scan wählen und diesen Code scannen.' : 'Open the Inventory app, choose Scan, and scan this code.'
            : de ? 'QR-Code anzeigen und mit der Inventar-App scannen.' : 'Show a QR code and scan it with the Inventory app.'}</p>
        </div>
      </div>
      <div className="core-login-qr-code">
        {enabled
          ? qrImage ? <img alt={de ? 'QR-Code für die Desktop-Anmeldung' : 'QR code for desktop sign-in'} src={qrImage} /> : <Smartphone aria-hidden="true" size={38} />
          : <div className="core-login-qr-start"><Smartphone aria-hidden="true" size={38} /><button className="core-primary" type="button" onClick={() => void createChallenge()}>{de ? 'QR-Code anzeigen' : 'Show QR code'}</button></div>}
      </div>
      {enabled && <div className="core-login-qr-footer">
        <small role={error ? 'alert' : 'status'}>{creating ? de ? 'QR-Code wird erstellt…' : 'Creating QR code…' : error || status}{expiresAt && !error ? ` · ${new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(expiresAt))}` : ''}</small>
        <button disabled={creating} aria-label={de ? 'QR-Code erneuern' : 'Refresh QR code'} title={de ? 'QR-Code erneuern' : 'Refresh QR code'} type="button" onClick={() => void createChallenge()}>
          <RefreshCcw aria-hidden="true" size={16} />
        </button>
      </div>}
      {enabled && <button className="core-link-button" type="button" onClick={closeChallenge}>{de ? 'QR-Code ausblenden' : 'Hide QR code'}</button>}
    </section>
  )
}
