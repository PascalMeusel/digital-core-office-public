import { useEffect, useRef, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
export { PasswordInput } from './PasswordInput'
import {
  Boxes,
  ArrowUpRight,
  KanbanSquare,
  Languages,
  LayoutGrid,
  LogOut,
  Moon,
  Settings,
  Sun,
  Timer,
  type LucideProps,
} from 'lucide-react'

export type SuiteProductId = 'core' | 'time' | 'inventory' | 'agile'
export type SuiteTheme = 'light' | 'dark'
export type SuiteLanguage = 'de' | 'en'
export type SuiteProductTone = 'default' | 'working' | 'on-break' | 'off-work'

export interface SuiteProductDefinition {
  id: SuiteProductId
  path: string
  label: string
}

export interface SuiteNavItem {
  id: string
  label: string
  active?: boolean
  icon?: ComponentType<LucideProps>
  onSelect: () => void
}

export interface SuiteShellProps {
  currentProduct: SuiteProductId
  productTitle: string
  identityLine: string
  products: SuiteProductDefinition[]
  navigation?: SuiteNavItem[]
  navigationLabel: string
  theme: SuiteTheme
  language: SuiteLanguage
  onThemeChange: (theme: SuiteTheme) => void
  onLanguageChange: (language: SuiteLanguage) => void
  onLogout: () => void
  onProductNavigate?: (product: SuiteProductDefinition, event: ReactMouseEvent<HTMLAnchorElement>) => void
  productTone?: SuiteProductTone
  navigationExtras?: ReactNode
  disabled?: boolean
  showSuiteControls?: boolean
  showLogout?: boolean
  workspaceOnly?: boolean
}

export interface SuiteLoadingScreenProps {
  product: SuiteProductId
  title: string
  message?: string
}

export const suiteThemeStorageKey = 'digital-core-office.theme'
export const suiteLanguageStorageKey = 'digital-core-office.language'

interface DigitalCoreOfficeAndroidBridge {
  postMessage: (message: string) => void
  onmessage?: ((event: MessageEvent<string>) => void) | null
}

function androidBridge(): DigitalCoreOfficeAndroidBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { DigitalCoreOfficeAndroid?: DigitalCoreOfficeAndroidBridge }).DigitalCoreOfficeAndroid
}

export function isDigitalCoreOfficeAndroidApp() {
  return Boolean(androidBridge())
}

export function requestDigitalCoreOfficeAndroid(action: 'scanQr' | 'changeServer') {
  const bridge = androidBridge()
  if (!bridge) return Promise.reject(new Error('Digital Core Office Android bridge is unavailable.'))
  const requestId = crypto.randomUUID()
  if (action === 'changeServer') {
    bridge.postMessage(JSON.stringify({ action, requestId }))
    return Promise.resolve('')
  }
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      bridge.onmessage = null
      reject(new Error('QR scan timed out.'))
    }, 120_000)
    bridge.onmessage = (event) => {
      try {
        const response = JSON.parse(String(event.data)) as { requestId?: string; value?: string; error?: string }
        if (response.requestId !== requestId) return
        window.clearTimeout(timeout)
        bridge.onmessage = null
        if (response.error) reject(new Error(response.error))
        else resolve(response.value ?? '')
      } catch {
        // Ignore unrelated bridge messages.
      }
    }
    bridge.postMessage(JSON.stringify({ action, requestId }))
  })
}

const productIcons: Record<SuiteProductId, ComponentType<LucideProps>> = {
  core: LayoutGrid,
  time: Timer,
  inventory: Boxes,
  agile: KanbanSquare,
}

export function readSuiteTheme(legacyKeys: string[] = []): SuiteTheme {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem(suiteThemeStorageKey)
  if (stored === 'light' || stored === 'dark') return stored
  for (const key of legacyKeys) {
    const legacy = window.localStorage.getItem(key)
    if (legacy === 'light' || legacy === 'dark') {
      window.localStorage.setItem(suiteThemeStorageKey, legacy)
      return legacy
    }
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function writeSuiteTheme(theme: SuiteTheme, legacyKeys: string[] = []) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(suiteThemeStorageKey, theme)
  for (const key of legacyKeys) window.localStorage.setItem(key, theme)
}

export function readSuiteLanguage(legacyKeys: string[] = []): SuiteLanguage {
  if (typeof window === 'undefined') return 'de'
  const stored = window.localStorage.getItem(suiteLanguageStorageKey)
  if (stored === 'de' || stored === 'en') return stored
  for (const key of legacyKeys) {
    const legacy = window.localStorage.getItem(key)
    if (legacy === 'de' || legacy === 'en') {
      window.localStorage.setItem(suiteLanguageStorageKey, legacy)
      return legacy
    }
  }
  return window.navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en'
}

export function writeSuiteLanguage(language: SuiteLanguage, legacyKeys: string[] = []) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(suiteLanguageStorageKey, language)
  for (const key of legacyKeys) window.localStorage.setItem(key, language)
}

export function SuiteShellHeader({
  currentProduct,
  productTitle,
  identityLine,
  products,
  navigation = [],
  navigationLabel,
  theme,
  language,
  onThemeChange,
  onLanguageChange,
  onLogout,
  onProductNavigate,
  productTone = 'default',
  navigationExtras,
  disabled = false,
  showSuiteControls = true,
  showLogout = true,
  workspaceOnly = false,
}: SuiteShellProps) {
  const ProductIcon = productIcons[currentProduct]
  const header = useRef<HTMLElement>(null)
  const activeNavigation = navigation.find((item) => item.active)?.id
  useEffect(() => {
    header.current?.querySelectorAll<HTMLElement>('nav [aria-current="page"]').forEach((item) => {
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [currentProduct, activeNavigation])
  const localNavigation = (navigation.length > 0 || navigationExtras) ? (
    <div className="dco-local-navigation-cluster">
      {navigation.length > 0 && (
        <nav className="dco-local-navigation" aria-label={navigationLabel}>
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={item.active ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
                className={item.active ? 'active' : ''}
                key={item.id}
                onClick={item.onSelect}
                type="button"
              >
                {Icon && <Icon aria-hidden="true" size={17} />}
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      )}
      {navigationExtras}
    </div>
  ) : null

  if (workspaceOnly) {
    return (
      <header ref={header} className="dco-workspace-header" data-product={currentProduct}>
        {localNavigation}
      </header>
    )
  }

  return (
    <header ref={header} className="dco-suite-header" data-product={currentProduct} data-native={isDigitalCoreOfficeAndroidApp() || undefined}>
      <span className={`dco-product-mark dco-product-mark-${productTone}`} aria-label={productTitle} title={productTitle}>
        <ProductIcon aria-hidden="true" size={22} strokeWidth={2.15} />
      </span>
      <div className="dco-product-copy">
        <h1>{productTitle}</h1>
        <p title={identityLine}>{identityLine}</p>
      </div>

      {localNavigation}

      {showSuiteControls && showLogout && (
        <nav className="dco-system-switcher" aria-label={language === 'de' ? 'System wechseln' : 'Switch system'}>
          {products.map((product) => {
            const Icon = productIcons[product.id]
            const current = product.id === currentProduct
            return (
              <a
                aria-current={current ? 'page' : undefined}
                className={current ? 'active' : ''}
                href={product.path}
                key={product.id}
                onClick={(event) => onProductNavigate?.(product, event)}
                title={product.label}
              >
                <Icon aria-hidden="true" size={16} />
                <span>{product.label}</span>
              </a>
            )
          })}
        </nav>
      )}

      <div className="dco-header-actions">
      {showSuiteControls && (
        <button
          className="dco-header-action"
          title={theme === 'light' ? (language === 'de' ? 'Dunkles Design' : 'Dark theme') : (language === 'de' ? 'Helles Design' : 'Light theme')}
          type="button"
          onClick={() => onThemeChange(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? <Moon aria-hidden="true" size={18} /> : <Sun aria-hidden="true" size={18} />}
        </button>
      )}
      {showSuiteControls && !showLogout && isDigitalCoreOfficeAndroidApp() && (
        <button
          className="dco-header-action"
          title={language === 'de' ? 'Server wechseln' : 'Change server'}
          type="button"
          onClick={() => void requestDigitalCoreOfficeAndroid('changeServer')}
        >
          <Settings aria-hidden="true" size={18} />
        </button>
      )}
      {showSuiteControls && (
        <button
          className="dco-header-action"
          title={language === 'en' ? 'Deutsch' : 'English'}
          type="button"
          onClick={() => onLanguageChange(language === 'en' ? 'de' : 'en')}
        >
          <Languages aria-hidden="true" size={18} />
        </button>
      )}
      {showSuiteControls && showLogout && (
        <button
          className="dco-header-action"
          disabled={disabled}
          title={language === 'de' ? 'Abmelden' : 'Sign out'}
          type="button"
          onClick={onLogout}
        >
          <LogOut aria-hidden="true" size={18} />
        </button>
      )}
      </div>
    </header>
  )
}

/** A consistent route back to administration in the top-level suite. */
export function SuiteAdminLink({ title, description, label, href }: {
  title: string; description: string; label: string; href: string
}) {
  return <section className="dco-admin-link">
    <h2>{title}</h2>
    <p>{description}</p>
    <a href={href} target="_top">{label}<ArrowUpRight size={18} aria-hidden="true" /></a>
  </section>
}

export function SuiteLoadingScreen({ product, title, message }: SuiteLoadingScreenProps) {
  const ProductIcon = productIcons[product]
  return (
    <main className="dco-suite-loading" data-product={product} aria-label={title} aria-live="polite">
      <section className="dco-suite-loading-content">
        <span className="dco-suite-loading-mark">
          <ProductIcon aria-hidden="true" size={28} strokeWidth={2.15} />
        </span>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
        <span className="dco-suite-loading-progress" aria-hidden="true"><span /></span>
      </section>
    </main>
  )
}
