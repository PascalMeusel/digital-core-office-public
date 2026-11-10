import { InventoryNavigation } from './InventoryWorkspace.tsx'
import { SuiteAdminLink, PasswordInput } from '@digital-core-office/suite-ui'
import {
  ArrowLeft,
  BarChart3,
  Boxes,
  Check,
  ChevronRight,
  ClipboardList,
  Download,
  Edit3,
  FileJson,
  FolderOpen,
  ImageOff,
  KeyRound,
  LayoutGrid,
  LogIn,
  LogOut,
  MapPin,
  Moon,
  PackagePlus,
  QrCode,
  RefreshCcw,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  Shield,
  ShoppingCart,
  Sun,
  Timer,
  Trash2,
  Truck,
  Users,
  UserCheck,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import QRCode from 'qrcode'
import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MutableRefObject, ReactNode } from 'react'
import {
  SuiteLoadingScreen,
  SuiteShellHeader,
  isDigitalCoreOfficeAndroidApp,
  readSuiteLanguage,
  readSuiteTheme,
  suiteLanguageStorageKey,
  suiteThemeStorageKey,
  requestDigitalCoreOfficeAndroid,
  writeSuiteLanguage,
  writeSuiteTheme,
  type SuiteNavItem,
  type SuiteProductDefinition,
} from '@digital-core-office/suite-ui'
import '@digital-core-office/suite-ui/styles.css'
import {
  inventoryConditions,
  inventoryLocationKinds,
  inventoryRoles,
  inventoryStates,
  type InventoryActivity,
  type InventoryAssignment,
  type InventoryCondition,
  type InventoryItemDefinition,
  type InventoryItemTotals,
  type InventoryLocation,
  type InventoryLocationKind,
  type InventoryPermission,
  type InventoryProject,
  type InventoryRecord,
  type InventoryRole,
  type InventoryState,
  type InventoryStatePayload,
  type InventoryTag,
  type InventoryUser,
} from '../shared/inventory.ts'
import './InventorySystem.css'
import { GoodsReceivingPanel } from './GoodsReceivingPanel.tsx'
import { receivingDraftKey } from './receivingDraft.ts'
import {
  finishMobileServerSetup,
  mobileServerDisplayName,
  mobileServerSetupRequested,
  normalizeMobileServerUrl,
  readMobileServerUrl,
  requestMobileServerSetup,
  writeMobileServerUrl,
} from './mobileServer.ts'
import { QrWorkspace } from './QrWorkspace.tsx'
import { InventoryProjectsPanel } from './InventoryProjectsPanel.tsx'
import { CatalogProvider, CatalogManager, CatalogHistory, UnitSelect, EuroInput, ArticlePhoto, ProjectPicker } from './InventoryCatalog.tsx'
import { useCatalog } from './catalogContext.ts'
import { InventoryWorkflowProvider, WorkflowHome, WorkflowProducts, WorkflowProjects, WorkflowStock, WorkflowOrders, WorkflowRequests } from './InventoryWorkflows.tsx'
import { locationDescendantIds, locationLabel, locationPath } from '../shared/locations.ts'
import { InventoryClickUpProvider } from './InventoryClickUp.tsx'
import { inventorySearchScore } from '../shared/search.ts'

type InventoryTab = 'requests' | 'overview' | 'inventory' | 'projects' | 'products' | 'receiving' | 'orders' | 'catalog' | 'locations' | 'users' | 'activity' | 'qr' | 'exports'
type MutationResult = Promise<boolean>
type InventoryLanguage = 'en' | 'de'
type InventoryTheme = 'light' | 'dark'
type RecordGroupBy = 'none' | 'item' | 'category' | 'place' | 'state' | 'group'
type QrTargetType = 'record' | 'item' | 'category' | 'place'
type ScannerPhase = 'idle' | 'opening' | 'scanning' | 'processing' | 'success' | 'failure'

interface BrowserBarcode {
  rawValue: string
}

interface BrowserBarcodeDetector {
  detect(source: CanvasImageSource): Promise<BrowserBarcode[]>
}

interface BrowserBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BrowserBarcodeDetector
}

interface ActivityRange {
  from: string
  to: string
}

interface InventoryRouteState {
  tab: InventoryTab
  targetType?: QrTargetType | 'qr-login' | 'qr-label'
  targetId?: string
}

interface ApiError {
  message: string
}

const inventoryBasePath = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '')
const standaloneRouteBase = inventoryBasePath === '/' ? '' : inventoryBasePath
const isInventoryMobileBuild = import.meta.env.VITE_INVENTORY_APP === 'true'
const inventoryAndroidApkHref = `${import.meta.env.BASE_URL ?? '/'}downloads/inventory-system-android-arm64.apk`
const storedMobileServerUrl = isInventoryMobileBuild ? readMobileServerUrl() : ''
const configuredInventoryApiBase = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const inventoryApiBase = isInventoryMobileBuild
  ? storedMobileServerUrl || configuredInventoryApiBase
  : configuredInventoryApiBase ||
    (inventoryBasePath && inventoryBasePath !== '/' ? inventoryBasePath : import.meta.env.PROD ? '' : 'http://localhost:4187')
const languageStorageKey = 'inventorySystem.language'
const themeStorageKey = 'inventorySystem.theme'
const sessionTokenStorageKey = 'inventorySystem.sessionToken'
const timeTrackingUrl = (import.meta.env.VITE_TIME_URL ?? 'http://localhost:4177').replace(/\/+$/, '')
const agileProjectManagementUrl = (import.meta.env.VITE_AGILE_URL ?? 'http://localhost:4197').replace(/\/+$/, '')
const configuredCoreOfficeUrl = (import.meta.env.VITE_CORE_URL ?? '').trim()
const coreOfficeUrl = configuredCoreOfficeUrl ? configuredCoreOfficeUrl.replace(/\/+$/, '') || '/' : ''
const enabledSuiteModules = new Set(
  String(import.meta.env.VITE_ENABLED_MODULES ?? 'time,inventory,agile').split(',').map((value) => value.trim()),
)
const isEmbeddedSuiteWorkspace = new URLSearchParams(window.location.search).get('embedded') === '1' && window.self !== window.top
const newCategoryOptionValue = '__new_category__'
const emptyStringList: string[] = []
const mobileTabIds = new Set<InventoryTab>(['overview', 'inventory', 'qr'])
const inventoryProcurementStates = ['requested', 'approved', 'ordered', 'delivered'] as const
const physicalStockStates = new Set<InventoryState>(['in_stock', 'reserved', 'in_use', 'maintenance', 'damaged'])
const tagColorOptions = [
  { id: 'teal', value: '#0f766e' },
  { id: 'blue', value: '#2563eb' },
  { id: 'violet', value: '#7c3aed' },
  { id: 'pink', value: '#be185d' },
  { id: 'red', value: '#dc2626' },
  { id: 'orange', value: '#c2410c' },
  { id: 'amber', value: '#b45309' },
  { id: 'green', value: '#15803d' },
  { id: 'slate', value: '#475569' },
] as const

interface RoomPlanRegion {
  roomCode: string
  code: string
  x: number
  y: number
  width: number
  height: number
}

const roomPlanRegions: RoomPlanRegion[] = [
  { roomCode: '001', code: 'WD117', x: 1, y: 14.5, width: 9.4, height: 10.5 },
  { roomCode: '001', code: 'WD116', x: 1, y: 25, width: 9.4, height: 11.5 },
  { roomCode: '001', code: 'WD115', x: 1, y: 37, width: 9.4, height: 20.5 },
  { roomCode: '001', code: 'PR106', x: 0.7, y: 67.5, width: 8.2, height: 15 },
  { roomCode: '001', code: 'ST101', x: 31.8, y: 13.5, width: 10.3, height: 26 },
  { roomCode: '001', code: 'ST102', x: 43, y: 13.5, width: 10.3, height: 26 },
  { roomCode: '001', code: 'WD113', x: 76.3, y: 13.1, width: 12.1, height: 12.2 },
  { roomCode: '001', code: 'WD111', x: 74.2, y: 26.2, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO106', x: 81.8, y: 26.2, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WD109', x: 74.2, y: 33.8, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO105', x: 81.8, y: 33.8, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WD107', x: 74.2, y: 41.4, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO104', x: 81.8, y: 41.4, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WD105', x: 74.2, y: 49, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO103', x: 81.8, y: 49, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WD103', x: 74.2, y: 56.6, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO102', x: 81.8, y: 56.6, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WD101', x: 74.2, y: 64.2, width: 7.6, height: 7.6 },
  { roomCode: '001', code: 'PO101', x: 81.8, y: 64.2, width: 6.8, height: 7.6 },
  { roomCode: '001', code: 'WC106', x: 56, y: 71, width: 10.5, height: 11.8 },
  { roomCode: '001', code: 'PR107', x: 66.8, y: 73.5, width: 9.5, height: 9 },

  { roomCode: '002', code: 'MR106', x: 36.8, y: 10.5, width: 9.5, height: 6.8 },
  { roomCode: '002', code: 'MR105', x: 46.3, y: 10.5, width: 8.5, height: 6.8 },
  { roomCode: '002', code: 'MR107', x: 19.1, y: 31.8, width: 7.2, height: 5.5 },
  { roomCode: '002', code: 'MR108', x: 26.3, y: 31.8, width: 7.2, height: 5.5 },
  { roomCode: '002', code: 'MR109', x: 33.5, y: 31.8, width: 7.3, height: 5.5 },
  { roomCode: '002', code: 'PBC116-118', x: 9.8, y: 42.8, width: 8.5, height: 13.8 },
  { roomCode: '002', code: 'MC102', x: 18.4, y: 42.8, width: 7.1, height: 7.5 },
  { roomCode: '002', code: 'MR104', x: 40.4, y: 42.4, width: 9.2, height: 6.2 },
  { roomCode: '002', code: 'MR102', x: 76, y: 62.5, width: 9.4, height: 6.5 },
  { roomCode: '002', code: 'MR103', x: 85.4, y: 62.5, width: 9.4, height: 6.5 },
  { roomCode: '002', code: 'WC105', x: 9.8, y: 84.4, width: 5.8, height: 5.5 },
  { roomCode: '002', code: 'WC104', x: 15.6, y: 84.4, width: 5.8, height: 5.5 },
  { roomCode: '002', code: 'WC103', x: 21.4, y: 84.4, width: 5.8, height: 5.5 },
  { roomCode: '002', code: 'WC102', x: 27.2, y: 84.4, width: 5.8, height: 5.5 },
  { roomCode: '002', code: 'WC101', x: 33, y: 84.4, width: 5.8, height: 5.5 },
  { roomCode: '002', code: 'MR101', x: 42.6, y: 81.3, width: 7.7, height: 6.3 },
  { roomCode: '002', code: 'MC101', x: 50.3, y: 81.3, width: 12, height: 6.3 },

  { roomCode: '004', code: 'PR103', x: 0.3, y: 13.5, width: 8.7, height: 14.6 },
  { roomCode: '004', code: 'PR102', x: 0.3, y: 30.5, width: 8.7, height: 14.6 },
  { roomCode: '004', code: 'PR101', x: 0.3, y: 47.5, width: 8.7, height: 14.6 },
  { roomCode: '004', code: 'MR101', x: 0.3, y: 64.5, width: 8.7, height: 14.6 },
  { roomCode: '004', code: 'PR104', x: 22.6, y: 7.4, width: 9.8, height: 16.7 },
  { roomCode: '004', code: 'MR104', x: 19.5, y: 25.4, width: 6.5, height: 24.5 },
  { roomCode: '004', code: 'PB104-103', x: 26, y: 25.4, width: 6.5, height: 24.5 },
  { roomCode: '004', code: 'MR103', x: 19.5, y: 50.4, width: 6.5, height: 25 },
  { roomCode: '004', code: 'PB102-101', x: 26, y: 50.4, width: 6.5, height: 25 },
  { roomCode: '004', code: 'MR106', x: 33.3, y: 25.4, width: 12.4, height: 24.5 },
  { roomCode: '004', code: 'PB105-106', x: 33.3, y: 50.4, width: 6.2, height: 25 },
  { roomCode: '004', code: 'MR105', x: 39.5, y: 50.4, width: 6.2, height: 25 },
  { roomCode: '004', code: 'MR102', x: 27.2, y: 75.2, width: 11.2, height: 6.8 },
  { roomCode: '004', code: 'MR105-PBC', x: 59.2, y: 7.4, width: 17.2, height: 29.5 },
  { roomCode: '004', code: 'MR107', x: 47.5, y: 81.5, width: 15.5, height: 5.6 },
  { roomCode: '004', code: 'MR108', x: 63.8, y: 81.5, width: 15.5, height: 5.6 },
]

function inventoryAssetUrl(value: string | null | undefined) {
  if (value?.startsWith('/api/inventorySystem/items/')) return `${inventoryApiBase}${value}`
  if (!value || !value.startsWith('/inventory-media/')) return value ?? ''
  return `${standaloneRouteBase}${value}`
}

const inventoryTranslations = {
  en: {
    appName: 'Digital Core Office Inventory',
    loading: 'Loading inventory...',
    loadFailed: 'Inventory state could not be loaded.',
    changeFailed: 'Inventory change failed.',
    logoutFailed: 'Sign-out could not be confirmed. Your session may still be active; reconnect and try again.',
    exportFailed: 'Export failed.',
    login: {
      title: 'Sign in',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      failed: 'Sign-in failed.',
      scanQr: 'Scan PC login QR',
      downloadAndroidApp: 'Download Android app',
      stayLoggedIn: 'Stay logged in',
      forgotPasswordReset: 'Forgot your password? Reset it',
    },
    server: {
      title: 'Connect your Digital Core Office',
      description: 'Enter the address of the server where your organization hosts Digital Core Office.',
      address: 'Server address',
      placeholder: 'office.example.com',
      example: 'For example: office.example.com or https://office.example.com',
      privacy: 'The app stores only this address on your device. Your inventory and account stay on the selected server.',
      connect: 'Check and connect',
      checking: 'Checking server…',
      current: 'Connected server',
      change: 'Change server',
      cancel: 'Keep current server',
      invalid: 'Enter a valid server address without a query or password.',
      https: 'Remote servers must use HTTPS.',
      unavailable: 'No compatible Digital Core Office inventory service was found at this address.',
    },
    account: {
      changePasswordTitle: 'Change password',
      currentPassword: 'Current password',
      newPassword: 'New password',
      confirmPassword: 'Confirm password',
      submitPassword: 'Save password',
      passwordMismatch: 'Passwords do not match.',
      passwordChanged: 'Password changed.',
      mustChangePassword: 'Change your temporary password to continue.',
    },
    recordCount: (count: number) => `${count} stock ${count === 1 ? 'record' : 'records'}`,
    language: 'Language',
    switchToDarkMode: 'Switch to dark mode',
    switchToLightMode: 'Switch to light mode',
    switchSystems: 'Switch systems',
    timeTracking: 'Time',
    agileProjectManagement: 'Agile',
    openTimeTracking: 'Open Time Tracking',
    openAgileProjectManagement: 'Open Agile Project Management',
    user: 'User',
    refresh: 'Refresh',
    navigation: 'Inventory sections',
    metrics: {
      aria: 'Inventory metrics',
      itemScope: 'Values for this item',
      inStock: 'In stock',
      ordered: 'Ordered',
      requested: 'Requested',
      lowStock: 'Low stock',
      shortfall: 'Shortfall',
    },
    mobile: {
      status: 'Status',
      stock: 'Stock',
      scan: 'Scan',
      stockHealth: 'Stock status',
      needsAttention: 'Needs attention',
      recentActivity: 'Recent activity',
      pcLogin: 'Log in PC',
      pcLoginHint: 'Scan the QR shown on the web login screen.',
      inventoryScan: 'Scan inventory QR',
      inventoryScanHint: 'Open an item, category, or place QR.',
      noAttention: 'No urgent stock issues.',
      noRecentActivity: 'No recent activity.',
    },
    roles: {
      admin: 'Admin',
      buyer: 'Buyer',
      hardware_developer: 'Hardware developer',
      software_developer: 'Software developer',
      buyer_receiver: 'Purchasing & receiving',
      receiver: 'Receiver',
      stock_manager: 'Stock manager',
      viewer: 'Viewer',
    } satisfies Record<InventoryRole, string>,
    states: {
      requested: 'Requested',
      approved: 'Approved',
      ordered: 'Ordered',
      delivered: 'Delivered',
      in_stock: 'In stock',
      reserved: 'Reserved',
      in_use: 'In use',
      maintenance: 'Maintenance',
      damaged: 'Damaged',
      retired: 'Retired',
      cancelled: 'Cancelled',
    } satisfies Record<InventoryState, string>,
    conditions: {
      new: 'New',
      usable: 'Usable',
      needs_check: 'Needs check',
      damaged: 'Damaged',
      expired: 'Expired',
    } satisfies Record<InventoryCondition, string>,
    admin: {
      accountsDescription: 'Manage accounts, passwords and access to all systems in Digital Core Office.',
      accountsLink: 'Manage users in Core',
      ledger: 'Stock audit trail', event: 'Event', changes: 'Changes', details: 'Record details',
      events: { created: 'Created', changed: 'Changed', received: 'Received', corrected: 'Corrected', reversed: 'Reversed', legacy_import: 'Imported opening stock' },
    },
    tabs: {
      overview: 'My work',
      requests: 'Requests',
      inventory: 'Articles & stock',
      projects: 'Projects',
      products: 'Products',
      receiving: 'Receiving',
      orders: 'Orders',
      catalog: 'Catalog',
      locations: 'Places & floor plan',
      users: 'Users',
      activity: 'Activity',
      qr: 'QR',
      exports: 'Exports',
    } satisfies Record<InventoryTab, string>,
    panels: {
      openStockFlow: 'Open stock flow',
      lowStock: 'Low stock',
      catalogQuantities: 'Catalog quantities',
      stockRecords: 'Stock records',
      orders: 'Requested, ordered, and incoming',
      requestStock: 'Request or order stock',
      itemCatalog: 'Item and part catalog',
      places: 'Places',
      users: 'Users and roles',
      activity: 'Activity',
      qr: 'QR codes',
      exports: 'Exports',
      assignRecord: 'Assign item',
      tags: 'Tags',
      editRecord: 'Edit stock record',
      newRecord: 'New stock record',
      editItem: 'Edit item',
      newItem: 'New item',
      editPlace: 'Edit place',
      newPlace: 'New place',
      editUser: 'Edit user',
      newUser: 'New user',
    },
    workspace: {
      overviewEyebrow: 'Daily inventory workspace',
      overviewTitle: 'What needs attention now?',
      overviewIntro: 'Start with open procurement, low stock, or the latest stock changes instead of searching through tables.',
      procurement: 'Procurement',
      procurementHint: 'Review requests and move deliveries through the workflow.',
      catalog: 'Catalog',
      catalogHint: 'Find an item and see all of its stock positions.',
      places: 'Places',
      placesHint: 'Open a storage place and see exactly what is stored there.',
      openTasks: 'Open procurement tasks',
      recentStock: 'Recently updated stock',
      allClear: 'Nothing currently needs attention.',
      belowMinimumHint: 'These items are below their configured minimum stock.',
      showAll: 'Show all',
      procurementIntro: 'Work through requirements from request to warehouse receipt. Each stage only shows the decisions needed now.',
      newRequest: 'New request',
      hideForm: 'Hide form',
      requestQueue: 'Procurement queue',
      catalogIntro: 'Search the catalog, then open an item to see quantities, photos, and every storage position.',
      catalogCreateIntro: 'Create the catalog identity first. Stock quantities and storage places are recorded separately in inventory.',
      catalogEditIntro: 'Edit the catalog master data without mixing it with individual stock positions.',
      catalogStepBasics: '1. Item identity',
      catalogStepBasicsHint: 'Name and SKU identify the item throughout the inventory system.',
      catalogStepClassification: '2. Classification',
      catalogStepClassificationHint: 'Assign a category, unit, and optional tags.',
      catalogStepStockRules: '3. Stock rules',
      catalogStepStockRulesHint: 'Minimum and reorder quantities control low-stock warnings.',
      catalogTechnicalDetails: 'Technical details',
      catalogSearch: 'Search item, SKU, manufacturer, or part number',
      locationSearch: 'Search place or code',
      locationHierarchy: 'Structure',
      locationList: 'All places',
      allLocationKinds: 'All place types',
      allOccupancy: 'All occupancy',
      occupiedPlaces: 'With stock',
      emptyPlaces: 'Without stock',
      inactivePlaces: 'Inactive',
      rooms: 'Rooms',
      fixtures: 'Cabinets and shelves',
      containers: 'Boxes and compartments',
      stockPositions: 'Stock positions',
      childPlaces: 'sub-places',
      directPositions: 'direct',
      totalPositions: 'including sub-places',
      showRoomPlan: 'Show room plan',
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      noMatchingPlaces: 'No storage places match these filters.',
      itemDetails: 'Item stock',
      locationDetails: 'Place contents',
      positions: 'Stock positions',
      storagePlaces: 'Storage places',
      distinctItems: 'Different items',
      photos: 'Photos',
      totalQuantity: 'Total quantity',
      noItemStock: 'No stock records exist for this item yet.',
      noLocationStock: 'No active stock is stored at this place.',
      clickForDetails: 'Open details',
      currentStock: 'Current stock',
      minimumStock: 'Minimum stock',
      due: 'Due',
      editData: 'Edit master data',
      roomPlan: 'Room plan and labeling',
      placeList: 'All storage places',
      addStock: 'Add stock',
      addPlace: 'Add place',
      addUser: 'Add user',
      stockIntro: 'Search and manage stock positions. Open the entry flow only when you want to add or change stock.',
      stockCreateIntro: 'Create a stock position in a clear sequence: choose the item, then its place and quantity.',
      stockEditIntro: 'Edit this stock position without changing which catalog item it belongs to.',
      stockStepItem: '1. Catalog item',
      stockStepItemHint: 'Choose the item whose stock is being recorded. The item is locked when editing an existing position.',
      stockStepPlacement: '2. Stock and placement',
      stockStepPlacementHint: 'Choose the exact location, quantity, state, and condition.',
      selectedItem: 'Selected item',
      selectedPlace: 'Selected place',
      itemLocked: 'The catalog item is fixed for this stock position.',
      placesAdminIntro: 'Find storage places, inspect their contents, or create a clearly labeled new place.',
      usersIntro: 'Manage access, roles, and account status without mixing account creation into the user list.',
      formBasics: 'Basics',
      formBasicsHint: 'Choose what is being recorded, where it belongs, and in which quantity.',
      formIdentity: 'Identification',
      formIdentityHint: 'Optional identifiers make individual pieces and batches easier to find later.',
      formProcurement: 'Procurement details',
      formProcurementHint: 'Only fill these fields when the stock originated from a purchase or request.',
      formPosition: 'Physical position',
      formPositionHint: 'The parent is derived from the selected type, so impossible combinations cannot be saved.',
      locationType: 'Type of place',
      parentRoom: 'Room / area',
      parentFixture: 'Cabinet / shelf',
      roomHint: 'A room or area is the top level and has no parent.',
      fixtureHint: 'A cabinet or shelf must belong to a room or area.',
      containerHint: 'A box or compartment must belong to a cabinet or shelf.',
      createParentFirst: 'Create the required parent place first.',
      typeLockedHint: 'The type cannot be changed while this place has child locations.',
      formMapping: 'Plan mapping and media',
      formMappingHint: 'Advanced fields for room plans, photos, and automatic highlighting.',
      formAccess: 'Access',
      formAccessHint: 'Select the role and whether the account may currently sign in.',
      formSecurity: 'Security',
      formSecurityHint: 'Use a unique password with at least 14 characters. New users should change it after their first login.',
      optionalDetails: 'Optional details',
      requiredHint: 'Required fields are grouped first. Optional details can be added when they are available.',
    },
    details: {
      back: 'Back to inventory',
      backToCatalog: 'Back to catalog',
      backToLocations: 'Back to places',
      stock: 'Stock details',
      item: 'Item information',
      place: 'Storage location',
      photo: 'Item photo',
      noPhoto: 'No item photo available',
      available: 'Available',
      total: 'Total stock',
      assigned: 'Assigned',
      source: 'Source',
    },
    empty: {
      noLowStock: 'No items below minimum.',
      noCatalogItems: 'No catalog items yet.',
      noPlaces: 'No places yet.',
      noActivity: 'No activity yet.',
      noOpenRecords: 'No open records.',
      noStockRecords: 'No stock records yet.',
      noAssignments: 'No active assignments.',
      noTags: 'No tags yet.',
      needItemAndPlace: 'Create at least one catalog item and one place before adding stock records.',
    },
    filters: {
      searchPlaceholder: 'Search item, part number, place, project',
      state: 'State',
      allStates: 'All states',
      place: 'Place',
      allPlaces: 'All places',
      item: 'Item',
      allItems: 'All items',
      category: 'Category',
      allCategories: 'All categories',
      groupBy: 'Group by',
      noGrouping: 'No grouping',
      groupByItem: 'Item',
      groupByCategory: 'Category',
      groupByPlace: 'Place',
      groupByState: 'State',
      groupByGroup: 'Group',
    },
    table: {
      sku: 'SKU',
      label: 'Piece / batch',
      group: 'Group',
      item: 'Item',
      name: 'Name',
      category: 'Category',
      model: 'Model',
      minimum: 'Minimum',
      inStock: 'In stock',
      ordered: 'Ordered',
      requested: 'Requested',
      status: 'Status',
      quantity: 'Qty',
      state: 'State',
      place: 'Place',
      identity: 'Identity',
      owner: 'Owner',
      updated: 'Updated',
      records: 'Records',
      items: 'Items',
      places: 'Places',
      generated: 'Generated',
      holder: 'Holder',
      tags: 'Tags',
    },
    status: {
      low: 'Low',
      ok: 'OK',
      active: 'Active',
      inactive: 'Inactive',
      passwordChange: 'Password change required',
    },
    tagColors: {
      teal: 'Teal',
      blue: 'Blue',
      violet: 'Violet',
      pink: 'Pink',
      red: 'Red',
      orange: 'Orange',
      amber: 'Amber',
      green: 'Green',
      slate: 'Slate',
    },
    form: {
      skuOptional: 'SKU optional',
      name: 'Name',
      category: 'Category',
      newCategory: 'New category',
      selectCategory: 'Select category',
      unit: 'Unit',
      manufacturer: 'Manufacturer',
      model: 'Model',
      minimum: 'Minimum',
      reorderQuantity: 'Reorder qty',
      description: 'Description',
      active: 'Active',
      item: 'Item',
      selectItem: 'Select an item',
      searchItem: 'Search catalog items',
      place: 'Place',
      selectPlace: 'Select an exact place',
      quantity: 'Quantity',
      state: 'State',
      condition: 'Condition',
      assetTag: 'Asset tag',
      serial: 'Serial',
      lot: 'Lot',
      supplier: 'Supplier',
      orderReference: 'Order ref',
      unitCost: 'Unit cost',
      dueDate: 'Due date',
      notes: 'Notes',
      pieceName: 'Piece / batch name',
      groupName: 'Group',
      individualize: 'Create one record per piece',
      splitQuantity: 'Quantity to split',
      placeCodeOptional: 'Short code optional',
      roomArea: 'Room / area',
      shelfCabinet: 'Shelf / cabinet',
      boxCompartment: 'Box / compartment',
      locationKindRoom: 'Room / area',
      locationKindFixture: 'Cabinet / shelf',
      locationKindContainer: 'Box / compartment',
      selectRoom: 'Select room / area',
      selectFixture: 'Select cabinet / shelf',
      rowPosition: 'Row / position optional',
      email: 'Email',
      role: 'Role',
      password: 'Password',
      newPassword: 'New password',
      mustChangePassword: 'Require password change',
      tagName: 'Tag name',
      tagColor: 'Tag color',
      categoryTags: 'Category tags',
      recordTags: 'Device tags',
      assignee: 'Person',
      assignedAt: 'Assigned at',
      scanQr: 'Scan QR code',
      qrTarget: 'QR target',
      loginQr: 'Login QR',
      qrLoginWaiting: 'Waiting for app scan...',
      qrLoginApproved: 'Login approved.',
      scannerOpening: 'Opening camera...',
      scannerInstruction: 'Point the camera at the QR code.',
      scannerProcessing: 'Checking QR code...',
      scannerSuccess: 'QR code handled.',
      scannerUnsupported: 'QR scanning is not available here.',
      scannerCameraFailed: 'Camera could not be opened.',
      scannerNotInventory: 'QR code is not an inventory link.',
      scannerNoCode: 'No QR code found in that image.',
      scannerImageUnsupported: 'QR image scanning is not available here.',
      scannerImageFailed: 'QR image could not be scanned.',
      scannerOpened: 'Inventory QR opened.',
      from: 'From',
      to: 'To',
      qrImage: 'QR image',
      qrLink: 'QR link',
    },
    actions: {
      editItem: 'Edit item',
      editPlace: 'Edit place',
      editUser: 'Edit user',
      editRecord: 'Edit record',
      splitRecord: 'Split / move part',
      deleteRecord: 'Delete record',
      deleteItem: 'Delete item',
      deleteTag: 'Delete tag',
      saveRecord: 'Save record',
      createRecord: 'Create record',
      splitMove: 'Split / move',
      saveItem: 'Save item',
      createItem: 'Create item',
      savePlace: 'Save place',
      createPlace: 'Create place',
      saveUser: 'Save user',
      createUser: 'Create user',
      cancel: 'Cancel',
      exportCsv: 'Export CSV',
      exportJson: 'Export JSON',
      moveTo: 'Move to',
      logout: 'Log out',
      assign: 'Assign',
      returnItem: 'Return',
      createTag: 'Create tag',
      generateQr: 'Generate QR',
      openScannedQr: 'Open scanned QR',
      quickDay: 'Day',
      quickWeek: 'Week',
      quickMonth: 'Month',
    },
  },
  de: {
    appName: 'Digital Core Office Inventar',
    loading: 'Inventar wird geladen...',
    loadFailed: 'Inventar konnte nicht geladen werden.',
    changeFailed: 'Inventaränderung fehlgeschlagen.',
    logoutFailed: 'Die Abmeldung konnte nicht bestätigt werden. Ihre Sitzung kann noch aktiv sein; verbinden Sie sich erneut und versuchen Sie es noch einmal.',
    exportFailed: 'Export fehlgeschlagen.',
    login: {
      title: 'Anmelden',
      email: 'E-Mail',
      password: 'Passwort',
      submit: 'Anmelden',
      failed: 'Anmeldung fehlgeschlagen.',
      scanQr: 'PC-Login-QR scannen',
      downloadAndroidApp: 'Android-App herunterladen',
      stayLoggedIn: 'Eingeloggt bleiben',
      forgotPasswordReset: 'Passwort vergessen? Zurücksetzen',
    },
    server: {
      title: 'Digital Core Office verbinden',
      description: 'Gib die Adresse des Servers ein, auf dem deine Organisation Digital Core Office betreibt.',
      address: 'Serveradresse',
      placeholder: 'office.beispiel.de',
      example: 'Zum Beispiel: office.beispiel.de oder https://office.beispiel.de',
      privacy: 'Die App speichert nur diese Adresse auf deinem Gerät. Inventar und Konto bleiben auf dem gewählten Server.',
      connect: 'Prüfen und verbinden',
      checking: 'Server wird geprüft…',
      current: 'Verbundener Server',
      change: 'Server wechseln',
      cancel: 'Aktuellen Server behalten',
      invalid: 'Gib eine gültige Serveradresse ohne Abfrageparameter oder Passwort ein.',
      https: 'Externe Server müssen HTTPS verwenden.',
      unavailable: 'Unter dieser Adresse wurde kein kompatibler Digital-Core-Office-Inventardienst gefunden.',
    },
    account: {
      changePasswordTitle: 'Passwort ändern',
      currentPassword: 'Aktuelles Passwort',
      newPassword: 'Neues Passwort',
      confirmPassword: 'Passwort bestätigen',
      submitPassword: 'Passwort speichern',
      passwordMismatch: 'Passwörter stimmen nicht überein.',
      passwordChanged: 'Passwort geändert.',
      mustChangePassword: 'Ändere dein temporäres Passwort, um fortzufahren.',
    },
    recordCount: (count: number) => `${count} Bestandsbuchungen`,
    language: 'Sprache',
    switchToDarkMode: 'Dunkelmodus aktivieren',
    switchToLightMode: 'Hellmodus aktivieren',
    switchSystems: 'System wechseln',
    timeTracking: 'Zeit',
    agileProjectManagement: 'Agile',
    openTimeTracking: 'Zeiterfassung öffnen',
    openAgileProjectManagement: 'Agiles Projektmanagement öffnen',
    user: 'Nutzer',
    refresh: 'Aktualisieren',
    navigation: 'Inventarbereiche',
    metrics: {
      aria: 'Inventarkennzahlen',
      itemScope: 'Werte für diesen Artikel',
      inStock: 'Auf Lager',
      ordered: 'Bestellt',
      requested: 'Angefragt',
      lowStock: 'Unter Mindestbestand',
      shortfall: 'Fehlmenge',
    },
    mobile: {
      status: 'Status',
      stock: 'Bestand',
      scan: 'Scan',
      stockHealth: 'Bestandsstatus',
      needsAttention: 'Braucht Aufmerksamkeit',
      recentActivity: 'Letzte Aktivität',
      pcLogin: 'PC anmelden',
      pcLoginHint: 'Scanne den QR-Code auf der Web-Anmeldeseite.',
      inventoryScan: 'Inventar-QR scannen',
      inventoryScanHint: 'Öffnet Artikel-, Kategorie- oder Orts-QRs.',
      noAttention: 'Keine dringenden Bestandsthemen.',
      noRecentActivity: 'Keine aktuelle Aktivität.',
    },
    roles: {
      admin: 'Admin',
      buyer: 'Einkauf',
      hardware_developer: 'Hardwareentwicklung',
      software_developer: 'Softwareentwicklung',
      buyer_receiver: 'Einkauf & Wareneingang',
      receiver: 'Wareneingang',
      stock_manager: 'Bestandsverwaltung',
      viewer: 'Lesen',
    } satisfies Record<InventoryRole, string>,
    states: {
      requested: 'Angefragt',
      approved: 'Freigegeben',
      ordered: 'Bestellt',
      delivered: 'Geliefert',
      in_stock: 'Auf Lager',
      reserved: 'Reserviert',
      in_use: 'In Nutzung',
      maintenance: 'Prüfung / Wartung',
      damaged: 'Defekt',
      retired: 'Ausgemustert',
      cancelled: 'Storniert',
    } satisfies Record<InventoryState, string>,
    conditions: {
      new: 'Neu',
      usable: 'Nutzbar',
      needs_check: 'Zu prüfen',
      damaged: 'Defekt',
      expired: 'Abgelaufen',
    } satisfies Record<InventoryCondition, string>,
    admin: {
      accountsDescription: 'Konten, Passwörter und Zugriffsrechte für alle Systeme werden in Digital Core Office verwaltet.',
      accountsLink: 'Nutzer in Core verwalten',
      ledger: 'Bestandsjournal', event: 'Ereignis', changes: 'Änderungen', details: 'Buchungsdetails',
      events: { created: 'Erstellt', changed: 'Geändert', received: 'Eingegangen', corrected: 'Korrigiert', reversed: 'Storniert', legacy_import: 'Anfangsbestand importiert' },
    },
    tabs: {
      overview: 'Meine Arbeit',
      requests: 'Anfragen',
      inventory: 'Artikel & Bestand',
      projects: 'Projekte',
      products: 'Produkte',
      receiving: 'Wareneingang',
      orders: 'Bestellungen',
      catalog: 'Katalog',
      locations: 'Orte & Raumplan',
      users: 'Nutzer',
      activity: 'Aktivität',
      qr: 'QR',
      exports: 'Export',
    } satisfies Record<InventoryTab, string>,
    panels: {
      openStockFlow: 'Offene Beschaffung',
      lowStock: 'Unter Mindestbestand',
      catalogQuantities: 'Katalogmengen',
      stockRecords: 'Bestandsbuchungen',
      orders: 'Angefragt, bestellt und im Eingang',
      requestStock: 'Bestand anfragen oder bestellen',
      itemCatalog: 'Bauteil- und Artikelkatalog',
      places: 'Orte',
      users: 'Nutzer und Rollen',
      activity: 'Aktivität',
      qr: 'QR-Codes',
      exports: 'Export',
      assignRecord: 'Artikel ausgeben',
      tags: 'Tags',
      editRecord: 'Bestandsbuchung bearbeiten',
      newRecord: 'Neue Bestandsbuchung',
      editItem: 'Artikel bearbeiten',
      newItem: 'Neuer Artikel',
      editPlace: 'Ort bearbeiten',
      newPlace: 'Neuer Ort',
      editUser: 'Nutzer bearbeiten',
      newUser: 'Neuer Nutzer',
    },
    workspace: {
      overviewEyebrow: 'Täglicher Inventar-Arbeitsbereich',
      overviewTitle: 'Was braucht jetzt Aufmerksamkeit?',
      overviewIntro: 'Starte bei offenen Beschaffungen, niedrigen Beständen oder den neuesten Änderungen, statt Tabellen zu durchsuchen.',
      procurement: 'Beschaffung',
      procurementHint: 'Bedarf prüfen und Lieferungen Schritt für Schritt bis zum Lager führen.',
      catalog: 'Katalog',
      catalogHint: 'Artikel finden und alle zugehörigen Bestandspositionen sehen.',
      places: 'Orte',
      placesHint: 'Einen Lagerort öffnen und genau sehen, was dort liegt.',
      openTasks: 'Offene Beschaffungsaufgaben',
      recentStock: 'Zuletzt aktualisierte Bestände',
      allClear: 'Aktuell ist keine Aktion erforderlich.',
      belowMinimumHint: 'Diese Artikel liegen unter ihrem festgelegten Mindestbestand.',
      showAll: 'Alle anzeigen',
      procurementIntro: 'Bearbeite Bedarfe von der Anfrage bis zum Lagereingang. Jede Stufe zeigt nur die jetzt nötigen Entscheidungen.',
      newRequest: 'Neue Anfrage',
      hideForm: 'Formular schließen',
      requestQueue: 'Beschaffungswarteschlange',
      catalogIntro: 'Durchsuche den Katalog und öffne einen Artikel, um Mengen, Bilder und jeden Lagerort zu sehen.',
      catalogCreateIntro: 'Lege zuerst die Katalogidentität an. Mengen und Lagerorte werden anschließend getrennt im Bestand erfasst.',
      catalogEditIntro: 'Bearbeite die Katalog-Stammdaten, ohne sie mit einzelnen Bestandspositionen zu vermischen.',
      catalogStepBasics: '1. Artikelidentität',
      catalogStepBasicsHint: 'Name und SKU identifizieren den Artikel im gesamten Inventarsystem.',
      catalogStepClassification: '2. Einordnung',
      catalogStepClassificationHint: 'Ordne Kategorie, Einheit und optionale Tags zu.',
      catalogStepStockRules: '3. Bestandsregeln',
      catalogStepStockRulesHint: 'Mindest- und Nachbestellmenge steuern die Warnungen bei niedrigem Bestand.',
      catalogTechnicalDetails: 'Technische Angaben',
      catalogSearch: 'Artikel, SKU, Hersteller oder Teilenummer suchen',
      locationSearch: 'Ort oder Code suchen',
      locationHierarchy: 'Struktur',
      locationList: 'Alle Orte',
      allLocationKinds: 'Alle Ortstypen',
      allOccupancy: 'Alle Belegungen',
      occupiedPlaces: 'Mit Bestand',
      emptyPlaces: 'Ohne Bestand',
      inactivePlaces: 'Inaktiv',
      rooms: 'Räume',
      fixtures: 'Schränke und Regale',
      containers: 'Boxen und Fächer',
      stockPositions: 'Bestandspositionen',
      childPlaces: 'Unterorte',
      directPositions: 'direkt',
      totalPositions: 'inklusive Unterorte',
      showRoomPlan: 'Raumplan anzeigen',
      expandAll: 'Alle aufklappen',
      collapseAll: 'Alle zuklappen',
      noMatchingPlaces: 'Keine Lagerorte entsprechen diesen Filtern.',
      itemDetails: 'Artikelbestand',
      locationDetails: 'Inhalt des Lagerorts',
      positions: 'Bestandspositionen',
      storagePlaces: 'Lagerorte',
      distinctItems: 'Verschiedene Artikel',
      photos: 'Fotos',
      totalQuantity: 'Gesamtmenge',
      noItemStock: 'Für diesen Artikel gibt es noch keine Bestandsbuchungen.',
      noLocationStock: 'An diesem Ort ist kein aktiver Bestand eingelagert.',
      clickForDetails: 'Details öffnen',
      currentStock: 'Aktueller Bestand',
      minimumStock: 'Mindestbestand',
      due: 'Fällig',
      editData: 'Stammdaten bearbeiten',
      roomPlan: 'Raumplan und Beschriftung',
      placeList: 'Alle Lagerorte',
      addStock: 'Bestand hinzufügen',
      addPlace: 'Ort hinzufügen',
      addUser: 'Nutzer hinzufügen',
      stockIntro: 'Bestandspositionen suchen und verwalten. Die Erfassung öffnet sich nur, wenn Bestand hinzugefügt oder geändert werden soll.',
      stockCreateIntro: 'Lege eine Bestandsposition in klarer Reihenfolge an: zuerst den Artikel, danach Ort und Menge.',
      stockEditIntro: 'Bearbeite diese Bestandsposition, ohne ihre Zuordnung zum Katalogartikel zu verändern.',
      stockStepItem: '1. Katalogartikel',
      stockStepItemHint: 'Wähle den Artikel, dessen Bestand erfasst wird. Beim Bearbeiten einer bestehenden Position bleibt der Artikel gesperrt.',
      stockStepPlacement: '2. Bestand und Lagerort',
      stockStepPlacementHint: 'Wähle den genauen Lagerort, die Menge, den Status und den Zustand.',
      selectedItem: 'Gewählter Artikel',
      selectedPlace: 'Gewählter Lagerort',
      itemLocked: 'Der Katalogartikel ist für diese Bestandsposition fest zugeordnet.',
      placesAdminIntro: 'Lagerorte finden, ihren Inhalt prüfen oder einen eindeutig beschrifteten neuen Ort anlegen.',
      usersIntro: 'Zugänge, Rollen und Kontostatus verwalten, ohne die Nutzererfassung dauerhaft neben der Liste anzuzeigen.',
      formBasics: 'Grundangaben',
      formBasicsHint: 'Lege fest, was erfasst wird, wo es liegt und in welcher Menge.',
      formIdentity: 'Identifikation',
      formIdentityHint: 'Optionale Kennungen helfen später, einzelne Teile und Chargen wiederzufinden.',
      formProcurement: 'Beschaffungsdaten',
      formProcurementHint: 'Nur ausfüllen, wenn der Bestand aus einer Bestellung oder Anfrage stammt.',
      formPosition: 'Physische Position',
      formPositionHint: 'Der übergeordnete Ort folgt aus dem gewählten Typ. Unmögliche Kombinationen können nicht gespeichert werden.',
      locationType: 'Art des Ortes',
      parentRoom: 'Raum / Bereich',
      parentFixture: 'Schrank / Regal',
      roomHint: 'Ein Raum oder Bereich ist die oberste Ebene und hat keinen übergeordneten Ort.',
      fixtureHint: 'Ein Schrank oder Regal muss einem Raum oder Bereich zugeordnet sein.',
      containerHint: 'Eine Box oder ein Fach muss einem Schrank oder Regal zugeordnet sein.',
      createParentFirst: 'Lege zuerst den benötigten übergeordneten Ort an.',
      typeLockedHint: 'Der Typ kann nicht geändert werden, solange dieser Ort untergeordnete Orte enthält.',
      formMapping: 'Plan-Zuordnung und Medien',
      formMappingHint: 'Erweiterte Angaben für Raumpläne, Fotos und automatische Markierungen.',
      formAccess: 'Zugriff',
      formAccessHint: 'Lege Rolle und aktuellen Anmeldestatus des Kontos fest.',
      formSecurity: 'Sicherheit',
      formSecurityHint: 'Verwende ein einzigartiges Passwort mit mindestens 14 Zeichen. Neue Nutzer sollten es nach der ersten Anmeldung ändern.',
      optionalDetails: 'Optionale Details',
      requiredHint: 'Pflichtangaben stehen zuerst. Optionale Details können ergänzt werden, sobald sie vorliegen.',
    },
    details: {
      back: 'Zurück zum Bestand',
      backToCatalog: 'Zurück zum Katalog',
      backToLocations: 'Zurück zu den Orten',
      stock: 'Bestandsdetails',
      item: 'Artikelinformationen',
      place: 'Lagerort',
      photo: 'Artikelbild',
      noPhoto: 'Kein Artikelbild vorhanden',
      available: 'Verfügbar',
      total: 'Gesamtbestand',
      assigned: 'Ausgegeben',
      source: 'Quelle',
    },
    empty: {
      noLowStock: 'Keine Artikel unter Mindestbestand.',
      noCatalogItems: 'Noch keine Katalogartikel.',
      noPlaces: 'Noch keine Orte.',
      noActivity: 'Noch keine Aktivität.',
      noOpenRecords: 'Keine offenen Buchungen.',
      noStockRecords: 'Noch keine Bestandsbuchungen.',
      noAssignments: 'Keine aktiven Ausgaben.',
      noTags: 'Noch keine Tags.',
      needItemAndPlace: 'Lege mindestens einen Katalogartikel und einen Ort an, bevor du Bestand buchst.',
    },
    filters: {
      searchPlaceholder: 'Artikel, Teilenummer, Ort, Projekt suchen',
      state: 'Status',
      allStates: 'Alle Status',
      place: 'Ort',
      allPlaces: 'Alle Orte',
      item: 'Artikel',
      allItems: 'Alle Artikel',
      category: 'Kategorie',
      allCategories: 'Alle Kategorien',
      groupBy: 'Gruppieren nach',
      noGrouping: 'Keine Gruppierung',
      groupByItem: 'Artikel',
      groupByCategory: 'Kategorie',
      groupByPlace: 'Ort',
      groupByState: 'Status',
      groupByGroup: 'Gruppe',
    },
    table: {
      sku: 'SKU',
      label: 'Einzelteil / Los',
      group: 'Gruppe',
      item: 'Artikel',
      name: 'Name',
      category: 'Kategorie',
      model: 'Modell',
      minimum: 'Minimum',
      inStock: 'Auf Lager',
      ordered: 'Bestellt',
      requested: 'Angefragt',
      status: 'Status',
      quantity: 'Menge',
      state: 'Status',
      place: 'Ort',
      identity: 'Kennung',
      owner: 'Verantwortlich',
      updated: 'Aktualisiert',
      records: 'Buchungen',
      items: 'Artikel',
      places: 'Orte',
      generated: 'Erstellt',
      holder: 'Person',
      tags: 'Tags',
    },
    status: {
      low: 'Niedrig',
      ok: 'OK',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      passwordChange: 'Passwortwechsel erforderlich',
    },
    tagColors: {
      teal: 'Petrol',
      blue: 'Blau',
      violet: 'Violett',
      pink: 'Pink',
      red: 'Rot',
      orange: 'Orange',
      amber: 'Bernstein',
      green: 'Grün',
      slate: 'Schiefergrau',
    },
    form: {
      skuOptional: 'SKU optional',
      name: 'Name',
      category: 'Kategorie',
      newCategory: 'Neue Kategorie',
      selectCategory: 'Kategorie wählen',
      unit: 'Einheit',
      manufacturer: 'Hersteller',
      model: 'Modell',
      minimum: 'Minimum',
      reorderQuantity: 'Nachbestellmenge',
      description: 'Beschreibung',
      active: 'Aktiv',
      item: 'Artikel',
      selectItem: 'Artikel auswählen',
      searchItem: 'Katalogartikel suchen',
      place: 'Ort',
      selectPlace: 'Genauen Lagerort auswählen',
      quantity: 'Menge',
      state: 'Status',
      condition: 'Zustand',
      assetTag: 'Inventarnummer',
      serial: 'Seriennummer',
      lot: 'Charge',
      supplier: 'Lieferant',
      orderReference: 'Bestellreferenz',
      unitCost: 'Stückpreis',
      dueDate: 'Fällig am',
      notes: 'Notizen',
      pieceName: 'Einzelteil- / Losname',
      groupName: 'Gruppe',
      individualize: 'Pro Stück eine Buchung anlegen',
      splitQuantity: 'Abzusplittende Menge',
      placeCodeOptional: 'Kurzcode optional',
      roomArea: 'Raum / Bereich',
      shelfCabinet: 'Regal / Schrank',
      boxCompartment: 'Box / Fach',
      locationKindRoom: 'Raum / Bereich',
      locationKindFixture: 'Schrank / Regal',
      locationKindContainer: 'Box / Fach',
      selectRoom: 'Raum / Bereich wählen',
      selectFixture: 'Schrank / Regal wählen',
      rowPosition: 'Reihe / Position optional',
      email: 'E-Mail',
      role: 'Rolle',
      password: 'Passwort',
      newPassword: 'Neues Passwort',
      mustChangePassword: 'Passwortwechsel verlangen',
      tagName: 'Tag-Name',
      tagColor: 'Tag-Farbe',
      categoryTags: 'Kategorie-Tags',
      recordTags: 'Geräte-Tags',
      assignee: 'Person',
      assignedAt: 'Ausgegeben am',
      scanQr: 'QR-Code scannen',
      qrTarget: 'QR-Ziel',
      loginQr: 'Login-QR',
      qrLoginWaiting: 'Warte auf App-Scan...',
      qrLoginApproved: 'Login freigegeben.',
      scannerOpening: 'Kamera wird geöffnet...',
      scannerInstruction: 'Halte die Kamera auf den QR-Code.',
      scannerProcessing: 'QR-Code wird geprüft...',
      scannerSuccess: 'QR-Code verarbeitet.',
      scannerUnsupported: 'QR-Scan ist hier nicht verfügbar.',
      scannerCameraFailed: 'Kamera konnte nicht geöffnet werden.',
      scannerNotInventory: 'QR-Code ist kein Inventar-Link.',
      scannerNoCode: 'Kein QR-Code in diesem Bild gefunden.',
      scannerImageUnsupported: 'QR-Bildscan ist hier nicht verfügbar.',
      scannerImageFailed: 'QR-Bild konnte nicht gescannt werden.',
      scannerOpened: 'Inventar-QR geöffnet.',
      from: 'Von',
      to: 'Bis',
      qrImage: 'QR-Bild',
      qrLink: 'QR-Link',
    },
    actions: {
      editItem: 'Artikel bearbeiten',
      editPlace: 'Ort bearbeiten',
      editUser: 'Nutzer bearbeiten',
      editRecord: 'Buchung bearbeiten',
      splitRecord: 'Teilmenge abspalten / bewegen',
      deleteRecord: 'Buchung löschen',
      deleteItem: 'Artikel löschen',
      deleteTag: 'Tag löschen',
      saveRecord: 'Buchung speichern',
      createRecord: 'Buchung anlegen',
      splitMove: 'Abspalten / bewegen',
      saveItem: 'Artikel speichern',
      createItem: 'Artikel anlegen',
      savePlace: 'Ort speichern',
      createPlace: 'Ort anlegen',
      saveUser: 'Nutzer speichern',
      createUser: 'Nutzer anlegen',
      cancel: 'Abbrechen',
      exportCsv: 'CSV exportieren',
      exportJson: 'JSON exportieren',
      moveTo: 'Verschieben zu',
      logout: 'Abmelden',
      assign: 'Ausgeben',
      returnItem: 'Zurückgeben',
      createTag: 'Tag anlegen',
      generateQr: 'QR erzeugen',
      openScannedQr: 'Gescannten QR öffnen',
      quickDay: 'Tag',
      quickWeek: 'Woche',
      quickMonth: 'Monat',
    },
  },
}

type InventoryCopy = (typeof inventoryTranslations)['en']

const InventoryCopyContext = createContext<InventoryCopy>(inventoryTranslations.en)
const InventoryProjectsContext = createContext<InventoryProject[]>([])

function AssignmentTarget({ assignment, usersById }: { assignment: InventoryAssignment; usersById: Map<string, InventoryUser> }) {
  const projects = useContext(InventoryProjectsContext)
  const project = projects.find(project => project.id === assignment.projectId)
  return <>{project ? `${project.code} — ${project.name} · ` : ''}{usersById.get(assignment.userId)?.name ?? assignment.userId}</>
}

function useInventoryCopy() {
  return useContext(InventoryCopyContext)
}

function isInventoryLanguage(value: unknown): value is InventoryLanguage {
  return value === 'en' || value === 'de'
}

function initialInventoryLanguage(): InventoryLanguage {
  return readSuiteLanguage([languageStorageKey])
}

function initialInventoryTheme(): InventoryTheme {
  return readSuiteTheme([themeStorageKey])
}

const tabs: Array<{ id: InventoryTab; icon: typeof BarChart3 }> = [
  { id: 'overview', icon: BarChart3 },
  { id: 'projects', icon: FolderOpen },
  { id: 'products', icon: LayoutGrid },
  { id: 'inventory', icon: Boxes },
  { id: 'receiving', icon: PackagePlus },
  { id: 'requests', icon: ClipboardList },
  { id: 'orders', icon: ShoppingCart },
  { id: 'catalog', icon: ClipboardList },
  { id: 'locations', icon: MapPin },
  { id: 'users', icon: Users },
  { id: 'activity', icon: Shield },
  { id: 'qr', icon: QrCode },
  { id: 'exports', icon: Download },
]

function tabIsVisible(tabId: InventoryTab, permissions: Set<InventoryPermission>) {
  if (tabId === 'users') return permissions.has('manage_users')
  if (tabId === 'locations') return permissions.has('read_inventory')
  if (tabId === 'activity') return permissions.has('manage_users') || permissions.has('adjust_stock')
  if (tabId === 'qr') return permissions.has('read_inventory')
  if (tabId === 'orders') return permissions.has('read_inventory')
  if (tabId === 'receiving') return permissions.has('receive_stock') || permissions.has('adjust_stock')
  if (tabId === 'catalog') return permissions.has('manage_catalog') || permissions.has('read_inventory')
  if (tabId === 'exports') return permissions.has('export_inventory')
  return permissions.has('read_inventory')
}

function inventoryBaseUrlPath() {
  if (isInventoryMobileBuild) {
    const configuredPath = new URL(import.meta.env.BASE_URL ?? '/', window.location.origin).pathname.replace(/\/+$/, '')
    return configuredPath === '/' ? '' : configuredPath
  }
  const match = window.location.pathname.match(/^(.*?\/inventorySystem)(?:\/.*)?$/i)
  return match?.[1] ?? standaloneRouteBase
}

function inventoryRouteState(): InventoryRouteState {
  const base = inventoryBaseUrlPath().replace(/\/+$/, '')
  const relative = window.location.pathname.slice(base.length).replace(/^\/+|\/+$/g, '')
  const [first = 'overview', second] = relative.split('/')
  const fallbackTab: InventoryTab = 'overview'
  if (!isInventoryMobileBuild && first === 'qr-login' && second) return { tab: 'qr', targetType: 'qr-login', targetId: second }
  if (first === 'qr-labels' && second) return { tab: 'qr', targetType: 'qr-label', targetId: second }
  if (first === 'records' && second) return { tab: 'inventory', targetType: 'record', targetId: second }
  if (first === 'items' && second) return { tab: isInventoryMobileBuild ? 'inventory' : 'catalog', targetType: 'item', targetId: second }
  if (first === 'places' && second) return { tab: isInventoryMobileBuild ? 'inventory' : 'locations', targetType: 'place', targetId: second }
  if (first === 'categories' && second) return { tab: 'catalog', targetType: 'category', targetId: decodeURIComponent(second) }
  return tabs.some((item) => item.id === first) ? { tab: first as InventoryTab } : { tab: fallbackTab }
}

function inventoryTabPath(tabId: InventoryTab) {
  return `${inventoryBaseUrlPath().replace(/\/+$/, '')}/${tabId}`
}

function inventoryTargetPath(type: QrTargetType, id: string) {
  const base = inventoryBaseUrlPath().replace(/\/+$/, '')
  if (type === 'record') return `${base}/records/${encodeURIComponent(id)}`
  if (type === 'item') return `${base}/items/${encodeURIComponent(id)}`
  if (type === 'place') return `${base}/places/${encodeURIComponent(id)}`
  return `${base}/categories/${encodeURIComponent(id)}`
}

function inventoryQrLabelPath(id: string) {
  return `${inventoryBaseUrlPath().replace(/\/+$/, '')}/qr-labels/${encodeURIComponent(id)}`
}

function absoluteInventoryUrl(path: string) {
  return new URL(path, window.location.origin).toString()
}

function navigateInventoryTab(tabId: InventoryTab, setTab: (tab: InventoryTab) => void, replace = false) {
  const path = inventoryTabPath(tabId)
  if (window.location.pathname !== path) {
    if (replace) {
      window.history.replaceState(null, '', path)
    } else {
      window.history.pushState(null, '', path)
    }
  }
  setTab(tabId)
}

function inventorySystemClassName(...modifiers: string[]) {
  return ['inventory-system', isInventoryMobileBuild ? 'inventory-mobile-app' : '', ...modifiers].filter(Boolean).join(' ')
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

function InventoryThemeToggle({ theme, onTheme }: { theme: InventoryTheme; onTheme: (theme: InventoryTheme) => void }) {
  const copy = useInventoryCopy()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = theme === 'dark' ? copy.switchToLightMode : copy.switchToDarkMode

  return (
    <button aria-label={label} className="icon-action" title={label} type="button" onClick={() => onTheme(nextTheme)}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  )
}

function storedSessionToken() {
  if (!isInventoryMobileBuild) return ''
  try {
    return localStorage.getItem(sessionTokenStorageKey) ?? ''
  } catch {
    return ''
  }
}

function rememberSessionToken(payload: InventoryStatePayload) {
  if (!isInventoryMobileBuild || !payload.sessionToken) return
  try {
    localStorage.setItem(sessionTokenStorageKey, payload.sessionToken)
  } catch {
    // Mobile WebView storage can be unavailable in restricted modes.
  }
}

function clearSessionToken() {
  try {
    localStorage.removeItem(sessionTokenStorageKey)
    sessionStorage.removeItem(sessionTokenStorageKey)
  } catch {
    // Ignore storage cleanup failures.
  }
}

if (!isInventoryMobileBuild) clearSessionToken()

function inventoryRequestHeaders({
  csrfToken = '',
  json = false,
  sessionToken = '',
}: {
  csrfToken?: string
  json?: boolean
  sessionToken?: string
} = {}) {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (csrfToken) headers['X-Inventory-CSRF'] = csrfToken
  if (isInventoryMobileBuild) {
    headers['X-Inventory-Mobile-App'] = '1'
    const token = sessionToken || storedSessionToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }
  return headers
}

function openMobileServerSetup() {
  requestMobileServerSetup()
  window.location.reload()
}

function MobileServerSetupScreen({ currentServer }: { currentServer: string }) {
  const [language, setLanguage] = useState<InventoryLanguage>(initialInventoryLanguage)
  const [theme, setTheme] = useState<InventoryTheme>(initialInventoryTheme)
  const [address, setAddress] = useState(currentServer)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const copy = inventoryTranslations[language]
  const canCancel = Boolean(currentServer)

  useEffect(() => {
    document.title = copy.server.title
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [copy.server.title, theme])

  function selectLanguage(value: string) {
    if (!isInventoryLanguage(value)) return
    setLanguage(value)
    writeSuiteLanguage(value, [languageStorageKey])
  }

  function selectTheme(value: InventoryTheme) {
    setTheme(value)
    writeSuiteTheme(value, [themeStorageKey])
  }

  async function connect(event: FormEvent) {
    event.preventDefault()
    setError('')

    let serverUrl = ''
    try {
      serverUrl = normalizeMobileServerUrl(address)
    } catch (normalizationError) {
      setError(normalizationError instanceof Error && normalizationError.message === 'https' ? copy.server.https : copy.server.invalid)
      return
    }

    setChecking(true)
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`${serverUrl}/api/health`, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'X-Inventory-Mobile-App': '1' },
        signal: controller.signal,
      })
      const payload = (await response.json().catch(() => null)) as { ok?: unknown; service?: unknown; apiVersion?: unknown } | null
      if (
        !response.ok ||
        payload?.ok !== true ||
        payload.service !== 'digital-core-office-inventory' ||
        payload.apiVersion !== 1
      ) {
        throw new Error('unavailable')
      }

      if (serverUrl !== currentServer) clearSessionToken()
      writeMobileServerUrl(serverUrl)
      finishMobileServerSetup()
      window.location.reload()
    } catch {
      setError(copy.server.unavailable)
    } finally {
      window.clearTimeout(timeoutId)
      setChecking(false)
    }
  }

  function cancel() {
    finishMobileServerSetup()
    window.location.reload()
  }

  return (
    <InventoryCopyContext.Provider value={copy}>
      <main className={inventorySystemClassName('auth-screen', 'mobile-server-screen')}>
        <section className="auth-panel mobile-server-panel">
          <div className="inventory-brand auth-brand">
            <span className="inventory-brand-mark">
              <DigitalCoreOfficeLogo size={24} />
            </span>
            <div>
              <h1>{copy.server.title}</h1>
              <p>{copy.appName}</p>
            </div>
          </div>

          <p className="mobile-server-description">{copy.server.description}</p>
          {error && <div className="inventory-error mobile-server-error">{error}</div>}

          <form className="auth-form mobile-server-form" onSubmit={connect}>
            <label>
              {copy.server.address}
              <input
                autoCapitalize="none"
                autoComplete="url"
                autoCorrect="off"
                inputMode="url"
                placeholder={copy.server.placeholder}
                spellCheck={false}
                type="text"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              <small>{copy.server.example}</small>
            </label>
            <button className="primary-action" disabled={checking || !address.trim()} type="submit">
              <Settings size={17} />
              {checking ? copy.server.checking : copy.server.connect}
            </button>
            {canCancel && (
              <button className="secondary-action" disabled={checking} type="button" onClick={cancel}>
                {copy.server.cancel}
              </button>
            )}
          </form>

          <div className="mobile-server-privacy">
            <Shield size={18} />
            <p>{copy.server.privacy}</p>
          </div>

          <div className="auth-preferences">
            <label className="auth-language">
              {copy.language}
              <select value={language} onChange={(event) => selectLanguage(event.target.value)}>
                <option value="en">English</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
            <InventoryThemeToggle theme={theme} onTheme={selectTheme} />
          </div>
        </section>
      </main>
    </InventoryCopyContext.Provider>
  )
}

function InventoryWorkspace() {
  const [state, setState] = useState<InventoryStatePayload | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [sessionFailure, setSessionFailure] = useState<'connection' | 'forbidden' | null>(null)
  const [checkingSession, setCheckingSession] = useState(false)
  const stateRequestEpoch = useRef(0)
  const [language, setLanguage] = useState<InventoryLanguage>(initialInventoryLanguage)
  const [theme, setTheme] = useState<InventoryTheme>(initialInventoryTheme)
  const [routeState, setRouteState] = useState<InventoryRouteState>(inventoryRouteState)
  const [tab, setTab] = useState<InventoryTab>(() => inventoryRouteState().tab)
  const [qrScanRequestId, setQrScanRequestId] = useState(0)
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<InventoryState | 'all'>('all')
  const [locationFilter, setLocationFilter] = useState('all')
  const [itemFilter, setItemFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [recordGroupBy, setRecordGroupBy] = useState<RecordGroupBy>('none')
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  const [splittingRecordId, setSplittingRecordId] = useState<string | null>(null)
  const [assigningRecordId, setAssigningRecordId] = useState<string | null>(null)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preparedDownload, setPreparedDownload] = useState<{ href: string; filename: string } | null>(null)
  const [exportStatus, setExportStatus] = useState<'idle' | 'preparing' | 'ready' | 'error'>('idle')
  const [exportError, setExportError] = useState('')
  useEffect(() => {
    // Keep the file available for an explicit second click if automatic downloading is blocked.
    // A replaced file may still be opening in the browser, so defer its cleanup.
    return () => { if (preparedDownload) window.setTimeout(() => URL.revokeObjectURL(preparedDownload.href), 30_000) }
  }, [preparedDownload])
  useEffect(() => { setPreparedDownload(null); setExportStatus('idle') }, [state?.currentUser.id])
  const approvedQrLoginTokenRef = useRef('')
  const pendingReceiptKeys = useRef(new Map<string, string>())
  const copy = inventoryTranslations[language]

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

  const permissions = useMemo(() => new Set(state?.permissions ?? []), [state?.permissions])
  const visibleTabs = useMemo(
    () => tabs.filter((item) => tabIsVisible(item.id, permissions) && (!isInventoryMobileBuild || mobileTabIds.has(item.id))),
    [permissions],
  )
  const itemsById = useMemo(() => new Map((state?.items ?? []).map((item) => [item.id, item])), [state?.items])
  const locationsById = useMemo(() => new Map((state?.locations ?? []).map((location) => [location.id, location])), [state?.locations])
  const usersById = useMemo(() => new Map((state?.users ?? []).map((user) => [user.id, user])), [state?.users])
  const projectsById = useMemo(() => new Map((state?.projects ?? []).map(project => [project.id, project])), [state?.projects])
  const activeUsers = useMemo(() => (state?.users ?? []).filter((user) => user.active), [state?.users])
  const tagsById = useMemo(() => new Map((state?.tags ?? []).map((tag) => [tag.id, tag])), [state?.tags])
  const categoryTagIds = useMemo(() => groupTagIds(state?.categoryTags ?? [], 'category'), [state?.categoryTags])
  const recordTagIds = useMemo(() => groupTagIds(state?.recordTags ?? [], 'recordId'), [state?.recordTags])
  const activeAssignmentsByRecordId = useMemo(() => groupActiveAssignments(state?.assignments ?? []), [state?.assignments])
  const totalsByItemId = useMemo(() => new Map((state?.totals ?? []).map((total) => [total.itemId, total])), [state?.totals])
  const editingRecord = state?.records.find((record) => record.id === editingRecordId)
  const splittingRecord = state?.records.find((record) => record.id === splittingRecordId)
  const assigningRecord = state?.records.find((record) => record.id === assigningRecordId)
  const selectedRecord = routeState.targetType === 'record' ? state?.records.find((record) => record.id === routeState.targetId) : undefined
  const selectedItem = routeState.targetType === 'item' ? state?.items.find((item) => item.id === routeState.targetId) : undefined
  const selectedLocation = routeState.targetType === 'place' ? state?.locations.find((location) => location.id === routeState.targetId) : undefined
  const selectedLocationIds = useMemo(
    () => selectedLocation ? locationDescendantIds(selectedLocation.id, state?.locations ?? []) : new Set<string>(),
    [selectedLocation, state?.locations],
  )
  const editingItem = state?.items.find((item) => item.id === editingItemId)
  const editingLocation = state?.locations.find((location) => location.id === editingLocationId)
  const editingUser = state?.users.find((user) => user.id === editingUserId)

  const invalidateSession = useCallback(() => {
    ++stateRequestEpoch.current
    clearSessionToken()
    setState(null)
    setSessionFailure(null)
    setAuthChecked(true)
    setCheckingSession(false)
    if (window.parent !== window) window.parent.postMessage({ type: 'dco:session-invalidated' }, window.location.origin)
  }, [])

  const loadState = useCallback(
    async () => {
      const epoch = ++stateRequestEpoch.current
      setError('')
      setCheckingSession(true)
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(`${inventoryApiBase}/api/inventorySystem/state`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
          headers: inventoryRequestHeaders({ sessionToken: state?.sessionToken }),
        })
        if (epoch !== stateRequestEpoch.current) return
        if (response.status === 401) {
          invalidateSession()
          return
        }
        if (!response.ok) {
          if (response.status === 403 && window.parent !== window) window.parent.postMessage({ type: 'dco:session-invalidated' }, window.location.origin)
          setSessionFailure(response.status === 403 ? 'forbidden' : 'connection')
          const payload = (await response.json().catch(() => ({ message: copy.loadFailed }))) as ApiError
          throw new Error(payload.message)
        }

        const payload = (await response.json()) as InventoryStatePayload
        if (epoch !== stateRequestEpoch.current) return
        rememberSessionToken(payload)
        setState(payload)
        setSessionFailure(null)
        setAuthChecked(true)
      } catch (loadError) {
        if (epoch !== stateRequestEpoch.current) return
        setSessionFailure(current => current === 'forbidden' ? current : 'connection')
        setError(loadError instanceof Error ? loadError.message : copy.loadFailed)
        setAuthChecked(true)
      } finally {
        window.clearTimeout(timeout)
        if (epoch === stateRequestEpoch.current) setCheckingSession(false)
      }
    },
    [copy.loadFailed, invalidateSession, state?.sessionToken],
  )

  useEffect(() => {
    function syncRoute() {
      const nextRoute = inventoryRouteState()
      setRouteState(nextRoute)
      setTab(nextRoute.tab)
    }
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])

  const approveQrLoginChallenge = useCallback(
    async (token: string) => {
      if (!state?.csrfToken) {
        setError(copy.login.failed)
        return false
      }

      setLoading(true)
      setError('')
      try {
        const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/qr-login/challenges/approve`, {
          method: 'POST',
          credentials: 'include',
          headers: inventoryRequestHeaders({ csrfToken: state.csrfToken, json: true, sessionToken: state.sessionToken }),
          body: JSON.stringify({ token }),
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({ message: copy.changeFailed }))) as ApiError
          throw new Error(payload.message)
        }
        return true
      } catch (approveError) {
        setError(approveError instanceof Error ? approveError.message : copy.changeFailed)
        return false
      } finally {
        setLoading(false)
      }
    },
    [copy.changeFailed, copy.login.failed, state?.csrfToken, state?.sessionToken],
  )

  useEffect(() => {
    const initialRoute = inventoryRouteState()
    setRouteState(initialRoute)
    setTab(initialRoute.tab)
    void loadState()
  }, [loadState])

  const navigateToTab = useCallback((nextTab: InventoryTab, replace = false) => {
    navigateInventoryTab(nextTab, setTab, replace)
    setRouteState({ tab: nextTab })
  }, [])

  const openRecordDetails = useCallback((recordId: string) => {
    const nextRoute: InventoryRouteState = { tab: 'inventory', targetType: 'record', targetId: recordId }
    window.history.pushState(null, '', inventoryTargetPath('record', recordId))
    setRouteState(nextRoute)
    setTab('inventory')
    window.scrollTo({ top: 0 })
  }, [])

  const openItemDetails = useCallback((itemId: string) => {
    const nextRoute: InventoryRouteState = { tab: 'catalog', targetType: 'item', targetId: itemId }
    window.history.pushState(null, '', inventoryTargetPath('item', itemId))
    setRouteState(nextRoute)
    setTab('catalog')
    window.scrollTo({ top: 0 })
  }, [])

  const openLocationDetails = useCallback((locationId: string) => {
    const nextRoute: InventoryRouteState = { tab: 'locations', targetType: 'place', targetId: locationId }
    window.history.pushState(null, '', inventoryTargetPath('place', locationId))
    setRouteState(nextRoute)
    setTab('locations')
    window.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    if (state && visibleTabs.length > 0 && !visibleTabs.some((item) => item.id === tab)) {
      navigateToTab(visibleTabs[0].id, true)
    }
  }, [navigateToTab, state, tab, visibleTabs])

  useEffect(() => {
    if (!state) return
    if (routeState.targetType === 'qr-login' && routeState.targetId) {
      if (approvedQrLoginTokenRef.current !== routeState.targetId) {
          approvedQrLoginTokenRef.current = routeState.targetId
          void approveQrLoginChallenge(routeState.targetId).then((approved) => {
            if (approved) {
              navigateToTab('overview', true)
            }
          })
      }
      return
    }
    if (routeState.targetType === 'record' && routeState.targetId) {
      const record = state.records.find((candidate) => candidate.id === routeState.targetId)
      if (record) {
        if (isInventoryMobileBuild) {
          setItemFilter(record.itemId)
          setLocationFilter(record.locationId)
          setSearch(record.label ?? '')
        }
        setTab('inventory')
      }
    }
    if (routeState.targetType === 'item' && routeState.targetId) {
      if (isInventoryMobileBuild) {
        setItemFilter(routeState.targetId)
        setTab('inventory')
      } else {
        setTab('catalog')
      }
    }
    if (routeState.targetType === 'place' && routeState.targetId) {
      if (isInventoryMobileBuild) {
        setLocationFilter(routeState.targetId)
        setTab('inventory')
      } else {
        setTab('locations')
      }
    }
    if (routeState.targetType === 'category' && routeState.targetId) {
      setCategoryFilter(routeState.targetId)
      setTab('inventory')
    }
  }, [approveQrLoginChallenge, navigateToTab, routeState, state])

  function can(permission: InventoryPermission) {
    return permissions.has(permission)
  }

  function openMobileQrScanner() {
    setQrScanRequestId((current) => current + 1)
    navigateToTab('qr')
  }

  function canWriteState(nextState: InventoryState) {
    if (can('adjust_stock') && ['in_stock', 'reserved', 'in_use', 'maintenance', 'damaged', 'retired'].includes(nextState)) {
      return true
    }
    if (nextState === 'requested' || nextState === 'approved') return can('request_stock')
    if (nextState === 'ordered' || nextState === 'cancelled') return can('order_stock')
    if (nextState === 'delivered' || nextState === 'in_stock') return can('receive_stock') || can('adjust_stock')
    return can('adjust_stock')
  }

  const clickUpApi = useCallback(async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${inventoryApiBase}/api/inventorySystem/clickup${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal: AbortSignal.timeout(60_000),
      headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', json: true, sessionToken: state?.sessionToken }),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message ?? 'ClickUp request failed.')
    return payload as T
  }, [state?.csrfToken, state?.sessionToken])

  const catalogApi = useCallback(async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${inventoryApiBase}/api/inventorySystem${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include', signal: AbortSignal.timeout(60_000),
      headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', json: true, sessionToken: state?.sessionToken }),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message ?? 'Catalog request failed.')
    return payload as T
  }, [state?.csrfToken, state?.sessionToken])

  async function apiMutation(path: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') {
    const epoch = ++stateRequestEpoch.current
    setLoading(true)
    setError('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 30_000)
    const receiptFingerprint = path === '/api/inventorySystem/receipts' ? JSON.stringify(body) : undefined
    if (receiptFingerprint) {
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : pendingReceiptKeys.current.get(receiptFingerprint) ?? crypto.randomUUID()
      pendingReceiptKeys.current.set(receiptFingerprint, idempotencyKey)
      body = { ...body, idempotencyKey }
    }
    try {
      const response = await fetch(`${inventoryApiBase}${path}`, {
        method,
        credentials: 'include',
        signal: controller.signal,
        headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', json: true, sessionToken: state?.sessionToken }),
        body: JSON.stringify(body),
      })

      if (epoch !== stateRequestEpoch.current) return false
      if (response.status === 401) {
        invalidateSession()
        throw new Error(copy.login.failed)
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: copy.changeFailed }))) as ApiError
        if (response.status === 409) await loadState()
        throw new Error(payload.message)
      }

      const payload = (await response.json()) as InventoryStatePayload
      if (epoch !== stateRequestEpoch.current) return false
      rememberSessionToken(payload)
      setState(payload)
      if (receiptFingerprint) pendingReceiptKeys.current.delete(receiptFingerprint)
      return true
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : copy.changeFailed)
      return false
    } finally {
      window.clearTimeout(timeout)
      setLoading(false)
    }
  }

  function selectLanguage(value: string) {
    if (!isInventoryLanguage(value)) return
    setLanguage(value)
    writeSuiteLanguage(value, [languageStorageKey])
  }

  function selectTheme(value: InventoryTheme) {
    setTheme(value)
    writeSuiteTheme(value, [themeStorageKey])
  }

  async function login(email: string, password: string, stayLoggedIn: boolean) {
    ++stateRequestEpoch.current
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: inventoryRequestHeaders({ json: true }),
        body: JSON.stringify({ email, password, stayLoggedIn }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: copy.login.failed }))) as ApiError
        throw new Error(payload.message)
      }
      const payload = (await response.json()) as InventoryStatePayload
      rememberSessionToken(payload)
      setState(payload)
      setSessionFailure(null)
      setAuthChecked(true)
      return true
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : copy.login.failed)
      return false
    } finally {
      setLoading(false)
    }
  }

  function completeQrChallengeLogin(payload: InventoryStatePayload) {
    ++stateRequestEpoch.current
    rememberSessionToken(payload)
    setState(payload)
    setSessionFailure(null)
    setAuthChecked(true)
    setError('')
    navigateToTab('overview', true)
  }

  async function logout() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', sessionToken: state?.sessionToken }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Partial<ApiError>
        throw new Error(typeof payload.message === 'string' && payload.message ? payload.message : copy.logoutFailed)
      }
      if (state) {
        try { sessionStorage.removeItem(receivingDraftKey(state.currentUser.id, inventoryApiBase)) } catch { /* Storage may be unavailable. */ }
      }
      invalidateSession()
    } catch (logoutError) {
      setError(logoutError instanceof Error && logoutError.message !== copy.logoutFailed ? `${copy.logoutFailed} ${logoutError.message}` : copy.logoutFailed)
    } finally {
      setLoading(false)
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/password`, {
        method: 'POST',
        credentials: 'include',
        headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', json: true, sessionToken: state?.sessionToken }),
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: copy.changeFailed }))) as ApiError
        throw new Error(payload.message)
      }
      const payload = (await response.json()) as InventoryStatePayload
      rememberSessionToken(payload)
      setState(payload)
      setError(copy.account.passwordChanged)
      return true
    } catch (passwordError) {
      setError(passwordError instanceof Error ? passwordError.message : copy.changeFailed)
      return false
    } finally {
      setLoading(false)
    }
  }

  async function submitRecord(recordId: string | undefined, body: Record<string, unknown>) {
    const source = state?.records.find((record) => record.id === recordId)
    if (source && body.state === 'in_stock' && ['ordered', 'delivered'].includes(source.state)) {
      const saved = await receiveProcurementRecord(source, body)
      if (saved) setEditingRecordId(null)
      return saved
    }
    const saved = await apiMutation(recordId ? `/api/inventorySystem/records/${recordId}` : '/api/inventorySystem/records', body, recordId ? 'PATCH' : 'POST')
    if (saved) {
      setEditingRecordId(null)
    }
    return saved
  }

  async function submitSplitRecord(recordId: string, body: Record<string, unknown>) {
    const saved = await apiMutation(`/api/inventorySystem/records/${recordId}/split`, body, 'POST')
    if (saved) {
      setSplittingRecordId(null)
    }
    return saved
  }

  async function submitItem(itemId: string | undefined, body: Record<string, unknown>) {
    const saved = await apiMutation(itemId ? `/api/inventorySystem/items/${itemId}` : '/api/inventorySystem/items', body, itemId ? 'PATCH' : 'POST')
    if (saved) {
      setEditingItemId(null)
    }
    return saved
  }

  async function submitLocation(locationId: string | undefined, body: Record<string, unknown>) {
    const saved = await apiMutation(
      locationId ? `/api/inventorySystem/locations/${locationId}` : '/api/inventorySystem/locations',
      body,
      locationId ? 'PATCH' : 'POST',
    )
    if (saved) {
      setEditingLocationId(null)
    }
    return saved
  }

  async function submitUser(userId: string | undefined, body: Record<string, unknown>) {
    const saved = await apiMutation(userId ? `/api/inventorySystem/users/${userId}` : '/api/inventorySystem/users', body, userId ? 'PATCH' : 'POST')
    if (saved) {
      setEditingUserId(null)
    }
    return saved
  }

  async function submitTag(body: Record<string, unknown>) {
    return apiMutation('/api/inventorySystem/tags', body, 'POST')
  }

  async function deleteTag(tag: InventoryTag) {
    await apiMutation(`/api/inventorySystem/tags/${tag.id}`, {}, 'DELETE')
  }

  async function saveQrLabel(id: string, body: Record<string, unknown>, isNew: boolean) {
    return apiMutation(isNew ? '/api/inventorySystem/qr-labels' : `/api/inventorySystem/qr-labels/${id}`, body, isNew ? 'POST' : 'PATCH')
  }

  async function deactivateQrLabel(id: string) {
    return apiMutation(`/api/inventorySystem/qr-labels/${id}`, {}, 'DELETE')
  }

  async function deleteItem(item: InventoryItemDefinition) {
    await apiMutation(`/api/inventorySystem/items/${item.id}`, {}, 'DELETE')
  }

  async function deleteRecord(record: InventoryRecord) {
    const reason = window.prompt(language === 'de' ? 'Grund für die Stornierung (Pflichtfeld):' : 'Reason for reversal (required):')?.trim()
    if (!reason) return
    await apiMutation(`/api/inventorySystem/records/${record.id}`, { reason, expectedVersion: record.version }, 'DELETE')
  }

  async function submitAssignment(recordId: string, body: Record<string, unknown>) {
    const saved = await apiMutation(`/api/inventorySystem/records/${recordId}/assignments`, body, 'POST')
    if (saved) {
      setAssigningRecordId(null)
    }
    return saved
  }

  async function returnAssignment(assignment: InventoryAssignment) {
    const record = state?.records.find(record => record.id === assignment.recordId)
    await apiMutation(`/api/inventorySystem/assignments/${assignment.id}/return`, { expectedVersion: record?.version }, 'POST')
  }

  async function receiveProcurementRecord(record: InventoryRecord, changes: Record<string, unknown> = {}) {
    return apiMutation('/api/inventorySystem/receipts', {
      receivedAt: record.deliveredAt ?? record.updatedAt, supplier: record.supplier, orderReference: record.orderReference,
      lines: [{ ...record, ...changes, sourceRecordId: record.id, sourceExpectedVersion: changes.expectedVersion ?? record.version, rowNumber: 1 }],
    }, 'POST')
  }

  async function quickState(record: InventoryRecord, nextState: InventoryState) {
    if (nextState === 'in_stock') {
      await receiveProcurementRecord(record)
      return
    }
    await submitRecord(record.id, { ...record, state: nextState, expectedVersion: record.version })
  }

  async function downloadExport(format: 'csv' | 'json') {
    setLoading(true)
    setError('')
    setPreparedDownload(null)
    setExportStatus('preparing')
    setExportError('')
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/exports?format=${format}`, {
        credentials: 'include',
        headers: inventoryRequestHeaders({ sessionToken: state?.sessionToken }),
      })
      if (response.status === 401) {
        invalidateSession()
        throw new Error(copy.login.failed)
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: copy.exportFailed }))) as ApiError
        throw new Error(payload.message)
      }

      const blob = await response.blob()
      offerDownload(blob, `inventory-${new Date().toISOString().slice(0, 10)}.${format}`)
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : copy.exportFailed
      setError(message)
      setExportError(message)
      setExportStatus('error')
    } finally {
      setLoading(false)
    }
  }

  function offerDownload(blob: Blob, filename: string) {
    const href = URL.createObjectURL(blob)
    setPreparedDownload({ href, filename })
    setExportStatus('ready')
    const link = document.createElement('a')
    link.href = href
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
  }

  async function previewReceiptImport(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
    const response = await fetch(`${inventoryApiBase}/api/inventorySystem/receipts/import/preview`, {
      method: 'POST', credentials: 'include',
      headers: inventoryRequestHeaders({ csrfToken: state?.csrfToken ?? '', json: true, sessionToken: state?.sessionToken }),
      body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }),
    })
    if (response.status === 401) invalidateSession()
    const payload = await response.json() as { rows?: []; message?: string }
    if (!response.ok || !payload.rows) throw new Error(payload.message || copy.loadFailed)
    return payload.rows
  }

  async function exportReceipts(month: string) {
    setLoading(true)
    setError('')
    setPreparedDownload(null)
    setExportStatus('preparing')
    setExportError('')
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/receipts/export?month=${encodeURIComponent(month)}`, {
        credentials: 'include', headers: inventoryRequestHeaders({ sessionToken: state?.sessionToken }),
      })
      if (response.status === 401) invalidateSession()
      if (!response.ok) throw new Error(copy.exportFailed)
      offerDownload(await response.blob(), `goods-receipts-${month}.csv`)
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : copy.exportFailed
      setError(message)
      setExportError(message)
      setExportStatus('error')
    } finally { setLoading(false) }
  }

  async function fetchActivity(range: ActivityRange) {
    const params = new URLSearchParams({
      from: localDateBoundaryIso(range.from, false),
      to: localDateBoundaryIso(range.to, true),
    })
    const response = await fetch(`${inventoryApiBase}/api/inventorySystem/activity?${params}`, {
      credentials: 'include',
      headers: inventoryRequestHeaders({ sessionToken: state?.sessionToken }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ message: copy.loadFailed }))) as ApiError
      throw new Error(payload.message)
    }
    return ((await response.json()) as { activity: InventoryStatePayload['activity'] }).activity
  }

  const filteredRecords = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (state?.records ?? [])
      .map((record) => {
      const item = itemsById.get(record.itemId)
      const location = locationsById.get(record.locationId)
        const tagLabels = tagsForRecord(record, item, recordTagIds, categoryTagIds, tagsById).map((tag) => tag.name)
        const holders = (activeAssignmentsByRecordId.get(record.id) ?? []).flatMap(assignment => [usersById.get(assignment.userId)?.name, projectsById.get(assignment.projectId ?? '')?.name, projectsById.get(assignment.projectId ?? '')?.code])
      const matchesState = stateFilter === 'all' || record.state === stateFilter
      const matchesLocation = locationFilter === 'all' || record.locationId === locationFilter
      const matchesItem = itemFilter === 'all' || record.itemId === itemFilter
      const matchesCategory = categoryFilter === 'all' || item?.category === categoryFilter
      const haystack = [
        item?.sku,
        item?.name,
        item?.description,
        item?.category,
        item?.manufacturer,
        item?.model,
        item?.value,
        item?.manufacturerPartNumber,
        item?.lcscPartNumber,
        item?.packageForm,
        location?.code,
        location?.name,
        location?.roomName,
        location?.area,
        location?.rack,
        location?.bin,
        locationDetails(location, state?.locations ?? []),
        location?.roomCode,
        location?.fixtureCode,
        location?.rowCode,
        record.label,
        record.groupName,
        record.assetTag,
        record.serialNumber,
        record.lotNumber,
        record.supplier,
        record.orderReference,
        record.state,
        record.condition,
        record.notes,
        record.quantityLabel,
        record.sourceReference,
          ...tagLabels,
          ...holders,
      ]
        .filter(Boolean)
        .join(' ')
      const score = inventorySearchScore(needle, haystack)
        return { record, score, matchesState, matchesLocation, matchesItem, matchesCategory }
      })
      .filter((entry) => entry.matchesState && entry.matchesLocation && entry.matchesItem && entry.matchesCategory && entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.record)
  }, [
    activeAssignmentsByRecordId,
    categoryFilter,
    categoryTagIds,
    itemFilter,
    itemsById,
    locationFilter,
    locationsById,
    recordTagIds,
    search,
    state?.records,
    stateFilter,
    tagsById,
    usersById,
    projectsById,
    state?.locations,
  ])
  const categories = useMemo(() => {
    const stateCategories = state?.categories ?? []
    return stateCategories.length > 0 ? stateCategories : categoriesFromItems(state?.items ?? [])
  }, [state?.categories, state?.items])

  const recoveryPanel = (<main className="inventory-system auth-screen">
            <section className="auth-panel" aria-labelledby="inventory-recovery-title">
              <h1 id="inventory-recovery-title">{sessionFailure === 'forbidden' ? (language === 'de' ? 'Zugriff auf Inventar nicht verfügbar' : 'Inventory access unavailable') : (language === 'de' ? 'Verbindung zum Inventar unterbrochen' : 'Inventory connection interrupted')}</h1>
              <p role="alert">{sessionFailure === 'forbidden' ? (language === 'de' ? 'Der Zugriff wurde abgelehnt. Versuchen Sie es erneut oder lassen Sie den Zugriff durch einen Administrator prüfen.' : 'Access was denied. Retry, or ask an administrator to check access.') : (language === 'de' ? 'Ihre Sitzung konnte nicht geprüft werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.' : 'Your session could not be checked. Check your connection and try again.')}</p>
              <button className="primary-action" disabled={checkingSession} type="button" onClick={() => void loadState()}>{checkingSession ? copy.loading : (language === 'de' ? 'Erneut versuchen' : 'Try again')}</button>
              {configuredCoreOfficeUrl && <a className="secondary-action" href={configuredCoreOfficeUrl}>{language === 'de' ? 'Core öffnen' : 'Open Core'}</a>}
            </section>
          </main>)

  if (!state) {
    return (
      <InventoryCopyContext.Provider value={copy}>
        {sessionFailure ? (
          recoveryPanel
        ) : authChecked ? (
          <LoginScreen
            error={error}
            language={language}
            loading={loading}
            theme={theme}
            onLanguage={selectLanguage}
            onLogin={login}
            onQrLoginClaimed={completeQrChallengeLogin}
            onTheme={selectTheme}
          />
        ) : (
          <SuiteLoadingScreen message={error || copy.loading} product="inventory" title={copy.appName} />
        )}
      </InventoryCopyContext.Provider>
    )
  }

  const lowStockItems = state.items.filter((item) => totalsByItemId.get(item.id)?.belowMinimum)
  const openOrderRecords = state.records.filter((record) => ['requested', 'approved', 'ordered', 'delivered'].includes(record.state))
  const inStockTotal = state.totals.reduce((total, itemTotal) => total + itemTotal.inStockQuantity, 0)
  const orderedTotal = state.totals.reduce((total, itemTotal) => total + itemTotal.orderedQuantity, 0)
  const requestedTotal = state.totals.reduce((total, itemTotal) => total + itemTotal.requestedQuantity, 0)
  const metricItem = selectedItem ?? (selectedRecord ? itemsById.get(selectedRecord.itemId) : undefined)
  const metricItemTotals = metricItem ? totalsByItemId.get(metricItem.id) : undefined
  const metricInStock = metricItem ? metricItemTotals?.inStockQuantity ?? 0 : inStockTotal
  const metricOrdered = metricItem ? metricItemTotals?.orderedQuantity ?? 0 : orderedTotal
  const metricRequested = metricItem ? metricItemTotals?.requestedQuantity ?? 0 : requestedTotal
  const metricShortfall = metricItem ? Math.max(0, metricItem.minQuantity - metricInStock) : lowStockItems.length
  const inventoryProductPath = inventoryBasePath ? `${inventoryBasePath}/` : '/'
  const suiteProducts: SuiteProductDefinition[] = [
    ...(coreOfficeUrl ? [{ id: 'core' as const, path: coreOfficeUrl || '/', label: 'Core' }] : []),
    ...(enabledSuiteModules.has('time') ? [{ id: 'time' as const, path: timeTrackingUrl, label: language === 'de' ? 'Zeit' : 'Time' }] : []),
    ...(enabledSuiteModules.has('inventory') ? [{ id: 'inventory' as const, path: inventoryProductPath, label: language === 'de' ? 'Inventar' : 'Inventory' }] : []),
    ...(enabledSuiteModules.has('agile') ? [{ id: 'agile' as const, path: agileProjectManagementUrl, label: 'Agile' }] : []),
  ]
  const mainTabIds = new Set(['overview', 'projects', 'inventory', 'requests', 'orders', 'locations'])
  const inventoryNavigation: SuiteNavItem[] = visibleTabs.filter(item => mainTabIds.has(item.id)).map((item) => ({
    id: item.id,
    label: copy.tabs[item.id],
    icon: item.icon,
    active: tab === item.id || (item.id === 'inventory' && ['catalog', 'products'].includes(tab)),
    onSelect: () => navigateToTab(item.id),
  }))

  if (state.currentUser.mustChangePassword) {
    if (state.usersManagedByCore) {
      const accountUrl = isInventoryMobileBuild && inventoryApiBase ? new URL(state.coreLoginUrl || '/', inventoryApiBase).href : state.coreLoginUrl || coreOfficeUrl || '/'
      return <main className="inventory-panel"><h1>Digital Core Office</h1><p>{language === 'de' ? 'Ändern Sie Ihr temporäres Passwort in Digital Core Office und melden Sie sich anschließend erneut an.' : 'Change your temporary password in Digital Core Office, then sign in again.'}</p>{error && <p role="alert">{error}</p>}<a className="primary-action" href={accountUrl}>{language === 'de' ? 'Core öffnen' : 'Open Core'}</a><button type="button" className="secondary-action" disabled={loading} onClick={() => void logout()}>{language === 'de' ? 'Abmelden' : 'Sign out'}</button></main>
    }
    return (
      <InventoryCopyContext.Provider value={copy}>
        <PasswordChangeScreen
          error={error}
          language={language}
          loading={loading}
          theme={theme}
          onChangePassword={changePassword}
          onLanguage={selectLanguage}
          onLogout={logout}
          onTheme={selectTheme}
        />
      </InventoryCopyContext.Provider>
    )
  }

  if (isInventoryMobileBuild) {
    return (
      <InventoryCopyContext.Provider value={copy}>
        {sessionFailure === 'forbidden' && recoveryPanel}
        <div hidden={sessionFailure === 'forbidden'} inert={sessionFailure === 'forbidden'}>
        <MobileInventoryApp
          activeAssignmentsByRecordId={activeAssignmentsByRecordId}
          categoryTagIds={categoryTagIds}
          categories={categories}
          categoryFilter={categoryFilter}
          error={error}
          filteredRecords={filteredRecords}
          inStockTotal={inStockTotal}
          itemFilter={itemFilter}
          itemsById={itemsById}
          language={language}
          loading={loading}
          locationFilter={locationFilter}
          locationsById={locationsById}
          lowStockItems={lowStockItems}
          onApproveQrLogin={approveQrLoginChallenge}
          onCategoryFilter={setCategoryFilter}
          onItemFilter={setItemFilter}
          onLanguage={selectLanguage}
          onLocationFilter={setLocationFilter}
          onLogout={logout}
          onTheme={selectTheme}
          onNavigate={(path) => {
            window.history.pushState(null, '', path)
            const nextRoute = inventoryRouteState()
            setRouteState(nextRoute)
            setTab(nextRoute.tab)
          }}
          onScan={openMobileQrScanner}
          onSearch={setSearch}
          onStateFilter={setStateFilter}
          onTab={navigateToTab}
          openOrderRecords={openOrderRecords}
          orderedTotal={orderedTotal}
          qrScanRequestId={qrScanRequestId}
          recordTagIds={recordTagIds}
          requestedTotal={requestedTotal}
          search={search}
          state={state}
          stateFilter={stateFilter}
          tab={tab}
          tagsById={tagsById}
          theme={theme}
          totalsByItemId={totalsByItemId}
          usersById={usersById}
        />
        </div>
      </InventoryCopyContext.Provider>
    )
  }

  return (
    <InventoryCopyContext.Provider value={copy}>
    {sessionFailure === 'forbidden' && recoveryPanel}
    <InventoryProjectsContext.Provider value={state.projects ?? []}>
    <div hidden={sessionFailure === 'forbidden'} inert={sessionFailure === 'forbidden'}>
    <main className={inventorySystemClassName()}>
      <SuiteShellHeader
        currentProduct="inventory"
        disabled={loading}
        identityLine={`${state.currentUser.name} · ${copy.roles[state.currentUser.role]} · ${copy.recordCount(state.records.length)}`}
        language={language}
        navigationLabel={copy.navigation}
        onLanguageChange={selectLanguage}
        onLogout={() => void logout()}
        onThemeChange={selectTheme}
        productTitle={copy.appName}
        products={suiteProducts}
        theme={theme}
        workspaceOnly={isEmbeddedSuiteWorkspace}
      />

      <div className="inventory-workspace-layout">
      <InventoryNavigation items={inventoryNavigation} tools={visibleTabs.filter(item => !mainTabIds.has(item.id) && !['products', 'catalog'].includes(item.id)).map(item => ({ id: item.id, label: copy.tabs[item.id], icon: item.icon, active: tab === item.id, onSelect: () => navigateToTab(item.id) }))} label={copy.navigation} toolsLabel={language === 'de' ? 'Weitere Werkzeuge' : 'More tools'} activeLabel={copy.tabs[tab]} refresh={<button className="icon-action" disabled={loading} title={copy.refresh} type="button" onClick={() => void loadState()}><RefreshCcw size={18} /></button>} />
      <div className="dco-suite-content">

      {Boolean(selectedRecord || selectedItem) && <section
        className="inventory-metrics"
        aria-label={metricItem ? `${copy.metrics.aria}: ${metricItem.name}` : copy.metrics.aria}
        data-scope={metricItem ? 'item' : 'global'}
      >
        {metricItem && (
          <div className="inventory-metrics-context">
            <span>{copy.metrics.itemScope}</span>
            <strong>{metricItem.name}</strong>
            {metricItem.sku && <small>{metricItem.sku}</small>}
          </div>
        )}
        <Metric label={copy.metrics.inStock} value={formatQuantity(metricInStock)} />
        <Metric label={copy.metrics.ordered} value={formatQuantity(metricOrdered)} />
        <Metric label={copy.metrics.requested} value={formatQuantity(metricRequested)} />
        <Metric
          label={metricItem ? copy.metrics.shortfall : copy.metrics.lowStock}
          value={formatQuantity(metricShortfall)}
          tone={metricShortfall > 0 ? 'warning' : 'normal'}
        />
      </section>}

      <section className="inventory-content">
        <InventoryClickUpProvider key={state.currentUser.id} state={state} de={language === 'de'} api={clickUpApi}>
        <CatalogProvider suspended={sessionFailure === 'forbidden'} state={state} de={language === 'de'} read={catalogApi} mutate={(path, body) => apiMutation(`/api/inventorySystem${path}`, body)} busy={loading} error={error}><InventoryWorkflowProvider suspended={sessionFailure === 'forbidden'} error={error} key={state.currentUser.id} state={state} language={language} loading={loading} onClearError={() => setError('')} onMutation={(path, body, method) => apiMutation(`/api/inventorySystem${path}`, body, method)} onOpenRecord={openRecordDetails} onOpenPlace={openLocationDetails}>
        {tab !== 'exports' && <ExportDownloadStatus status={exportStatus} download={preparedDownload} error={exportError} language={language} />}
        {tab === 'projects' && <WorkflowProjects legacy={<InventoryProjectsPanel state={state} language={language} loading={loading}
          onMutation={(path, body, method) => apiMutation(`/api/inventorySystem${path}`, body, method)}
          onOpenRecord={openRecordDetails} onReturn={returnAssignment} />} />}
        {['inventory', 'catalog', 'products'].includes(tab) && <nav className="inventory-catalog-navigation" aria-label={language === 'de' ? 'Artikelbereiche' : 'Article sections'}>{([{id: 'inventory', en: 'Stock & places', de: 'Bestand & Orte'}, {id: 'catalog', en: 'Parts & materials', de: 'Teile & Material'}, {id: 'products', en: 'Products & parts lists', de: 'Produkte & Stücklisten'}] as const).map(item => <button type="button" className="secondary-action" key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => navigateToTab(item.id)}>{language === 'de' ? item.de : item.en}</button>)}</nav>}
        {tab === 'products' && <WorkflowProducts />}
        {tab === 'requests' && <WorkflowRequests />}
        {tab === 'overview' && <WorkflowHome onNavigate={navigateToTab} />}
        {isInventoryMobileBuild && tab === 'overview' && (
          <OverviewPanel
            items={state.items}
            records={openOrderRecords}
            allRecords={state.records}
            lowStockItems={lowStockItems}
            itemsById={itemsById}
            locationsById={locationsById}
            totalsByItemId={totalsByItemId}
            onNavigate={navigateToTab}
            onOpenItem={openItemDetails}
            onOpenRecord={openRecordDetails}
          />
        )}

        {tab === 'inventory' && selectedRecord && !isInventoryMobileBuild ? (
          <RecordDetailPage
            activeAssignments={activeAssignmentsByRecordId.get(selectedRecord.id) ?? []}
            item={itemsById.get(selectedRecord.itemId)}
            location={locationsById.get(selectedRecord.locationId)}
            record={selectedRecord}
            tags={tagsForRecord(selectedRecord, itemsById.get(selectedRecord.itemId), recordTagIds, categoryTagIds, tagsById)}
            usersById={usersById}
            onBack={() => navigateToTab('inventory')}
            onEdit={() => {
              setEditingRecordId(selectedRecord.id)
              navigateToTab('inventory')
            }}
          />
        ) : tab === 'inventory' && (
          <WorkflowStock legacyOpen={Boolean(editingRecordId)} onRoomPlan={() => navigateToTab('locations')} onCatalog={() => navigateToTab('catalog')} legacy={<InventoryPanel
            records={filteredRecords}
            items={state.items}
            locations={state.locations}
            itemsById={itemsById}
            locationsById={locationsById}
            usersById={usersById}
            activeUsers={activeUsers}
            tags={state.tags}
            tagsById={tagsById}
            categoryTagIds={categoryTagIds}
            recordTagIds={recordTagIds}
            activeAssignmentsByRecordId={activeAssignmentsByRecordId}
            search={search}
            stateFilter={stateFilter}
            locationFilter={locationFilter}
            itemFilter={itemFilter}
            categoryFilter={categoryFilter}
            categories={categories}
            groupBy={recordGroupBy}
            editingRecord={editingRecord}
            splittingRecord={splittingRecord}
            assigningRecord={assigningRecord}
            loading={loading}
            canWriteState={canWriteState}
            canAdjust={can('adjust_stock')}
            onSearch={setSearch}
            onStateFilter={setStateFilter}
            onLocationFilter={setLocationFilter}
            onItemFilter={setItemFilter}
            onCategoryFilter={setCategoryFilter}
            onGroupBy={setRecordGroupBy}
            onOpen={openRecordDetails}
            onEdit={setEditingRecordId}
            onSplit={setSplittingRecordId}
            onAssign={setAssigningRecordId}
            onCancelEdit={() => setEditingRecordId(null)}
            onCancelSplit={() => setSplittingRecordId(null)}
            onCancelAssign={() => setAssigningRecordId(null)}
            onSubmit={submitRecord}
            onSubmitSplit={submitSplitRecord}
            onSubmitAssignment={submitAssignment}
            onReturnAssignment={returnAssignment}
            onDelete={deleteRecord}
          />} />
        )}

        {visibleTabs.some(item => item.id === 'receiving') && <div hidden={tab !== 'receiving'}>
          <GoodsReceivingPanel
            key={state.currentUser.id}
            state={state}
            serverScope={inventoryApiBase}
            language={language}
            loading={loading}
            canReceive={can('receive_stock')}
            canCorrect={can('adjust_stock') || can('receive_stock')}
            onPreview={previewReceiptImport}
            onSubmit={(body) => apiMutation('/api/inventorySystem/receipts', body, 'POST')}
            onCorrect={(lineId, body) => apiMutation(`/api/inventorySystem/receipt-lines/${lineId}/correct`, body, 'POST')}
            onRelease={(lineId, body) => apiMutation(`/api/inventorySystem/receipt-lines/${lineId}/release`, body, 'POST')}
            onExport={exportReceipts}
          />
        </div>}

        {tab === 'orders' && (
          <WorkflowOrders onReceivingJournal={() => navigateToTab('receiving')} legacy={<OrdersPanel
            records={openOrderRecords}
            items={state.items}
            locations={state.locations}
            itemsById={itemsById}
            locationsById={locationsById}
            usersById={usersById}
            totalsByItemId={totalsByItemId}
            loading={loading}
            canWriteState={canWriteState}
            onOpenItem={openItemDetails}
            onOpenRecord={openRecordDetails}
            onSubmit={submitRecord}
            onQuickState={quickState}
          />} />
        )}

        {tab === 'catalog' && selectedItem && !isInventoryMobileBuild ? (
          <ItemDetailPage
            item={selectedItem}
            records={state.records.filter((record) => record.itemId === selectedItem.id)}
            locationsById={locationsById}
            totals={totalsByItemId.get(selectedItem.id)}
            onBack={() => navigateToTab('catalog')}
            onEdit={() => {
              setEditingItemId(selectedItem.id)
              navigateToTab('catalog')
            }}
            onOpenRecord={openRecordDetails}
          />
        ) : tab === 'catalog' && (
          <CatalogPanel
            items={state.items}
            records={state.records}
            categories={categories}
            tags={state.tags}
            categoryTagIds={categoryTagIds}
            totalsByItemId={totalsByItemId}
            editingItem={editingItem}
            loading={loading}
            canEdit={can('manage_catalog')}
            onOpen={openItemDetails}
            onEdit={setEditingItemId}
            onCancelEdit={() => setEditingItemId(null)}
            onSubmit={submitItem}
            onDelete={deleteItem}
            onSubmitTag={submitTag}
            onDeleteTag={deleteTag}
          />
        )}

        {tab === 'locations' && selectedLocation && !isInventoryMobileBuild ? (
          <LocationDetailPage
            location={selectedLocation}
            locations={state.locations}
            records={state.records.filter((record) => selectedLocationIds.has(record.locationId) && physicalStockStates.has(record.state))}
            itemsById={itemsById}
            onBack={() => navigateToTab('locations')}
            onEdit={() => {
              setEditingLocationId(selectedLocation.id)
              navigateToTab('locations')
            }}
            onOpenRecord={openRecordDetails}
          />
        ) : tab === 'locations' && (
          <LocationsPanel
            locations={state.locations}
            records={state.records}
            itemsById={itemsById}
            referenceRooms={state.referenceRooms}
            editingLocation={editingLocation}
            loading={loading}
            canEdit={can('manage_locations')}
            onOpen={openLocationDetails}
            onOpenRecord={openRecordDetails}
            onEdit={setEditingLocationId}
            onCancelEdit={() => setEditingLocationId(null)}
            onSubmit={submitLocation}
          />
        )}

        {tab === 'users' && (
          <UsersPanel
            users={state.users}
            coreAccountUrl={state.usersManagedByCore ? state.coreLoginUrl || coreOfficeUrl || '/' : undefined}
            editingUser={editingUser}
            loading={loading}
            canEdit={can('manage_users')}
            onEdit={setEditingUserId}
            onCancelEdit={() => setEditingUserId(null)}
            onSubmit={submitUser}
          />
        )}

        {tab === 'activity' && <ActivityPanel state={state} itemsById={itemsById} usersById={usersById} onFetchActivity={fetchActivity} />}

        {tab === 'qr' && (
          <QrPanel
            state={state}
            itemsById={itemsById}
            locationsById={locationsById}
            records={state.records}
            language={language}
            loading={loading}
            routeLabelId={routeState.targetType === 'qr-label' ? routeState.targetId : undefined}
            onSaveLabel={saveQrLabel}
            onDeactivateLabel={deactivateQrLabel}
            onApproveQrLogin={approveQrLoginChallenge}
            scanRequestId={qrScanRequestId}
            onNavigate={(path) => {
              window.history.pushState(null, '', path)
              const nextRoute = inventoryRouteState()
              setRouteState(nextRoute)
              setTab(nextRoute.tab)
            }}
          />
        )}

        {tab === 'exports' && (
          <ExportsPanel loading={loading} canExport={can('export_inventory')} onDownload={downloadExport} state={state}
            downloadStatus={<ExportDownloadStatus status={exportStatus} download={preparedDownload} error={exportError} language={language} />} />
        )}
        </InventoryWorkflowProvider></CatalogProvider>
        </InventoryClickUpProvider>
      </section>
      </div>
      </div>
    </main>
    </div>
    </InventoryProjectsContext.Provider>
    </InventoryCopyContext.Provider>
  )
}

function MobileInventoryApp({
  activeAssignmentsByRecordId,
  categoryFilter,
  categoryTagIds,
  categories,
  error,
  filteredRecords,
  inStockTotal,
  itemFilter,
  itemsById,
  language,
  loading,
  locationFilter,
  locationsById,
  lowStockItems,
  onApproveQrLogin,
  onCategoryFilter,
  onItemFilter,
  onLanguage,
  onLocationFilter,
  onLogout,
  onNavigate,
  onScan,
  onSearch,
  onStateFilter,
  onTab,
  onTheme,
  openOrderRecords,
  orderedTotal,
  qrScanRequestId,
  recordTagIds,
  requestedTotal,
  search,
  state,
  stateFilter,
  tab,
  tagsById,
  theme,
  totalsByItemId,
  usersById,
}: {
  activeAssignmentsByRecordId: Map<string, InventoryAssignment[]>
  categoryFilter: string
  categoryTagIds: Map<string, string[]>
  categories: string[]
  error: string
  filteredRecords: InventoryRecord[]
  inStockTotal: number
  itemFilter: string
  itemsById: Map<string, InventoryItemDefinition>
  language: InventoryLanguage
  loading: boolean
  locationFilter: string
  locationsById: Map<string, InventoryLocation>
  lowStockItems: InventoryItemDefinition[]
  onApproveQrLogin: (token: string) => Promise<boolean>
  onCategoryFilter: (value: string) => void
  onItemFilter: (value: string) => void
  onLanguage: (value: string) => void
  onLocationFilter: (value: string) => void
  onLogout: () => Promise<void>
  onNavigate: (path: string) => void
  onScan: () => void
  onSearch: (value: string) => void
  onStateFilter: (value: InventoryState | 'all') => void
  onTab: (tab: InventoryTab) => void
  onTheme: (theme: InventoryTheme) => void
  openOrderRecords: InventoryRecord[]
  orderedTotal: number
  qrScanRequestId: number
  recordTagIds: Map<string, string[]>
  requestedTotal: number
  search: string
  state: InventoryStatePayload
  stateFilter: InventoryState | 'all'
  tab: InventoryTab
  tagsById: Map<string, InventoryTag>
  theme: InventoryTheme
  totalsByItemId: Map<string, InventoryItemTotals>
  usersById: Map<string, InventoryUser>
}) {
  const copy = useInventoryCopy()
  const mobileTabs: Array<{ id: InventoryTab; icon: typeof BarChart3; label: string }> = [
    { id: 'overview', icon: BarChart3, label: copy.mobile.status },
    { id: 'inventory', icon: Boxes, label: copy.mobile.stock },
    { id: 'qr', icon: ScanLine, label: copy.mobile.scan },
  ]

  return (
    <main className={inventorySystemClassName('mobile-shell')}>
      <header className="mobile-app-header">
        <div className="inventory-brand">
          <span className="inventory-brand-mark">
            <DigitalCoreOfficeLogo size={22} />
          </span>
          <div>
            <h1>{copy.appName}</h1>
            <p>{state.currentUser.name}</p>
          </div>
        </div>
        <div className="mobile-header-actions">
          <select aria-label={copy.language} value={language} onChange={(event) => onLanguage(event.target.value)}>
            <option value="en">EN</option>
            <option value="de">DE</option>
          </select>
          <InventoryThemeToggle theme={theme} onTheme={onTheme} />
          <button className="icon-action" disabled={loading} title={copy.server.change} type="button" onClick={openMobileServerSetup}>
            <Settings size={18} />
          </button>
          <button className="icon-action" disabled={loading} title={copy.actions.logout} type="button" onClick={() => void onLogout()}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {error && <div className="inventory-error mobile-error">{error}</div>}

      <section className="mobile-status-hero" aria-label={copy.metrics.aria}>
        <div>
          <span>{copy.mobile.stockHealth}</span>
          <strong>{formatQuantity(inStockTotal)}</strong>
          <small>{copy.metrics.inStock}</small>
        </div>
        <button className="primary-action mobile-hero-scan" disabled={loading} type="button" onClick={onScan}>
          <ScanLine size={18} />
          {copy.mobile.pcLogin}
        </button>
      </section>

      <nav className="mobile-bottom-nav" aria-label={copy.navigation}>
        {mobileTabs.map((item) => {
          const Icon = item.icon
          return (
            <button className={tab === item.id ? 'active' : ''} key={item.id} type="button" onClick={() => onTab(item.id)}>
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <section className="mobile-content">
        {tab === 'overview' && (
          <MobileStatusPanel
            inStockTotal={inStockTotal}
            lowStockItems={lowStockItems}
            openOrderRecords={openOrderRecords}
            orderedTotal={orderedTotal}
            requestedTotal={requestedTotal}
            state={state}
            itemsById={itemsById}
            locationsById={locationsById}
            totalsByItemId={totalsByItemId}
            usersById={usersById}
            onScan={onScan}
          />
        )}

        {tab === 'inventory' && (
          <MobileStockPanel
            activeAssignmentsByRecordId={activeAssignmentsByRecordId}
            categories={categories}
            categoryFilter={categoryFilter}
            categoryTagIds={categoryTagIds}
            itemFilter={itemFilter}
            items={state.items}
            itemsById={itemsById}
            locationFilter={locationFilter}
            locations={state.locations}
            locationsById={locationsById}
            onCategoryFilter={onCategoryFilter}
            onItemFilter={onItemFilter}
            onLocationFilter={onLocationFilter}
            onSearch={onSearch}
            onStateFilter={onStateFilter}
            recordTagIds={recordTagIds}
            records={filteredRecords}
            search={search}
            stateFilter={stateFilter}
            tagsById={tagsById}
            usersById={usersById}
          />
        )}

        {tab === 'qr' && (
          <QrPanel
            state={state}
            itemsById={itemsById}
            locationsById={locationsById}
            records={state.records}
            language={language}
            loading={loading}
            onApproveQrLogin={onApproveQrLogin}
            scanRequestId={qrScanRequestId}
            onNavigate={onNavigate}
          />
        )}
      </section>
    </main>
  )
}

function MobileStatusPanel({
  inStockTotal,
  itemsById,
  locationsById,
  lowStockItems,
  onScan,
  openOrderRecords,
  orderedTotal,
  requestedTotal,
  state,
  totalsByItemId,
  usersById,
}: {
  inStockTotal: number
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  lowStockItems: InventoryItemDefinition[]
  onScan: () => void
  openOrderRecords: InventoryRecord[]
  orderedTotal: number
  requestedTotal: number
  state: InventoryStatePayload
  totalsByItemId: Map<string, InventoryItemTotals>
  usersById: Map<string, InventoryUser>
}) {
  const copy = useInventoryCopy()
  const stateCounts = inventoryStates
    .map((inventoryState) => ({
      state: inventoryState,
      quantity: state.records.filter((record) => record.state === inventoryState).reduce((total, record) => total + record.quantity, 0),
    }))
    .filter((entry) => entry.quantity > 0)
  const attentionRecords = openOrderRecords.slice(0, 5)
  const recentActivity = state.activity.slice(0, 5)

  return (
    <div className="mobile-panel-stack">
      <section className="mobile-metric-grid">
        <Metric label={copy.metrics.inStock} value={formatQuantity(inStockTotal)} />
        <Metric label={copy.metrics.ordered} value={formatQuantity(orderedTotal)} />
        <Metric label={copy.metrics.requested} value={formatQuantity(requestedTotal)} />
        <Metric label={copy.metrics.lowStock} value={String(lowStockItems.length)} tone={lowStockItems.length > 0 ? 'warning' : 'normal'} />
      </section>

      <section className="mobile-card mobile-scan-card">
        <div>
          <strong>{copy.mobile.pcLogin}</strong>
          <span>{copy.mobile.pcLoginHint}</span>
        </div>
        <button className="primary-action" type="button" onClick={onScan}>
          <ScanLine size={16} />
          {copy.login.scanQr}
        </button>
      </section>

      <section className="mobile-card">
        <h2>{copy.mobile.stockHealth}</h2>
        <div className="mobile-state-grid">
          {stateCounts.length === 0 && <p className="muted">{copy.empty.noStockRecords}</p>}
          {stateCounts.map((entry) => (
            <div className={`mobile-state-chip state-${entry.state}`} key={entry.state}>
              <span>{copy.states[entry.state]}</span>
              <strong>{formatQuantity(entry.quantity)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="mobile-card">
        <h2>{copy.mobile.needsAttention}</h2>
        {lowStockItems.length === 0 && attentionRecords.length === 0 && <p className="muted">{copy.mobile.noAttention}</p>}
        <div className="mobile-list">
          {lowStockItems.slice(0, 4).map((item) => {
            const total = totalsByItemId.get(item.id)
            return (
              <article className="mobile-list-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.category}</span>
                </div>
                <b>{formatQuantity(total?.inStockQuantity ?? 0)} / {formatQuantity(item.minQuantity)}</b>
              </article>
            )
          })}
          {attentionRecords.map((record) => (
            <article className="mobile-list-row" key={record.id}>
              <div>
                <strong>{recordDisplayName(record, itemsById.get(record.itemId))}</strong>
                <span>{locationLabel(locationsById.get(record.locationId))}</span>
              </div>
              <b>{copy.states[record.state]}</b>
            </article>
          ))}
        </div>
      </section>

      <section className="mobile-card">
        <h2>{copy.mobile.recentActivity}</h2>
        {recentActivity.length === 0 && <p className="muted">{copy.mobile.noRecentActivity}</p>}
        <div className="mobile-list">
          {recentActivity.map((entry) => (
            <article className="mobile-list-row" key={entry.id}>
              <div>
                <strong>{entry.action.replace(/_/g, ' ')}</strong>
                <span>{usersById.get(entry.actorId)?.name ?? entry.actorId}</span>
              </div>
              <time>{formatDateTime(entry.createdAt)}</time>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function MobileStockPanel({
  activeAssignmentsByRecordId,
  categories,
  categoryFilter,
  categoryTagIds,
  itemFilter,
  items,
  itemsById,
  locationFilter,
  locations,
  locationsById,
  onCategoryFilter,
  onItemFilter,
  onLocationFilter,
  onSearch,
  onStateFilter,
  recordTagIds,
  records,
  search,
  stateFilter,
  tagsById,
  usersById,
}: {
  activeAssignmentsByRecordId: Map<string, InventoryAssignment[]>
  categories: string[]
  categoryFilter: string
  categoryTagIds: Map<string, string[]>
  itemFilter: string
  items: InventoryItemDefinition[]
  itemsById: Map<string, InventoryItemDefinition>
  locationFilter: string
  locations: InventoryLocation[]
  locationsById: Map<string, InventoryLocation>
  onCategoryFilter: (value: string) => void
  onItemFilter: (value: string) => void
  onLocationFilter: (value: string) => void
  onSearch: (value: string) => void
  onStateFilter: (value: InventoryState | 'all') => void
  recordTagIds: Map<string, string[]>
  records: InventoryRecord[]
  search: string
  stateFilter: InventoryState | 'all'
  tagsById: Map<string, InventoryTag>
  usersById: Map<string, InventoryUser>
}) {
  const copy = useInventoryCopy()

  return (
    <section className="mobile-card mobile-stock-panel">
      <h2>{copy.mobile.stock}</h2>
      <div className="mobile-stock-filters">
        <input placeholder={copy.filters.searchPlaceholder} value={search} onChange={(event) => onSearch(event.target.value)} />
        <select value={stateFilter} onChange={(event) => onStateFilter(event.target.value as InventoryState | 'all')}>
          <option value="all">{copy.filters.allStates}</option>
          {inventoryStates.map((stateOption) => (
            <option key={stateOption} value={stateOption}>
              {copy.states[stateOption]}
            </option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(event) => onCategoryFilter(event.target.value)}>
          <option value="all">{copy.filters.allCategories}</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <select value={locationFilter} onChange={(event) => onLocationFilter(event.target.value)}>
          <option value="all">{copy.filters.allPlaces}</option>
          <LocationOptions locations={locations} />
        </select>
        <select value={itemFilter} onChange={(event) => onItemFilter(event.target.value)}>
          <option value="all">{copy.filters.allItems}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {itemOptionLabel(item)}
            </option>
          ))}
        </select>
      </div>

      <div className="mobile-stock-list">
        {records.length === 0 && <p className="muted">{copy.empty.noStockRecords}</p>}
        {records.slice(0, 80).map((record) => {
          const item = itemsById.get(record.itemId)
          const location = locationsById.get(record.locationId)
          const holderNames = (activeAssignmentsByRecordId.get(record.id) ?? [])
            .map((assignment) => usersById.get(assignment.userId)?.name)
            .filter(Boolean)
          const tagLabels = tagsForRecord(record, item, recordTagIds, categoryTagIds, tagsById).map((tag) => tag.name)
          return (
            <article className="mobile-stock-card" key={record.id}>
              {record.photoPath && <img className="inventory-record-thumb mobile" alt="" loading="lazy" src={inventoryAssetUrl(record.photoPath)} />}
              <div className="mobile-stock-main">
                <strong>{recordDisplayName(record, item)}</strong>
                <span>{item?.category ?? ''}</span>
              </div>
              <div className="mobile-stock-meta">
                <span>{record.quantityLabel || formatQuantity(record.quantity)} {item?.unit ?? ''}</span>
                <span>{locationLabel(location)}</span>
              </div>
              <div className="mobile-stock-footer">
                <span className={`state-pill state-${record.state}`}>{copy.states[record.state]}</span>
                {holderNames.length > 0 && <span>{copy.table.holder}: {holderNames.join(', ')}</span>}
              </div>
              {(record.serialNumber || record.assetTag || tagLabels.length > 0) && (
                <small>
                  {[record.serialNumber, record.assetTag, ...tagLabels].filter(Boolean).join(' · ')}
                </small>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function LoginScreen({
  error,
  language,
  loading,
  theme,
  onLanguage,
  onLogin,
  onQrLoginClaimed,
  onTheme,
}: {
  error: string
  language: InventoryLanguage
  loading: boolean
  theme: InventoryTheme
  onLanguage: (value: string) => void
  onLogin: (email: string, password: string, stayLoggedIn: boolean) => Promise<boolean>
  onQrLoginClaimed: (payload: InventoryStatePayload) => void
  onTheme: (theme: InventoryTheme) => void
}) {
  const copy = useInventoryCopy()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [stayLoggedIn, setStayLoggedIn] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const signedIn = await onLogin(email, password, stayLoggedIn)
    if (signedIn) {
      setPassword('')
    }
  }

  return (
    <main className={inventorySystemClassName('auth-screen')}>
      <section className="auth-panel">
        <div className="inventory-brand auth-brand">
          <span className="inventory-brand-mark">
            <DigitalCoreOfficeLogo size={24} />
          </span>
          <div>
            <h1>{copy.appName}</h1>
            <p>{copy.login.title}</p>
          </div>
        </div>

        {error && <div className="inventory-error">{error}</div>}

        {isInventoryMobileBuild && (
          <button className="mobile-current-server" type="button" onClick={openMobileServerSetup}>
            <span>
              <small>{copy.server.current}</small>
              <strong>{mobileServerDisplayName(inventoryApiBase)}</strong>
            </span>
            <span className="mobile-current-server-action">
              <Settings size={16} />
              {copy.server.change}
            </span>
          </button>
        )}

        {!isInventoryMobileBuild && coreOfficeUrl && (
          <a className="secondary-action" href={coreOfficeUrl}>
            <LayoutGrid size={16} />
            Digital Core Office SSO
          </a>
        )}

        <form className="auth-form" onSubmit={submit}>
          <label>
            {copy.login.email}
            <input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            {copy.login.password}
            <PasswordInput aria-label={copy.login.password} language={language}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="login-stay-row">
            <input checked={stayLoggedIn} type="checkbox" onChange={(event) => setStayLoggedIn(event.target.checked)} />
            <span>{copy.login.stayLoggedIn}</span>
          </label>
          <button className="primary-action" disabled={loading || !email || !password} type="submit">
            <LogIn size={16} />
            {copy.login.submit}
          </button>
          {!isInventoryMobileBuild && (
            <a className="forgot-password-link" href={coreOfficeUrl || `${timeTrackingUrl}/?forgot=1${email ? `&email=${encodeURIComponent(email)}` : ''}`}>
              {copy.login.forgotPasswordReset}
            </a>
          )}
        </form>

        {!isInventoryMobileBuild && (
          <a className="secondary-action mobile-web-download-link" download href={inventoryAndroidApkHref}>
            <Download size={16} />
            {copy.login.downloadAndroidApp}
          </a>
        )}

        {!isInventoryMobileBuild && <LoginQrChallenge onClaimed={onQrLoginClaimed} />}

        <div className="auth-preferences">
          <label className="auth-language">
            {copy.language}
            <select value={language} onChange={(event) => onLanguage(event.target.value)}>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
          <InventoryThemeToggle theme={theme} onTheme={onTheme} />
        </div>
      </section>
    </main>
  )
}

function LoginQrChallenge({ onClaimed }: { onClaimed: (payload: InventoryStatePayload) => void }) {
  const copy = useInventoryCopy()
  const [token, setToken] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [localError, setLocalError] = useState('')
  const [status, setStatus] = useState(copy.form.qrLoginWaiting)

  const createChallenge = useCallback(async () => {
    setLocalError('')
    setQrImage('')
    setToken('')
    setExpiresAt('')
    setStatus(copy.form.qrLoginWaiting)
    try {
      const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/qr-login/challenges`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ message: copy.login.failed }))) as ApiError
        throw new Error(payload.message)
      }
      const payload = (await response.json()) as { token: string; expiresAt: string }
      setToken(payload.token)
      setExpiresAt(payload.expiresAt)
      setQrImage(await QRCode.toDataURL(payload.token, { margin: 1, width: 280 }))
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : copy.login.failed)
    }
  }, [copy.form.qrLoginWaiting, copy.login.failed])

  useEffect(() => {
    void createChallenge()
  }, [createChallenge])

  useEffect(() => {
    if (!token) return undefined
    let stopped = false
    let timer: number | undefined

    async function poll() {
      try {
        const response = await fetch(`${inventoryApiBase}/api/inventorySystem/auth/qr-login/challenges/claim`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        if (stopped) return
        if (response.status === 202) {
          timer = window.setTimeout(poll, 1500)
          return
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({ message: copy.login.failed }))) as ApiError
          throw new Error(payload.message)
        }
        const payload = (await response.json()) as InventoryStatePayload
        setStatus(copy.form.qrLoginApproved)
        onClaimed(payload)
      } catch (error) {
        if (!stopped) {
          setLocalError(error instanceof Error ? error.message : copy.login.failed)
        }
      }
    }

    timer = window.setTimeout(poll, 1000)
    return () => {
      stopped = true
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [copy.form.qrLoginApproved, copy.login.failed, onClaimed, token])

  return (
    <section className="auth-qr-login">
      <div className="inventory-panel-title auth-qr-title">
        <QrCode size={16} />
        <h2>{copy.form.loginQr}</h2>
      </div>
      <div className="qr-form auth-qr-form">
        {qrImage && (
          <div className="qr-output auth-qr-output">
            <img alt="" src={qrImage} />
          </div>
        )}
        <small className="auth-qr-status">{status}{expiresAt ? ` · ${formatDateTime(expiresAt)}` : ''}</small>
        <button className="secondary-action" type="button" onClick={() => void createChallenge()}>
          <RefreshCcw size={16} />
          {copy.refresh}
        </button>
        {localError && <div className="inline-error auth-inline-error">{localError}</div>}
      </div>
    </section>
  )
}

function PasswordChangeScreen({
  error,
  language,
  loading,
  theme,
  onChangePassword,
  onLanguage,
  onLogout,
  onTheme,
}: {
  error: string
  language: InventoryLanguage
  loading: boolean
  theme: InventoryTheme
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<boolean>
  onLanguage: (value: string) => void
  onLogout: () => Promise<void>
  onTheme: (theme: InventoryTheme) => void
}) {
  const copy = useInventoryCopy()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLocalError('')
    if (newPassword !== confirmPassword) {
      setLocalError(copy.account.passwordMismatch)
      return
    }
    const changed = await onChangePassword(currentPassword, newPassword)
    if (changed) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    }
  }

  return (
    <main className={inventorySystemClassName('auth-screen')}>
      <section className="auth-panel">
        <div className="inventory-brand auth-brand">
          <span className="inventory-brand-mark">
            <KeyRound size={24} />
          </span>
          <div>
            <h1>{copy.account.changePasswordTitle}</h1>
            <p>{copy.account.mustChangePassword}</p>
          </div>
        </div>

        {(error || localError) && <div className="inventory-error">{localError || error}</div>}

        <form className="auth-form" onSubmit={submit}>
          <label>
            {copy.account.currentPassword}
            <PasswordInput aria-label={copy.account.currentPassword} language={language}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            {copy.account.newPassword}
            <PasswordInput aria-label={copy.account.newPassword} language={language} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </label>
          <label>
            {copy.account.confirmPassword}
            <PasswordInput aria-label={copy.account.confirmPassword} language={language}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          <button className="primary-action" disabled={loading || !currentPassword || !newPassword || !confirmPassword} type="submit">
            <Check size={16} />
            {copy.account.submitPassword}
          </button>
          <button className="secondary-action" disabled={loading} type="button" onClick={() => void onLogout()}>
            <LogOut size={16} />
            {copy.actions.logout}
          </button>
        </form>

        <div className="auth-preferences">
          <label className="auth-language">
            {copy.language}
            <select value={language} onChange={(event) => onLanguage(event.target.value)}>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
          <InventoryThemeToggle theme={theme} onTheme={onTheme} />
        </div>
      </section>
    </main>
  )
}

function Metric({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'warning' }) {
  return (
    <div className={`inventory-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function OverviewPanel({
  items,
  records,
  allRecords,
  lowStockItems,
  itemsById,
  locationsById,
  totalsByItemId,
  onNavigate,
  onOpenItem,
  onOpenRecord,
}: {
  items: InventoryItemDefinition[]
  records: InventoryRecord[]
  allRecords: InventoryRecord[]
  lowStockItems: InventoryItemDefinition[]
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  totalsByItemId: Map<string, { inStockQuantity: number; orderedQuantity: number; requestedQuantity: number }>
  onNavigate: (tab: InventoryTab) => void
  onOpenItem: (id: string) => void
  onOpenRecord: (id: string) => void
}) {
  const copy = useInventoryCopy()
  const stageCounts = inventoryProcurementStates.map((state) => ({
    state,
    count: records.filter((record) => record.state === state).length,
  }))
  const recentRecords = [...allRecords]
    .filter((record) => record.state !== 'retired')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)

  return (
    <div className="overview-dashboard">
      <section className="overview-command-center inventory-panel">
        <div>
          <span className="record-detail-eyebrow">{copy.workspace.overviewEyebrow}</span>
          <h2>{copy.workspace.overviewTitle}</h2>
          <p>{copy.workspace.overviewIntro}</p>
        </div>
        <div className="overview-action-grid">
          <button type="button" onClick={() => onNavigate('orders')}>
            <ShoppingCart size={20} />
            <span><strong>{copy.workspace.procurement}</strong><small>{copy.workspace.procurementHint}</small></span>
            <b>{records.length}</b>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => onNavigate('catalog')}>
            <ClipboardList size={20} />
            <span><strong>{copy.workspace.catalog}</strong><small>{copy.workspace.catalogHint}</small></span>
            <b>{items.length}</b>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => onNavigate('locations')}>
            <MapPin size={20} />
            <span><strong>{copy.workspace.places}</strong><small>{copy.workspace.placesHint}</small></span>
            <b>{locationsById.size}</b>
            <ChevronRight size={18} />
          </button>
        </div>
      </section>

      <section className="inventory-panel overview-task-panel">
        <PanelTitle icon={<Truck size={18} />} title={copy.workspace.openTasks} />
        <div className="overview-stage-grid">
          {stageCounts.map(({ state, count }) => (
            <button key={state} type="button" onClick={() => onNavigate('orders')}>
              <span className={`state-pill state-${state}`}>{copy.states[state]}</span>
              <strong>{count}</strong>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        {records.length === 0 && <p className="dashboard-empty"><Check size={18} /> {copy.workspace.allClear}</p>}
      </section>

      <section className="inventory-panel overview-task-panel">
        <PanelTitle icon={<PackagePlus size={18} />} title={copy.panels.lowStock} />
        <p className="panel-intro">{copy.workspace.belowMinimumHint}</p>
        <div className="compact-list">
          {lowStockItems.length === 0 && <p className="muted">{copy.empty.noLowStock}</p>}
          {lowStockItems.slice(0, 8).map((item) => {
            const totals = totalsByItemId.get(item.id)
            return (
              <button className="compact-row compact-row-button" key={item.id} type="button" onClick={() => onOpenItem(item.id)}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.sku || item.category}</small>
                </div>
                <span>
                  {formatQuantity(totals?.inStockQuantity ?? 0)} / {formatQuantity(item.minQuantity)} {item.unit}
                </span>
                <ChevronRight size={16} />
              </button>
            )
          })}
        </div>
      </section>

      <section className="inventory-panel inventory-wide-panel">
        <div className="panel-title-with-action">
          <PanelTitle icon={<Boxes size={18} />} title={copy.workspace.recentStock} />
          <button className="secondary-action" type="button" onClick={() => onNavigate('inventory')}>{copy.workspace.showAll}</button>
        </div>
        <div className="recent-stock-grid">
          {recentRecords.map((record) => {
            const item = itemsById.get(record.itemId)
            return (
              <button key={record.id} type="button" onClick={() => onOpenRecord(record.id)}>
                {record.photoPath ? <img alt="" loading="lazy" src={inventoryAssetUrl(record.photoPath)} /> : <span className="recent-stock-placeholder"><Boxes size={18} /></span>}
                <span><strong>{recordDisplayName(record, item)}</strong><small>{locationLabel(locationsById.get(record.locationId))}</small></span>
                <span className={`state-pill state-${record.state}`}>{copy.states[record.state]}</span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function InventoryPanel({
  records,
  items,
  locations,
  itemsById,
  locationsById,
  usersById,
  activeUsers,
  tags,
  tagsById,
  categoryTagIds,
  recordTagIds,
  activeAssignmentsByRecordId,
  search,
  stateFilter,
  locationFilter,
  itemFilter,
  categoryFilter,
  categories,
  groupBy,
  editingRecord,
  splittingRecord,
  assigningRecord,
  loading,
  canWriteState,
  canAdjust,
  onSearch,
  onStateFilter,
  onLocationFilter,
  onItemFilter,
  onCategoryFilter,
  onGroupBy,
  onOpen,
  onEdit,
  onSplit,
  onAssign,
  onCancelEdit,
  onCancelSplit,
  onCancelAssign,
  onSubmit,
  onSubmitSplit,
  onSubmitAssignment,
  onReturnAssignment,
  onDelete,
}: {
  records: InventoryRecord[]
  items: InventoryItemDefinition[]
  locations: InventoryLocation[]
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  usersById: Map<string, InventoryUser>
  activeUsers: InventoryUser[]
  tags: InventoryTag[]
  tagsById: Map<string, InventoryTag>
  categoryTagIds: Map<string, string[]>
  recordTagIds: Map<string, string[]>
  activeAssignmentsByRecordId: Map<string, InventoryAssignment[]>
  search: string
  stateFilter: InventoryState | 'all'
  locationFilter: string
  itemFilter: string
  categoryFilter: string
  categories: string[]
  groupBy: RecordGroupBy
  editingRecord?: InventoryRecord
  splittingRecord?: InventoryRecord
  assigningRecord?: InventoryRecord
  loading: boolean
  canWriteState: (state: InventoryState) => boolean
  canAdjust: boolean
  onSearch: (value: string) => void
  onStateFilter: (value: InventoryState | 'all') => void
  onLocationFilter: (value: string) => void
  onItemFilter: (value: string) => void
  onCategoryFilter: (value: string) => void
  onGroupBy: (value: RecordGroupBy) => void
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onSplit: (id: string) => void
  onAssign: (id: string) => void
  onCancelEdit: () => void
  onCancelSplit: () => void
  onCancelAssign: () => void
  onSubmit: (recordId: string | undefined, body: Record<string, unknown>) => MutationResult
  onSubmitSplit: (recordId: string, body: Record<string, unknown>) => MutationResult
  onSubmitAssignment: (recordId: string, body: Record<string, unknown>) => MutationResult
  onReturnAssignment: (assignment: InventoryAssignment) => Promise<void>
  onDelete: (record: InventoryRecord) => Promise<void>
}) {
  const copy = useInventoryCopy()
  const [showCreateRecord, setShowCreateRecord] = useState(false)
  const activeWorkflow = Boolean(assigningRecord || splittingRecord || editingRecord || showCreateRecord)
  const workflowRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!activeWorkflow) return
    window.requestAnimationFrame(() => workflowRef.current?.scrollIntoView({ block: 'start' }))
  }, [activeWorkflow, assigningRecord?.id, editingRecord?.id, splittingRecord?.id])

  async function submitRecord(recordId: string | undefined, body: Record<string, unknown>) {
    const saved = await onSubmit(recordId, body)
    if (saved && !recordId) setShowCreateRecord(false)
    return saved
  }

  function startCreateRecord() {
    onCancelEdit()
    onCancelSplit()
    onCancelAssign()
    setShowCreateRecord(true)
  }

  function closeWorkflow() {
    setShowCreateRecord(false)
    onCancelEdit()
    onCancelSplit()
    onCancelAssign()
  }

  if (activeWorkflow) {
    return (
      <div className="stock-editor-page" ref={workflowRef}>
        <div className="stock-workflow-nav">
          <button className="secondary-action" disabled={loading} type="button" onClick={closeWorkflow}>
            <ArrowLeft size={16} /> {copy.details.back}
          </button>
          <div>
            <span className="record-detail-eyebrow">{copy.tabs.inventory}</span>
            <strong>{editingRecord ? recordDisplayName(editingRecord, itemsById.get(editingRecord.itemId)) : assigningRecord ? recordDisplayName(assigningRecord, itemsById.get(assigningRecord.itemId)) : splittingRecord ? recordDisplayName(splittingRecord, itemsById.get(splittingRecord.itemId)) : copy.workspace.addStock}</strong>
          </div>
        </div>
        {assigningRecord ? (
          <AssignmentForm
            key={assigningRecord.id}
            record={assigningRecord}
            item={itemsById.get(assigningRecord.itemId)}
            users={activeUsers}
            activeAssignments={activeAssignmentsByRecordId.get(assigningRecord.id) ?? []}
            loading={loading}
            onCancel={closeWorkflow}
            onSubmit={onSubmitAssignment}
          />
        ) : splittingRecord ? (
          <SplitRecordForm
            key={splittingRecord.id}
            record={splittingRecord}
            item={itemsById.get(splittingRecord.itemId)}
            locations={locations}
            loading={loading}
            canWriteState={canWriteState}
            onCancel={closeWorkflow}
            onSubmit={onSubmitSplit}
          />
        ) : (
          <RecordForm
            key={editingRecord?.id ?? 'new'}
            title={editingRecord ? copy.panels.editRecord : copy.panels.newRecord}
            intro={editingRecord ? copy.workspace.stockEditIntro : copy.workspace.stockCreateIntro}
            record={editingRecord}
            defaultState="in_stock"
            items={items}
            locations={locations}
            tags={tags}
            selectedTagIds={editingRecord ? recordTagIds.get(editingRecord.id) ?? emptyStringList : emptyStringList}
            loading={loading}
            canWriteState={canWriteState}
            onCancel={closeWorkflow}
            onSubmit={submitRecord}
          />
        )}
      </div>
    )
  }

  return (
    <div className="data-workflow-page">
      <section className="inventory-panel">
        <div className="workspace-page-header workspace-page-header-compact">
          <div>
            <span className="record-detail-eyebrow">{copy.tabs.inventory}</span>
            <h2>{copy.panels.stockRecords}</h2>
            <p>{copy.workspace.stockIntro}</p>
          </div>
          <button className="primary-action" disabled={!canAdjust} type="button" onClick={startCreateRecord}>
            <PackagePlus size={17} /> {copy.workspace.addStock}
          </button>
        </div>
        <div className="inventory-filters">
          <label className="search-field">
            <Search size={16} />
            <input type="search" aria-label={copy.filters.searchPlaceholder} value={search} placeholder={copy.filters.searchPlaceholder} onChange={(event) => onSearch(event.target.value)} />
          </label>
          <label>
            {copy.filters.item}
            <select value={itemFilter} onChange={(event) => onItemFilter(event.target.value)}>
              <option value="all">{copy.filters.allItems}</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {itemOptionLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {copy.filters.category}
            <select value={categoryFilter} onChange={(event) => onCategoryFilter(event.target.value)}>
              <option value="all">{copy.filters.allCategories}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label>
            {copy.filters.state}
            <select value={stateFilter} onChange={(event) => onStateFilter(event.target.value as InventoryState | 'all')}>
              <option value="all">{copy.filters.allStates}</option>
              {inventoryStates.map((state) => (
                <option key={state} value={state}>
                  {copy.states[state]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {copy.filters.place}
            <select value={locationFilter} onChange={(event) => onLocationFilter(event.target.value)}>
              <option value="all">{copy.filters.allPlaces}</option>
              <LocationOptions locations={locations} />
            </select>
          </label>
          <label>
            {copy.filters.groupBy}
            <select value={groupBy} onChange={(event) => onGroupBy(event.target.value as RecordGroupBy)}>
              <option value="none">{copy.filters.noGrouping}</option>
              <option value="item">{copy.filters.groupByItem}</option>
              <option value="category">{copy.filters.groupByCategory}</option>
              <option value="place">{copy.filters.groupByPlace}</option>
              <option value="state">{copy.filters.groupByState}</option>
              <option value="group">{copy.filters.groupByGroup}</option>
            </select>
          </label>
        </div>
        <p className="empty-note" role="status">{copy.recordCount(records.length)}</p>
        {(search || stateFilter !== 'all' || itemFilter !== 'all' || categoryFilter !== 'all' || locationFilter !== 'all') && <button className="secondary-action" type="button" onClick={() => { onSearch(''); onStateFilter('all'); onItemFilter('all'); onCategoryFilter('all'); onLocationFilter('all') }}>{copy === inventoryTranslations.de ? 'Suche und Filter zurücksetzen' : 'Clear search and filters'}</button>}
        <RecordTable
          records={records}
          groupBy={groupBy}
          itemsById={itemsById}
          locationsById={locationsById}
          usersById={usersById}
          tagsById={tagsById}
          categoryTagIds={categoryTagIds}
          recordTagIds={recordTagIds}
          activeAssignmentsByRecordId={activeAssignmentsByRecordId}
          loading={loading}
          canAdjust={canAdjust}
          onOpen={onOpen}
          onEdit={(id) => { setShowCreateRecord(false); onEdit(id) }}
          onSplit={(id) => { setShowCreateRecord(false); onSplit(id) }}
          onAssign={(id) => { setShowCreateRecord(false); onAssign(id) }}
          onReturnAssignment={onReturnAssignment}
          onDelete={onDelete}
        />
      </section>

    </div>
  )
}

function OrdersPanel({
  records,
  items,
  locations,
  itemsById,
  locationsById,
  usersById,
  totalsByItemId,
  loading,
  canWriteState,
  onOpenItem,
  onOpenRecord,
  onSubmit,
  onQuickState,
}: {
  records: InventoryRecord[]
  items: InventoryItemDefinition[]
  locations: InventoryLocation[]
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  usersById: Map<string, InventoryUser>
  totalsByItemId: Map<string, InventoryItemTotals>
  loading: boolean
  canWriteState: (state: InventoryState) => boolean
  onOpenItem: (id: string) => void
  onOpenRecord: (id: string) => void
  onSubmit: (recordId: string | undefined, body: Record<string, unknown>) => MutationResult
  onQuickState: (record: InventoryRecord, nextState: InventoryState) => Promise<void>
}) {
  const copy = useInventoryCopy()
  const [activeStage, setActiveStage] = useState<(typeof inventoryProcurementStates)[number]>('requested')
  const [showRequestForm, setShowRequestForm] = useState(false)
  const visibleRecords = records.filter((record) => record.state === activeStage)

  async function submitRequest(recordId: string | undefined, body: Record<string, unknown>) {
    const saved = await onSubmit(recordId, body)
    if (saved) {
      setShowRequestForm(false)
      setActiveStage('requested')
    }
    return saved
  }

  return (
    <div className="procurement-page">
      <section className="inventory-panel procurement-board">
        <div className="workspace-page-header">
          <div>
            <span className="record-detail-eyebrow">{copy.workspace.procurement}</span>
            <h2>{copy.workspace.requestQueue}</h2>
            <p>{copy.workspace.procurementIntro}</p>
          </div>
          <button className="primary-action" type="button" onClick={() => setShowRequestForm((visible) => !visible)}>
            <PackagePlus size={17} />
            {showRequestForm ? copy.workspace.hideForm : copy.workspace.newRequest}
          </button>
        </div>

        <div className="procurement-stages" role="tablist" aria-label={copy.workspace.requestQueue}>
          {inventoryProcurementStates.map((state) => {
            const count = records.filter((record) => record.state === state).length
            return (
              <button
                aria-selected={activeStage === state}
                className={activeStage === state ? 'active' : ''}
                key={state}
                role="tab"
                type="button"
                onClick={() => setActiveStage(state)}
              >
                <span className={`state-pill state-${state}`}>{copy.states[state]}</span>
                <strong>{count}</strong>
              </button>
            )
          })}
        </div>

        <div className="procurement-list">
          {visibleRecords.length === 0 && <p className="dashboard-empty"><Check size={18} /> {copy.empty.noOpenRecords}</p>}
          {visibleRecords.map((record) => {
            const item = itemsById.get(record.itemId)
            const totals = totalsByItemId.get(record.itemId)
            return (
              <article className="procurement-card" key={record.id}>
                <button className="procurement-card-main" type="button" onClick={() => onOpenRecord(record.id)}>
                  {record.photoPath ? (
                    <img alt="" loading="lazy" src={inventoryAssetUrl(record.photoPath)} />
                  ) : (
                    <span className="procurement-photo-placeholder"><ShoppingCart size={20} /></span>
                  )}
                  <span className="procurement-card-copy">
                    <strong>{recordDisplayName(record, item)}</strong>
                    <small>{item?.sku || item?.category || record.itemId}</small>
                  </span>
                  <span className="procurement-quantity">{formatQuantity(record.quantity)} <small>{item?.unit ?? ''}</small></span>
                  <ChevronRight size={18} />
                </button>
                <div className="procurement-card-context">
                  <button type="button" onClick={() => onOpenItem(record.itemId)}>
                    <ClipboardList size={15} />
                    <span>{copy.workspace.currentStock}</span>
                    <strong>{formatQuantity(totals?.inStockQuantity ?? 0)} / {formatQuantity(item?.minQuantity ?? 0)} {item?.unit ?? ''}</strong>
                  </button>
                  <span><MapPin size={15} /> {locationLabel(locationsById.get(record.locationId))}</span>
                  {record.requestedBy && <span><Users size={15} /> {usersById.get(record.requestedBy)?.name ?? record.requestedBy}</span>}
                  {record.dueDate && <span><Timer size={15} /> {copy.workspace.due}: {formatDateTime(record.dueDate)}</span>}
                </div>
                <div className="procurement-card-actions">
                  <QuickStateButtons record={record} canWriteState={canWriteState} loading={loading} onQuickState={onQuickState} />
                </div>
              </article>
            )
          })}
        </div>
      </section>

      {showRequestForm && (
        <RecordForm
          title={copy.panels.requestStock}
          defaultState="requested"
          items={items}
          locations={locations}
          loading={loading}
          canWriteState={canWriteState}
          onCancel={() => setShowRequestForm(false)}
          onSubmit={submitRequest}
        />
      )}
    </div>
  )
}

function CatalogPanel({
  items,
  records,
  categories,
  tags,
  categoryTagIds,
  totalsByItemId,
  editingItem,
  loading,
  canEdit,
  onOpen,
  onEdit,
  onCancelEdit,
  onSubmit,
  onDelete,
  onSubmitTag,
  onDeleteTag,
}: {
  items: InventoryItemDefinition[]
  records: InventoryRecord[]
  categories: string[]
  tags: InventoryTag[]
  categoryTagIds: Map<string, string[]>
  totalsByItemId: Map<string, { inStockQuantity: number; belowMinimum: boolean }>
  editingItem?: InventoryItemDefinition
  loading: boolean
  canEdit: boolean
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onCancelEdit: () => void
  onSubmit: (itemId: string | undefined, body: Record<string, unknown>) => MutationResult
  onDelete: (item: InventoryItemDefinition) => Promise<void>
  onSubmitTag: (body: Record<string, unknown>) => MutationResult
  onDeleteTag: (tag: InventoryTag) => Promise<void>
}) {
  const copy = useInventoryCopy()
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [creatingItem, setCreatingItem] = useState(false)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const editingCatalog = Boolean(editingItem || creatingItem)
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const filteredItems = items.filter((item) => {
    if (category !== 'all' && item.category !== category) return false
    if (!normalizedSearch) return true
    return inventorySearchScore(normalizedSearch, [item.name, item.sku, item.category, item.description, item.manufacturer, item.model, item.value, item.packageForm, item.manufacturerPartNumber, item.lcscPartNumber]) > 0
  })

  async function submitItem(itemId: string | undefined, body: Record<string, unknown>) {
    const saved = await onSubmit(itemId, body)
    if (saved) setCreatingItem(false)
    return saved
  }

  useEffect(() => {
    if (!editingCatalog) return
    window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'start' }))
  }, [editingCatalog, editingItem?.id])

  function closeEditor() {
    setCreatingItem(false)
    onCancelEdit()
  }

  if (editingCatalog) {
    return (
      <div className="stock-editor-page" ref={editorRef}>
        <div className="stock-workflow-nav">
          <button className="secondary-action" disabled={loading} type="button" onClick={closeEditor}>
            <ArrowLeft size={16} /> {copy.details.backToCatalog}
          </button>
          <div>
            <span className="record-detail-eyebrow">{copy.workspace.catalog}</span>
            <strong>{editingItem?.name ?? copy.panels.newItem}</strong>
          </div>
        </div>
        <ItemForm
          item={editingItem}
          intro={editingItem ? copy.workspace.catalogEditIntro : copy.workspace.catalogCreateIntro}
          categories={categories}
          tags={tags}
          selectedCategoryTagIds={editingItem ? categoryTagIds.get(editingItem.category) ?? emptyStringList : emptyStringList}
          loading={loading}
          canEdit={canEdit}
          onCancel={closeEditor}
          onSubmit={submitItem}
        />
      </div>
    )
  }

  return (
    <div className="catalog-page">
      <section className="inventory-panel">
        <div className="workspace-page-header">
          <div>
            <span className="record-detail-eyebrow">{copy.workspace.catalog}</span>
            <h2>{copy.panels.itemCatalog}</h2>
            <p>{copy.workspace.catalogIntro}</p>
          </div>
          {canEdit && (
            <button className="primary-action" type="button" onClick={() => { setCreatingItem(true); onCancelEdit() }}>
              <PackagePlus size={17} /> {copy.panels.newItem}
            </button>
          )}
        </div>
        <CatalogManager />
        <div className="catalog-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input value={search} placeholder={copy.workspace.catalogSearch} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label>
            {copy.filters.category}
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">{copy.filters.allCategories}</option>
              {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
        </div>
        <div className="catalog-results-heading">
          <strong>{filteredItems.length} {copy.table.items}</strong>
          <span>{copy.workspace.clickForDetails}</span>
        </div>
        {filteredItems.length === 0 ? <p className="empty-note">{copy.empty.noCatalogItems}</p> : (
          <div className="catalog-card-grid">
            {filteredItems.map((item) => {
              const totals = totalsByItemId.get(item.id)
              const itemRecords = records.filter((record) => record.itemId === item.id && physicalStockStates.has(record.state))
              const photoRecord = itemRecords.find((record) => record.photoPath)
              const placeCount = new Set(itemRecords.map((record) => record.locationId)).size
              const modelLine = [item.manufacturer, item.manufacturerPartNumber || item.model].filter(Boolean).join(' · ') || '-'
              const detailLine = [item.value, item.lcscPartNumber, item.packageForm].filter(Boolean).join(' · ')
              return (
                <article
                  aria-label={`${item.name} - ${copy.workspace.clickForDetails}`}
                  className="catalog-card"
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(item.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      onOpen(item.id)
                    }
                  }}
                >
                  <div className="catalog-card-main">
                    <div className="catalog-card-image">
                      {(item.photoPath || photoRecord?.photoPath) ? <img alt="" loading="lazy" src={inventoryAssetUrl(item.photoPath || photoRecord?.photoPath)} /> : <Boxes size={22} />}
                    </div>
                    <div className="catalog-card-title">
                      <span>{item.category}</span>
                      <h3>{item.name}</h3>
                      <small>{item.sku || '-'}</small>
                      <TagList tags={tagsForCategory(item.category, categoryTagIds, tagsById)} />
                    </div>
                    <span className={totals?.belowMinimum ? 'status-note warning' : 'status-note'}>
                      {totals?.belowMinimum ? copy.status.low : copy.status.ok}
                    </span>
                  </div>
                  <div className="catalog-card-model">
                    <span>{copy.table.model}</span>
                    <strong>{modelLine}</strong>
                    {detailLine && <small>{detailLine}</small>}
                  </div>
                  <div className="catalog-card-footer">
                    <div className="catalog-card-stock">
                      <span>{copy.table.inStock}</span>
                      <strong>{formatQuantity(totals?.inStockQuantity ?? 0)} {item.unit}</strong>
                      <small>{copy.table.minimum}: {formatQuantity(item.minQuantity)} {item.unit}</small>
                    </div>
                    <div className="catalog-card-places">
                      <span>{copy.workspace.storagePlaces}</span>
                      <strong>{placeCount}</strong>
                    </div>
                    <div className="catalog-card-actions">
                      <button className="icon-action" disabled={!canEdit} title={copy.actions.editItem} type="button" onClick={(event) => { event.stopPropagation(); setCreatingItem(false); onEdit(item.id) }}>
                        <Edit3 size={16} />
                      </button>
                      <button className="icon-action danger" disabled={!canEdit || loading} title={copy.actions.deleteItem} type="button" onClick={(event) => { event.stopPropagation(); void onDelete(item) }}>
                        <Trash2 size={16} />
                      </button>
                      <ChevronRight aria-hidden="true" size={18} />
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {canEdit && <TagManager tags={tags} loading={loading} onDelete={onDeleteTag} onSubmit={onSubmitTag} />}
    </div>
  )
}

function LocationsPanel({
  locations,
  records,
  itemsById,
  referenceRooms,
  editingLocation,
  loading,
  canEdit,
  onOpen,
  onOpenRecord,
  onEdit,
  onCancelEdit,
  onSubmit,
}: {
  locations: InventoryLocation[]
  records: InventoryRecord[]
  itemsById: Map<string, InventoryItemDefinition>
  referenceRooms: InventoryStatePayload['referenceRooms']
  editingLocation?: InventoryLocation
  loading: boolean
  canEdit: boolean
  onOpen: (id: string) => void
  onOpenRecord: (id: string) => void
  onEdit: (id: string) => void
  onCancelEdit: () => void
  onSubmit: (locationId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const [search, setSearch] = useState('')
  const [locationView, setLocationView] = useState<'hierarchy' | 'list'>('hierarchy')
  const [kindFilter, setKindFilter] = useState<'all' | InventoryLocationKind>('all')
  const [occupancyFilter, setOccupancyFilter] = useState<'all' | 'occupied' | 'empty' | 'inactive'>('all')
  const [expandedLocationIds, setExpandedLocationIds] = useState<Set<string>>(
    () => new Set(locations.filter((location) => location.kind === 'room').map((location) => location.id)),
  )
  const [creatingLocation, setCreatingLocation] = useState(false)
  const [selectedRoomCode, setSelectedRoomCode] = useState(referenceRooms[0]?.code ?? '001')
  const [planZoom, setPlanZoom] = useState(1)
  const room = referenceRooms.find((entry) => entry.code === selectedRoomCode) ?? referenceRooms[0]
  const locationsById = useMemo(() => new Map(locations.map((location) => [location.id, location])), [locations])
  const planHotspots = useMemo(() => {
    const roomRegions = roomPlanRegions.filter((region) => region.roomCode === room?.code)
    const hotspots = roomRegions.map((region) => {
      const target = locations.find((location) =>
        location.roomCode === region.roomCode
        && location.kind === 'fixture'
        && (location.fixtureCode === region.code || location.code === `${region.roomCode}-${region.code}`),
      )
      return { key: `${region.roomCode}-${region.code}`, region, target }
    })
    const coveredCodes = new Set(roomRegions.map((region) => region.code))
    const groups = new Map<string, { key: string; region: RoomPlanRegion; target?: InventoryLocation }>()
    for (const location of locations) {
      if (
        location.roomCode !== room?.code
        || !location.planImagePath
        || location.highlightX === undefined
        || location.highlightY === undefined
      ) continue
      const parent = location.parentId ? locationsById.get(location.parentId) : undefined
      const target = parent?.kind === 'fixture' ? parent : location
      const code = location.fixtureCode || target.fixtureCode || target.code || target.id
      if (coveredCodes.has(code)) continue
      const key = `${code}:${location.highlightX}:${location.highlightY}`
      const existing = groups.get(key)
      if (!existing || (target.kind === 'fixture' && existing.target?.kind !== 'fixture')) {
        groups.set(key, {
          key,
          region: {
            roomCode: room?.code ?? location.roomCode ?? '',
            code,
            x: location.highlightX,
            y: location.highlightY,
            width: location.highlightWidth ?? 5,
            height: location.highlightHeight ?? 5,
          },
          target,
        })
      }
    }
    return [...hotspots, ...groups.values()].sort((first, second) => first.region.y - second.region.y || first.region.x - second.region.x)
  }, [locations, locationsById, room?.code])
  const [selectedPlanHotspotKey, setSelectedPlanHotspotKey] = useState<string | null>(null)
  const selectedPlanHotspot = planHotspots.find((hotspot) => hotspot.key === selectedPlanHotspotKey) ?? planHotspots.find((hotspot) => hotspot.target) ?? planHotspots[0]
  const selectedLocation = selectedPlanHotspot?.target
  const selectedLocationIds = selectedLocation ? locationDescendantIds(selectedLocation.id, locations) : new Set<string>()
  const selectedRecords = selectedLocation
    ? records.filter((record) => selectedLocationIds.has(record.locationId) && physicalStockStates.has(record.state))
    : []
  const photoRecords = selectedRecords.filter((record) => record.photoPath)
  const photoLocations = locations.filter((location) => selectedLocationIds.has(location.id) && location.photoPath)
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const stockCountsByLocation = useMemo(() => {
    const counts = new Map<string, number>()
    for (const record of records) {
      if (!physicalStockStates.has(record.state)) continue
      counts.set(record.locationId, (counts.get(record.locationId) ?? 0) + 1)
    }
    return counts
  }, [records])
  const totalStockCountsByLocation = useMemo(() => {
    const counts = new Map(locations.map((location) => [location.id, 0]))
    for (const [locationId, directCount] of stockCountsByLocation) {
      let current = locationsById.get(locationId)
      const visited = new Set<string>()
      while (current && !visited.has(current.id)) {
        visited.add(current.id)
        counts.set(current.id, (counts.get(current.id) ?? 0) + directCount)
        current = current.parentId ? locationsById.get(current.parentId) : undefined
      }
    }
    return counts
  }, [locations, locationsById, stockCountsByLocation])
  const childrenByLocation = useMemo(() => {
    const children = new Map<string, InventoryLocation[]>()
    const locationIds = new Set(locations.map((location) => location.id))
    for (const location of locations) {
      const parentId = location.parentId && locationIds.has(location.parentId) ? location.parentId : '__root__'
      const entries = children.get(parentId) ?? []
      entries.push(location)
      children.set(parentId, entries)
    }
    for (const entries of children.values()) {
      entries.sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true }) || left.name.localeCompare(right.name))
    }
    return children
  }, [locations])
  const directlyMatchingLocationIds = useMemo(() => new Set(locations.filter((location) => {
    const matchesSearch = inventorySearchScore(normalizedSearch, [
      location.code,
      location.name,
      location.area,
      location.rack,
      location.bin,
      location.roomCode,
      location.roomName,
      location.fixtureCode,
    ]) > 0
    const matchesKind = kindFilter === 'all' || location.kind === kindFilter
    const totalStock = totalStockCountsByLocation.get(location.id) ?? 0
    const matchesOccupancy = occupancyFilter === 'all'
      || (occupancyFilter === 'occupied' && totalStock > 0)
      || (occupancyFilter === 'empty' && totalStock === 0)
      || (occupancyFilter === 'inactive' && !location.active)
    return matchesSearch && matchesKind && matchesOccupancy
  }).map((location) => location.id)), [kindFilter, locations, normalizedSearch, occupancyFilter, totalStockCountsByLocation])
  const visibleLocationIds = useMemo(() => {
    const visible = new Set(directlyMatchingLocationIds)
    for (const id of directlyMatchingLocationIds) {
      let current = locationsById.get(id)
      while (current?.parentId) {
        visible.add(current.parentId)
        current = locationsById.get(current.parentId)
      }
    }
    return visible
  }, [directlyMatchingLocationIds, locationsById])
  const filteredLocations = locations.filter((location) => directlyMatchingLocationIds.has(location.id))
  const rootLocations = (childrenByLocation.get('__root__') ?? []).filter((location) => visibleLocationIds.has(location.id))
  const locationMetrics = {
    rooms: locations.filter((location) => location.kind === 'room').length,
    fixtures: locations.filter((location) => location.kind === 'fixture').length,
    containers: locations.filter((location) => location.kind === 'container').length,
    stockPositions: [...stockCountsByLocation.values()].reduce((total, count) => total + count, 0),
  }

  useEffect(() => {
    setSelectedPlanHotspotKey(null)
    setPlanZoom(1)
  }, [room?.code])

  function stockPositionCount(locationId: string) {
    const descendantIds = locationDescendantIds(locationId, locations)
    return records.filter((record) => descendantIds.has(record.locationId) && physicalStockStates.has(record.state)).length
  }

  async function submitLocation(locationId: string | undefined, body: Record<string, unknown>) {
    const saved = await onSubmit(locationId, body)
    if (saved && !locationId) setCreatingLocation(false)
    return saved
  }

  function toggleLocationBranch(locationId: string) {
    setExpandedLocationIds((current) => {
      const next = new Set(current)
      if (next.has(locationId)) next.delete(locationId)
      else next.add(locationId)
      return next
    })
  }

  function renderLocationBranch(location: InventoryLocation, depth = 0): ReactNode {
    const children = (childrenByLocation.get(location.id) ?? []).filter((child) => visibleLocationIds.has(child.id))
    const filtersActive = Boolean(normalizedSearch || kindFilter !== 'all' || occupancyFilter !== 'all')
    const expanded = children.length > 0 && (filtersActive || expandedLocationIds.has(location.id))
    const directStock = stockCountsByLocation.get(location.id) ?? 0
    const totalStock = totalStockCountsByLocation.get(location.id) ?? directStock
    const KindIcon = location.kind === 'room' ? MapPin : location.kind === 'fixture' ? LayoutGrid : Boxes

    return (
      <Fragment key={location.id}>
        <article className={`location-tree-row${directlyMatchingLocationIds.has(location.id) ? '' : ' location-tree-context'}`} style={{ paddingLeft: `${12 + depth * 28}px` }}>
          <button
            aria-label={`${expanded ? copy.workspace.collapseAll : copy.workspace.expandAll}: ${locationLabel(location)}`}
            aria-expanded={children.length > 0 ? expanded : undefined}
            className={`location-tree-toggle${expanded ? ' expanded' : ''}`}
            disabled={children.length === 0}
            type="button"
            onClick={() => toggleLocationBranch(location.id)}
          >
            <ChevronRight size={16} />
          </button>
          <button className="location-tree-main" type="button" onClick={() => onOpen(location.id)}>
            <span className={`location-kind-icon location-kind-${location.kind}`}><KindIcon size={17} /></span>
            <span>
              <strong>{locationLabel(location)}</strong>
              <small>{locationDetails(location, locations)}</small>
            </span>
          </button>
          <span className="location-tree-kind">{locationKindLabel(location.kind, copy)}</span>
          <span className="location-tree-counts" title={children.length > 0 ? copy.workspace.totalPositions : undefined}>
            <strong>{totalStock}</strong>
            <small>{copy.workspace.stockPositions}{children.length > 0 ? ` · ${children.length} ${copy.workspace.childPlaces}` : ''}</small>
            {children.length > 0 && directStock !== totalStock && <small>{directStock} {copy.workspace.directPositions}</small>}
          </span>
          <button className="icon-action" disabled={!canEdit} title={copy.actions.editPlace} type="button" onClick={() => { setCreatingLocation(false); onEdit(location.id) }}>
            <Edit3 size={16} />
          </button>
        </article>
        {expanded && children.map((child) => renderLocationBranch(child, depth + 1))}
      </Fragment>
    )
  }

  return (
    <div className="data-workflow-page">
      <section className="inventory-panel">
        <div className="workspace-page-header workspace-page-header-compact">
          <div>
            <span className="record-detail-eyebrow">{copy.tabs.locations}</span>
            <h2>{copy.workspace.placeList}</h2>
            <p>{copy.workspace.placesAdminIntro}</p>
          </div>
          <button className="primary-action" disabled={!canEdit} type="button" onClick={() => { onCancelEdit(); setCreatingLocation(true) }}>
            <MapPin size={17} /> {copy.workspace.addPlace}
          </button>
        </div>
        <div className="location-directory-metrics" aria-label={copy.workspace.placeList}>
          <article><MapPin size={18} /><span><strong>{locationMetrics.rooms}</strong><small>{copy.workspace.rooms}</small></span></article>
          <article><LayoutGrid size={18} /><span><strong>{locationMetrics.fixtures}</strong><small>{copy.workspace.fixtures}</small></span></article>
          <article><Boxes size={18} /><span><strong>{locationMetrics.containers}</strong><small>{copy.workspace.containers}</small></span></article>
          <article><ClipboardList size={18} /><span><strong>{locationMetrics.stockPositions}</strong><small>{copy.workspace.stockPositions}</small></span></article>
        </div>
        {room && (
          <details className="location-plan-disclosure">
            <summary>
              <span><LayoutGrid size={18} /><span><strong>{copy.workspace.roomPlan}</strong><small>{room.code} · {room.name}</small></span></span>
              <span>{copy.workspace.showRoomPlan}<ChevronRight size={17} /></span>
            </summary>
            <div className="location-visual-browser">
            <div className="location-visual-toolbar">
              <div>
                <span className="eyebrow">Raumplan &amp; Beschriftung</span>
                <h3>{room.code} · {room.name}</h3>
              </div>
              <label>
                Raum
                <select value={room.code} onChange={(event) => setSelectedRoomCode(event.target.value)}>
                  {referenceRooms.map((entry) => <option key={entry.code} value={entry.code}>{entry.code} · {entry.name}</option>)}
                </select>
              </label>
              <div className="floorplan-zoom-controls" aria-label="Zoom">
                <button disabled={planZoom <= 1} title="Verkleinern" type="button" onClick={() => setPlanZoom((zoom) => Math.max(1, zoom - 0.25))}><ZoomOut size={16} /></button>
                <span>{Math.round(planZoom * 100)}%</span>
                <button disabled={planZoom >= 2} title="Vergrößern" type="button" onClick={() => setPlanZoom((zoom) => Math.min(2, zoom + 0.25))}><ZoomIn size={16} /></button>
              </div>
            </div>
            <div className="location-visual-grid">
              <div className="interactive-floorplan-scroll">
                <div className="floorplan-stage interactive-floorplan" style={{ width: `${planZoom * 100}%` }}>
                  <img alt={`Grundriss ${room.code} ${room.name}`} src={inventoryAssetUrl(room.planImagePath)} />
                  {planHotspots.map((hotspot) => {
                    const count = hotspot.target ? stockPositionCount(hotspot.target.id) : 0
                    const label = hotspot.region.code
                    return (
                      <button
                        aria-label={`${label}, ${hotspot.target ? `${count} Bestandspositionen` : 'noch nicht als Ort erfasst'}`}
                        aria-pressed={selectedPlanHotspot?.key === hotspot.key}
                        className={`floorplan-hotspot${selectedPlanHotspot?.key === hotspot.key ? ' active' : ''}${hotspot.target ? '' : ' unmapped'}`}
                        key={hotspot.key}
                        style={{
                          left: `${hotspot.region.x}%`,
                          top: `${hotspot.region.y}%`,
                          width: `${hotspot.region.width}%`,
                          height: `${hotspot.region.height}%`,
                        }}
                        title={hotspot.target ? `${locationLabel(hotspot.target)} · ${count} Bestandspositionen` : `${label} · noch nicht als Ort erfasst`}
                        type="button"
                        onClick={() => setSelectedPlanHotspotKey(hotspot.key)}
                      >
                        <span>{label}</span>
                        <small>{hotspot.target ? count : '–'}</small>
                      </button>
                    )
                  })}
                  {planHotspots.length === 0 && <div className="floorplan-empty-overlay">Für diesen Raum sind noch keine klickbaren Orte zugeordnet.</div>}
                </div>
              </div>
              <aside className="location-photo-panel">
                {selectedPlanHotspot ? selectedLocation ? (
                  <>
                    <span className="location-code-badge">{selectedLocation.code || selectedLocation.fixtureCode || locationKindLabel(selectedLocation.kind, copy)}</span>
                    <h3>{selectedLocation.name}</h3>
                    <p>{selectedRecords.length} Bestandspositionen · {locationKindLabel(selectedLocation.kind, copy)}</p>
                    <div className="location-photo-grid">
                      {photoLocations.slice(0, 6).map((location) => (
                        <button key={location.id} type="button" onClick={() => onOpen(location.id)}>
                          <img alt={location.name} loading="lazy" src={inventoryAssetUrl(location.photoPath)} />
                          <span>{locationLabel(location)}</span>
                        </button>
                      ))}
                      {photoRecords.slice(0, Math.max(0, 6 - photoLocations.length)).map((record) => (
                        <button className={record.photoVerified ? 'photo-verified' : ''} key={record.id} type="button" onClick={() => onOpenRecord(record.id)}>
                          <img alt={itemsById.get(record.itemId)?.name ?? record.label ?? 'Bestandsfoto'} loading="lazy" src={inventoryAssetUrl(record.photoPath)} />
                          <span>{itemsById.get(record.itemId)?.name ?? record.label}</span>
                        </button>
                      ))}
                    </div>
                    {photoLocations.length === 0 && photoRecords.length === 0 && <p className="muted">Für diesen Platz ist noch kein Foto hinterlegt.</p>}
                    {photoLocations.length + photoRecords.length > 6 && <small>+ {photoLocations.length + photoRecords.length - 6} weitere Fotos</small>}
                    <button className="secondary-action location-open-detail" type="button" onClick={() => onOpen(selectedLocation.id)}>
                      {copy.workspace.clickForDetails} <ChevronRight size={16} />
                    </button>
                  </>
                ) : (
                  <div className="floorplan-unmapped-detail">
                    <span className="location-code-badge">{selectedPlanHotspot.region.code}</span>
                    <h3>{selectedPlanHotspot.region.code}</h3>
                    <p>Dieser Bereich ist im Raumplan beschriftet, aber noch nicht als Ort im Inventarsystem angelegt.</p>
                    {canEdit && <button className="secondary-action location-open-detail" type="button" onClick={() => { onCancelEdit(); setCreatingLocation(true) }}><MapPin size={16} /> {copy.workspace.addPlace}</button>}
                  </div>
                ) : <p className="muted">Für diesen Raum sind noch keine Planbereiche hinterlegt.</p>}
              </aside>
            </div>
            {planHotspots.length > 0 && (
              <div className="location-chip-list" aria-label="Plätze im Raum">
                {planHotspots.map(({ key, target: location, region }) => (
                  <button
                    className={selectedPlanHotspot?.key === key ? 'active' : ''}
                    key={key}
                    type="button"
                    onClick={() => setSelectedPlanHotspotKey(key)}
                  >
                    <strong>{region.code}</strong>
                    <span>{location ? stockPositionCount(location.id) : '–'}</span>
                  </button>
                ))}
              </div>
            )}
            </div>
          </details>
        )}
        <div className="location-directory-toolbar">
          <div className="location-view-switch" role="group" aria-label={copy.workspace.placeList}>
            <button className={locationView === 'hierarchy' ? 'active' : ''} type="button" onClick={() => setLocationView('hierarchy')}><LayoutGrid size={16} />{copy.workspace.locationHierarchy}</button>
            <button className={locationView === 'list' ? 'active' : ''} type="button" onClick={() => setLocationView('list')}><ClipboardList size={16} />{copy.workspace.locationList}</button>
          </div>
          <label className="search-field location-directory-search">
            <Search size={16} />
            <input value={search} placeholder={copy.workspace.locationSearch} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label>
            <span className="sr-only">{copy.workspace.allLocationKinds}</span>
            <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as 'all' | InventoryLocationKind)}>
              <option value="all">{copy.workspace.allLocationKinds}</option>
              <option value="room">{copy.workspace.rooms}</option>
              <option value="fixture">{copy.workspace.fixtures}</option>
              <option value="container">{copy.workspace.containers}</option>
            </select>
          </label>
          <label>
            <span className="sr-only">{copy.workspace.allOccupancy}</span>
            <select value={occupancyFilter} onChange={(event) => setOccupancyFilter(event.target.value as 'all' | 'occupied' | 'empty' | 'inactive')}>
              <option value="all">{copy.workspace.allOccupancy}</option>
              <option value="occupied">{copy.workspace.occupiedPlaces}</option>
              <option value="empty">{copy.workspace.emptyPlaces}</option>
              <option value="inactive">{copy.workspace.inactivePlaces}</option>
            </select>
          </label>
          {locationView === 'hierarchy' && locations.length > 0 && (
            <div className="location-expand-actions">
              <button type="button" onClick={() => setExpandedLocationIds(new Set(locations.filter((location) => location.kind !== 'container').map((location) => location.id)))}>{copy.workspace.expandAll}</button>
              <button type="button" onClick={() => setExpandedLocationIds(new Set())}>{copy.workspace.collapseAll}</button>
            </div>
          )}
        </div>
        <div className={locationView === 'hierarchy' ? 'location-tree' : 'compact-list location-flat-list'}>
          {locations.length === 0 && <p className="muted">{copy.empty.noPlaces}</p>}
          {locations.length > 0 && filteredLocations.length === 0 && <p className="location-directory-empty">{copy.workspace.noMatchingPlaces}</p>}
          {locationView === 'hierarchy' && rootLocations.map((location) => renderLocationBranch(location))}
          {locationView === 'list' && filteredLocations.map((location) => (
            <article className="compact-row location-row-clickable" key={location.id}>
              <button className="location-flat-main" type="button" onClick={() => onOpen(location.id)}>
                <strong>{locationLabel(location)}</strong>
                <small>{locationDetails(location, locations)}</small>
              </button>
              <span className="location-tree-kind">{locationKindLabel(location.kind, copy)}</span>
              <span>{stockCountsByLocation.get(location.id) ?? 0} {copy.workspace.stockPositions}</span>
              <button className="icon-action" disabled={!canEdit} title={copy.actions.editPlace} type="button" onClick={() => { setCreatingLocation(false); onEdit(location.id) }}>
                <Edit3 size={16} />
              </button>
            </article>
          ))}
        </div>
      </section>

      {(editingLocation || creatingLocation) && (
        <LocationForm
          location={editingLocation}
          locations={locations}
          loading={loading}
          canEdit={canEdit}
          onCancel={() => { setCreatingLocation(false); onCancelEdit() }}
          onSubmit={submitLocation}
        />
      )}
    </div>
  )
}

function UsersPanel({
  users,
  coreAccountUrl,
  editingUser,
  loading,
  canEdit,
  onEdit,
  onCancelEdit,
  onSubmit,
}: {
  users: InventoryUser[]
  coreAccountUrl?: string
  editingUser?: InventoryUser
  loading: boolean
  canEdit: boolean
  onEdit: (id: string) => void
  onCancelEdit: () => void
  onSubmit: (userId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const [creatingUser, setCreatingUser] = useState(false)

  if (coreAccountUrl) {
    return <SuiteAdminLink title={copy.panels.users} description={copy.admin.accountsDescription} label={copy.admin.accountsLink} href={coreAccountUrl.replace(/#.*$/, '') + '#users'} />
  }

  async function submitUser(userId: string | undefined, body: Record<string, unknown>) {
    const saved = await onSubmit(userId, body)
    if (saved && !userId) setCreatingUser(false)
    return saved
  }

  return (
    <div className="data-workflow-page">
      <section className="inventory-panel">
        <div className="workspace-page-header workspace-page-header-compact">
          <div>
            <span className="record-detail-eyebrow">{copy.tabs.users}</span>
            <h2>{copy.panels.users}</h2>
            <p>{copy.workspace.usersIntro}</p>
          </div>
          <button className="primary-action" disabled={!canEdit} type="button" onClick={() => { onCancelEdit(); setCreatingUser(true) }}>
            <Users size={17} /> {copy.workspace.addUser}
          </button>
        </div>
        <div className="compact-list">
          {users.map((user) => (
            <article className="compact-row" key={user.id}>
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </div>
              <span className={`role-pill role-${user.role}`}>{copy.roles[user.role]}</span>
              <span className={user.active ? 'status-note' : 'status-note muted-state'}>
                {user.active ? copy.status.active : copy.status.inactive}
              </span>
              {user.mustChangePassword && <span className="status-note muted-state">{copy.status.passwordChange}</span>}
              <button className="icon-action" disabled={!canEdit} title={copy.actions.editUser} type="button" onClick={() => { setCreatingUser(false); onEdit(user.id) }}>
                <Edit3 size={16} />
              </button>
            </article>
          ))}
        </div>
      </section>

      {(editingUser || creatingUser) && (
        <UserForm
          user={editingUser}
          loading={loading}
          canEdit={canEdit}
          onCancel={() => { setCreatingUser(false); onCancelEdit() }}
          onSubmit={submitUser}
        />
      )}
    </div>
  )
}

function ActivityPanel({
  state,
  itemsById,
  usersById,
  onFetchActivity,
}: {
  state: InventoryStatePayload
  itemsById: Map<string, InventoryItemDefinition>
  usersById: Map<string, InventoryUser>
  onFetchActivity: (range: ActivityRange) => Promise<InventoryActivity[]>
}) {
  const copy = useInventoryCopy()
  const [range, setRange] = useState<ActivityRange>(() => monthRangeForDate(new Date()))
  const [activity, setActivity] = useState<InventoryActivity[]>(state.activity)
  const [loading, setLoading] = useState(false)
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    setActivity(state.activity)
  }, [state.activity])

  async function loadRange(nextRange: ActivityRange) {
    setRange(nextRange)
    setLoading(true)
    setLocalError('')
    try {
      setActivity(await onFetchActivity(nextRange))
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : copy.loadFailed)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="inventory-panel">
      <PanelTitle icon={<Shield size={18} />} title={copy.panels.activity} />
      <div className="activity-controls">
        <div className="quick-actions">
          <button className="secondary-action" disabled={loading} type="button" onClick={() => void loadRange(dayRangeForDate(new Date()))}>
            {copy.actions.quickDay}
          </button>
          <button className="secondary-action" disabled={loading} type="button" onClick={() => void loadRange(weekRangeForDate(new Date()))}>
            {copy.actions.quickWeek}
          </button>
          <button className="secondary-action" disabled={loading} type="button" onClick={() => void loadRange(monthRangeForDate(new Date()))}>
            {copy.actions.quickMonth}
          </button>
        </div>
        <label>
          {copy.form.from}
          <input type="date" value={range.from} onChange={(event) => setRange({ ...range, from: event.target.value })} />
        </label>
        <label>
          {copy.form.to}
          <input type="date" value={range.to} onChange={(event) => setRange({ ...range, to: event.target.value })} />
        </label>
        <button className="primary-action" disabled={loading || !range.from || !range.to} type="button" onClick={() => void loadRange(range)}>
          <RefreshCcw size={16} />
          {copy.refresh}
        </button>
      </div>
      {localError && <div className="inline-error">{localError}</div>}
      <div className="activity-list">
        {activity.length === 0 && <p className="muted">{copy.empty.noActivity}</p>}
        {activity.map((entry) => (
          <article className="activity-row" key={entry.id}>
            <time>{formatDateTime(entry.createdAt)}</time>
            <strong>{entry.action.replace(/_/g, ' ')}</strong>
            <span>{usersById.get(entry.actorId)?.name ?? entry.actorId}</span>
            <small>{entry.itemId ? `${itemsById.get(entry.itemId)?.name ?? entry.itemId} · ${compactDetails(entry.details)}` : compactDetails(entry.details)}</small>
          </article>
        ))}
      </div>
      {state.recordEvents.length > 0 && (
        <div className="record-event-ledger">
          <h3>{copy.admin.ledger}</h3>
          <div className="table-scroll">
            <table className="inventory-table dco-responsive-table audit-table">
              <thead><tr><th>{copy.table.item}</th><th>{copy.table.updated}</th><th>{copy.admin.event}</th><th>{copy.table.holder}</th><th>{copy.admin.changes}</th><th>{copy.form.notes}</th></tr></thead>
              <tbody>{state.recordEvents.map((event) => <tr key={event.id}>
                <td data-label={copy.table.item}><strong>{itemsById.get(event.itemId)?.name ?? event.itemId}</strong><details><summary>{copy.admin.details}</summary><small>{event.recordId}</small></details></td>
                <td data-label={copy.table.updated}><time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time></td>
                <td data-label={copy.admin.event}>{copy.admin.events[event.eventType]}</td>
                <td data-label={copy.table.holder}>{event.actorId ? usersById.get(event.actorId)?.name ?? event.actorLabel ?? event.actorId : event.actorLabel ?? '—'}</td>
                <td data-label={copy.admin.changes}><small>{auditDetails(event.before ?? {}, copy)}</small><strong>→ {auditDetails(event.after ?? {}, copy)}</strong></td>
                <td data-label={copy.form.notes}>{event.reason || event.sourceReference || '—'}</td>
              </tr>)}</tbody>
            </table>       </div>
        </div>
      )}
    </section>
  )
}

function QrPanel({
  state,
  itemsById,
  locationsById,
  records,
  onApproveQrLogin,
  onNavigate,
  scanRequestId,
  language,
  loading,
  routeLabelId,
  onSaveLabel = async () => false,
  onDeactivateLabel = async () => false,
}: {
  state: InventoryStatePayload
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  records: InventoryRecord[]
  onApproveQrLogin: (token: string) => Promise<boolean>
  onNavigate: (path: string) => void
  scanRequestId: number
  language: InventoryLanguage
  loading: boolean
  routeLabelId?: string
  onSaveLabel?: (id: string, body: Record<string, unknown>, isNew: boolean) => Promise<boolean>
  onDeactivateLabel?: (id: string) => Promise<boolean>
}) {
  const copy = useInventoryCopy()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanTimerRef = useRef<number | undefined>(undefined)
  const startScannerRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const handledScanRequestRef = useRef(0)
  const resultTimerRef = useRef<number | undefined>(undefined)
  const [targetType, setTargetType] = useState<QrTargetType>('record')
  const [targetId, setTargetId] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [qrImage, setQrImage] = useState('')
  const [manualQr, setManualQr] = useState('')
  const [scannerActive, setScannerActive] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const [scannerPhase, setScannerPhase] = useState<ScannerPhase>('idle')
  const [scannerMessage, setScannerMessage] = useState('')

  const targetOptions = useMemo(() => {
    if (targetType === 'record') {
      return records.map((record) => ({
        id: record.id,
        label: `${recordDisplayName(record, itemsById.get(record.itemId))} · ${locationLabel(locationsById.get(record.locationId))}`,
      }))
    }
    if (targetType === 'item') {
      return state.items.map((item) => ({ id: item.id, label: itemOptionLabel(item) }))
    }
    if (targetType === 'place') {
      return state.locations.map((location) => ({ id: location.id, label: locationLabel(location) }))
    }
    return state.categories.map((category) => ({ id: category, label: category }))
  }, [itemsById, locationsById, records, state.categories, state.items, state.locations, targetType])

  useEffect(() => {
    if (!targetOptions.some((option) => option.id === targetId)) {
      setTargetId(targetOptions[0]?.id ?? '')
    }
  }, [targetId, targetOptions])

  useEffect(
    () => () => {
      stopScanner(streamRef, scanTimerRef)
      if (resultTimerRef.current) {
        window.clearTimeout(resultTimerRef.current)
      }
    },
    [],
  )

  async function generateQr() {
    if (!targetId) return
    const path = inventoryTargetPath(targetType, targetId)
    const url = absoluteInventoryUrl(path)
    setQrUrl(url)
    setQrImage(await QRCode.toDataURL(url, { margin: 1, width: 320 }))
  }

  function closeScanner() {
    stopScanner(streamRef, scanTimerRef)
    setScannerActive(false)
    setScannerPhase('idle')
    setScannerMessage('')
  }

  function finishScan(ok: boolean, message: string) {
    setScannerPhase(ok ? 'success' : 'failure')
    setScannerMessage(message)
    setScannerError(ok ? '' : message)
  }

  async function openScanned(value: string) {
    setScannerPhase('processing')
    setScannerMessage(copy.form.scannerProcessing)
    setScannerError('')
    const loginToken = qrLoginTokenFromScanned(value)
    if (loginToken) {
      const approved = await onApproveQrLogin(loginToken)
      finishScan(approved, approved ? copy.form.qrLoginApproved : copy.changeFailed)
      return
    }

    const path = localInventoryPathFromScanned(value)
    if (!path) {
      finishScan(false, copy.form.scannerNotInventory)
      return
    }
    finishScan(true, copy.form.scannerOpened)
    resultTimerRef.current = window.setTimeout(() => onNavigate(path), 650)
  }

  async function startScanner() {
    if (isDigitalCoreOfficeAndroidApp()) {
      setScannerError('')
      setScannerPhase('opening')
      setScannerMessage(copy.form.scannerOpening)
      try {
        const value = await requestDigitalCoreOfficeAndroid('scanQr')
        setManualQr(value)
        await openScanned(value)
      } catch (error) {
        finishScan(false, error instanceof Error ? error.message : copy.form.scannerCameraFailed)
      }
      return
    }
    const Detector = barcodeDetectorConstructor()
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      finishScan(false, copy.form.scannerUnsupported)
      return
    }

    setScannerError('')
    setScannerMessage(copy.form.scannerOpening)
    setScannerPhase('opening')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      if (!videoRef.current && isInventoryMobileBuild) {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setScannerActive(true)
      setScannerPhase('scanning')
      setScannerMessage(copy.form.scannerInstruction)
      const detector = new Detector({ formats: ['qr_code'] })
      const scan = async () => {
        const video = videoRef.current
        if (!video || video.readyState < 2) {
          scanTimerRef.current = window.setTimeout(scan, 250)
          return
        }
        const matches = await detector.detect(video).catch(() => [])
        const value = matches[0]?.rawValue
        if (value) {
          setManualQr(value)
          stopScanner(streamRef, scanTimerRef)
          setScannerActive(false)
          void openScanned(value)
          return
        }
        scanTimerRef.current = window.setTimeout(scan, 400)
      }
      scanTimerRef.current = window.setTimeout(scan, 250)
    } catch (error) {
      stopScanner(streamRef, scanTimerRef)
      setScannerActive(false)
      finishScan(false, error instanceof Error ? error.message : copy.form.scannerCameraFailed)
    }
  }

  async function scanImageFile(file: File | undefined) {
    if (!file) return
    const Detector = barcodeDetectorConstructor()
    if (!Detector || !('createImageBitmap' in window)) {
      finishScan(false, copy.form.scannerImageUnsupported)
      return
    }
    try {
      setScannerPhase('processing')
      setScannerMessage(copy.form.scannerProcessing)
      const detector = new Detector({ formats: ['qr_code'] })
      const bitmap = await createImageBitmap(file)
      const matches = await detector.detect(bitmap)
      bitmap.close()
      const value = matches[0]?.rawValue
      if (!value) {
        finishScan(false, copy.form.scannerNoCode)
        return
      }
      setManualQr(value)
      await openScanned(value)
    } catch (error) {
      finishScan(false, error instanceof Error ? error.message : copy.form.scannerImageFailed)
    }
  }

  startScannerRef.current = startScanner

  useEffect(() => {
    if (!isInventoryMobileBuild || scanRequestId === 0 || handledScanRequestRef.current === scanRequestId) return
    handledScanRequestRef.current = scanRequestId
    void startScannerRef.current?.()
  }, [scanRequestId])

  useEffect(() => {
    if (!isInventoryMobileBuild || !routeLabelId) return
    const label = state.qrLabels?.find((candidate) => candidate.id === routeLabelId)
    if (label?.active) onNavigate(inventoryTargetPath(label.targetType, label.targetId))
    else if (label) finishScan(false, copy.form.scannerNotInventory)
  }, [copy.form.scannerNotInventory, onNavigate, routeLabelId, state.qrLabels])

  const scannerOverlayVisible = isInventoryMobileBuild && scannerPhase !== 'idle'

  if (!isInventoryMobileBuild) {
    return (
      <QrWorkspace
        state={state}
        language={language}
        loading={loading}
        routeLabelId={routeLabelId}
        targetPath={inventoryTargetPath}
        labelPath={inventoryQrLabelPath}
        onNavigate={onNavigate}
        onSave={onSaveLabel}
        onDeactivate={onDeactivateLabel}
        onScan={isDigitalCoreOfficeAndroidApp() ? startScanner : undefined}
      />
    )
  }

  return (
    <>
      {scannerOverlayVisible && (
        <div className={`mobile-scanner-overlay scanner-${scannerPhase}`} role="dialog" aria-modal="true" aria-label={copy.form.scanQr}>
          {(scannerPhase === 'opening' || scannerPhase === 'scanning') && (
            <video className="mobile-scanner-video" muted playsInline ref={videoRef} />
          )}
          <div className="mobile-scanner-hud">
            <div className="mobile-scanner-title">
              <ScanLine size={20} />
              <strong>{copy.form.scanQr}</strong>
            </div>
            <div className="mobile-scan-target" aria-hidden="true" />
            <div className="mobile-scanner-status">
              {scannerPhase === 'opening' || scannerPhase === 'processing' ? <span className="scan-spinner" /> : null}
              {scannerPhase === 'success' ? <Check size={22} /> : null}
              {scannerPhase === 'failure' ? <X size={22} /> : null}
              <span>{scannerMessage}</span>
            </div>
            <div className="mobile-scanner-actions">
              {(scannerPhase === 'opening' || scannerPhase === 'scanning') && (
                <button className="secondary-action" type="button" onClick={closeScanner}>
                  {copy.actions.cancel}
                </button>
              )}
              {(scannerPhase === 'success' || scannerPhase === 'failure') && (
                <>
                  <button className="secondary-action" type="button" onClick={closeScanner}>
                    {scannerPhase === 'success' ? copy.status.ok : copy.actions.cancel}
                  </button>
                  {scannerPhase === 'failure' && (
                    <button className="primary-action" type="button" onClick={() => void startScanner()}>
                      <ScanLine size={16} />
                      {copy.form.scanQr}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="qr-grid">
        {!isInventoryMobileBuild && (
          <section className="inventory-panel qr-panel">
            <PanelTitle icon={<QrCode size={18} />} title={copy.panels.qr} />
            <div className="qr-form">
              <label>
                {copy.form.qrTarget}
                <select value={targetType} onChange={(event) => setTargetType(event.target.value as QrTargetType)}>
                  <option value="record">{copy.table.records}</option>
                  <option value="item">{copy.table.items}</option>
                  <option value="category">{copy.table.category}</option>
                  <option value="place">{copy.table.places}</option>
                </select>
              </label>
              <label>
                {copy.form.item}
                <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                  {targetOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary-action" disabled={!targetId} type="button" onClick={() => void generateQr()}>
                <QrCode size={16} />
                {copy.actions.generateQr}
              </button>
              {qrImage && (
                <div className="qr-output">
                  <img alt="" src={qrImage} />
                  <a href={qrUrl}>{qrUrl}</a>
                </div>
              )}
            </div>
          </section>
        )}

        <section className="inventory-panel qr-panel">
          <PanelTitle icon={<ScanLine size={18} />} title={copy.form.scanQr} />
          <div className="qr-form">
            {isInventoryMobileBuild ? (
              <div className="mobile-qr-launchers">
                <button className="primary-action mobile-qr-launcher" disabled={scannerActive || scannerPhase === 'processing'} type="button" onClick={() => void startScanner()}>
                  <ScanLine size={18} />
                  <span>{copy.mobile.pcLogin}</span>
                  <small>{copy.mobile.pcLoginHint}</small>
                </button>
                <button className="secondary-action mobile-qr-launcher" disabled={scannerActive || scannerPhase === 'processing'} type="button" onClick={() => void startScanner()}>
                  <QrCode size={18} />
                  <span>{copy.mobile.inventoryScan}</span>
                  <small>{copy.mobile.inventoryScanHint}</small>
                </button>
                {scannerError && <div className="inline-error">{scannerError}</div>}
              </div>
            ) : (
              <>
                <div className="scanner-frame">
                  <video muted playsInline ref={videoRef} />
                </div>
                <div className="form-actions">
                  <button className="primary-action" disabled={scannerActive} type="button" onClick={() => void startScanner()}>
                    <ScanLine size={16} />
                    {copy.form.scanQr}
                  </button>
                  <button className="secondary-action" disabled={!scannerActive} type="button" onClick={closeScanner}>
                    {copy.actions.cancel}
                  </button>
                </div>
                <label>
                  {copy.form.qrImage}
                  <input accept="image/*" type="file" onChange={(event) => void scanImageFile(event.target.files?.[0])} />
                </label>
                <label>
                  {copy.form.qrLink}
                  <input value={manualQr} onChange={(event) => setManualQr(event.target.value)} />
                </label>
                <button className="secondary-action" disabled={!manualQr.trim()} type="button" onClick={() => void openScanned(manualQr)}>
                  {copy.actions.openScannedQr}
                </button>
                {scannerError && <div className="inline-error">{scannerError}</div>}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

function AssignmentForm({
  record,
  item,
  users,
  activeAssignments,
  loading,
  onCancel,
  onSubmit,
}: {
  record: InventoryRecord
  item?: InventoryItemDefinition
  users: InventoryUser[]
  activeAssignments: InventoryAssignment[]
  loading: boolean
  onCancel: () => void
  onSubmit: (recordId: string, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const projects = useContext(InventoryProjectsContext)
  const de = copy === inventoryTranslations.de
  const assignedQuantity = activeAssignments.reduce((total, assignment) => total + assignment.quantity, 0)
  const availableQuantity = Math.max(0, record.quantity - assignedQuantity)
  const [values, setValues] = useState(() => ({
    expectedVersion: record.version,
    userId: users[0]?.id ?? '',
    projectId: '',
    quantity: availableQuantity > 0 ? '1' : '0',
    assignedAt: toLocalDateTimeInputValue(new Date()),
    notes: '',
  }))

  const quantity = Number(values.quantity)
  const canSubmit = values.expectedVersion === record.version && values.userId && Number.isFinite(quantity) && quantity > 0 && quantity <= availableQuantity

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(record.id, values)
    if (saved) {
      setValues({ ...values, quantity: availableQuantity > 1 ? '1' : '0', notes: '' })
    }
  }

  return (
    <section className="inventory-panel form-panel">
      <PanelTitle icon={<UserCheck size={18} />} title={copy.panels.assignRecord} />
      <RecordRevisionNotice record={record} expectedVersion={values.expectedVersion} onReload={() => setValues({ expectedVersion: record.version, userId: users[0]?.id ?? '', projectId: '', quantity: availableQuantity > 0 ? '1' : '0', assignedAt: toLocalDateTimeInputValue(new Date()), notes: '' })} />
      <form className="inventory-form" onSubmit={submit}>
        <label>
          {copy.form.item}
          <input readOnly value={`${recordDisplayName(record, item)} (${formatQuantity(availableQuantity)} / ${formatQuantity(record.quantity)} ${item?.unit ?? ''})`} />
        </label>
        <label>
          {copy.form.assignee}
          <select value={values.userId} onChange={(event) => setValues({ ...values, userId: event.target.value })}>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <label>{de ? 'Projekt (optional)' : 'Project (optional)'}
          <select value={values.projectId} onChange={event => setValues({ ...values, projectId: event.target.value })}>
            <option value="">{de ? 'Kein Projekt' : 'No project'}</option>
            {projects.filter(project => project.active).map(project => <option key={project.id} value={project.id}>{project.code} — {project.name}</option>)}
          </select>
        </label>
        <label>
          {copy.form.quantity}
          <input
            max={availableQuantity}
            min="0.01"
            step="0.01"
            type="number"
            value={values.quantity}
            onChange={(event) => setValues({ ...values, quantity: event.target.value })}
          />
        </label>
        <label>
          {copy.form.assignedAt}
          <input type="datetime-local" value={values.assignedAt} onChange={(event) => setValues({ ...values, assignedAt: event.target.value })} />
        </label>
        <label className="form-wide">
          {copy.form.notes}
          <textarea rows={3} value={values.notes} onChange={(event) => setValues({ ...values, notes: event.target.value })} />
        </label>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canSubmit} type="submit">
            <UserCheck size={16} />
            {copy.actions.assign}
          </button>
          <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
            {copy.actions.cancel}
          </button>
        </div>
      </form>
    </section>
  )
}

function TagManager({
  tags,
  loading,
  onSubmit,
  onDelete,
}: {
  tags: InventoryTag[]
  loading: boolean
  onSubmit: (body: Record<string, unknown>) => MutationResult
  onDelete: (tag: InventoryTag) => Promise<void>
}) {
  const copy = useInventoryCopy()
  const [values, setValues] = useState({ name: '', color: '#0f766e' })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(values)
    if (saved) {
      setValues({ name: '', color: '#0f766e' })
    }
  }

  return (
    <section className="inventory-panel tag-manager-panel">
      <PanelTitle icon={<ClipboardList size={18} />} title={copy.panels.tags} />
      <form className="inventory-form" onSubmit={submit}>
        <label>
          {copy.form.tagName}
          <input value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} />
        </label>
        <label>
          {copy.form.tagColor}
          <span className="tag-color-select">
            <i aria-hidden="true" style={{ backgroundColor: values.color }} />
            <select value={values.color} onChange={(event) => setValues({ ...values, color: event.target.value })}>
              {tagColorOptions.map((option) => (
                <option key={option.id} value={option.value}>{copy.tagColors[option.id]}</option>
              ))}
            </select>
          </span>
        </label>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !values.name.trim()} type="submit">
            <Check size={16} />
            {copy.actions.createTag}
          </button>
        </div>
      </form>
      <div className="tag-list">
        {tags.length === 0 && <p className="muted">{copy.empty.noTags}</p>}
        {tags.map((tag) => (
          <div className="tag-row" key={tag.id}>
            <TagPill tag={tag} />
            <button className="icon-action danger" disabled={loading} title={copy.actions.deleteTag} type="button" onClick={() => void onDelete(tag)}>
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ExportDownloadStatus({ status, download, error, language }: {
  status: 'idle' | 'preparing' | 'ready' | 'error'
  download: { href: string; filename: string } | null
  error: string
  language: InventoryLanguage
}) {
  if (status === 'idle') return null
  const text = (en: string, de: string) => language === 'de' ? de : en
  return <div className="inventory-export-status" role={status === 'error' ? 'alert' : 'status'}>
    {status === 'preparing' && <p>{text('Preparing your export…', 'Export wird vorbereitet…')}</p>}
    {status === 'error' && <p>{error}</p>}
    {status === 'ready' && download && <>
      <p><strong>{text('Your export is ready.', 'Dein Export ist bereit.')}</strong> {text('If the download did not start, use the link below.', 'Falls der Download nicht gestartet ist, nutze den Link unten.')}</p>
      <a className="primary-action" href={download.href} download={download.filename}><Download size={16} />{text('Download', 'Herunterladen')}: {download.filename}</a>
    </>}
  </div>
}

function ExportsPanel({
  loading,
  canExport,
  onDownload,
  state,
  downloadStatus,
}: {
  loading: boolean
  canExport: boolean
  onDownload: (format: 'csv' | 'json') => Promise<void>
  state: InventoryStatePayload
  downloadStatus: ReactNode
}) {
  const copy = useInventoryCopy()

  return (
    <section className="inventory-panel exports-panel">
      <PanelTitle icon={<Download size={18} />} title={copy.panels.exports} />
      <div className="export-actions">
        <button className="primary-action" disabled={loading || !canExport} type="button" onClick={() => void onDownload('csv')}>
          <Download size={16} />
          {copy.actions.exportCsv}
        </button>
        <button className="secondary-action" disabled={loading || !canExport} type="button" onClick={() => void onDownload('json')}>
          <FileJson size={16} />
          {copy.actions.exportJson}
        </button>
      </div>
      {downloadStatus}
      <dl className="export-fields">
        <div>
          <dt>{copy.table.records}</dt>
          <dd>{state.records.length}</dd>
        </div>
        <div>
          <dt>{copy.table.items}</dt>
          <dd>{state.items.length}</dd>
        </div>
        <div>
          <dt>{copy.table.places}</dt>
          <dd>{state.locations.length}</dd>
        </div>
        <div>
          <dt>{copy.table.generated}</dt>
          <dd>{formatDateTime(state.generatedAt)}</dd>
        </div>
      </dl>
    </section>
  )
}

function RecordTable({
  records,
  groupBy,
  itemsById,
  locationsById,
  usersById,
  tagsById,
  categoryTagIds,
  recordTagIds,
  activeAssignmentsByRecordId,
  loading,
  canAdjust,
  onOpen,
  onEdit,
  onSplit,
  onAssign,
  onReturnAssignment,
  onDelete,
}: {
  records: InventoryRecord[]
  groupBy: RecordGroupBy
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  usersById: Map<string, InventoryUser>
  tagsById: Map<string, InventoryTag>
  categoryTagIds: Map<string, string[]>
  recordTagIds: Map<string, string[]>
  activeAssignmentsByRecordId: Map<string, InventoryAssignment[]>
  loading: boolean
  canAdjust: boolean
  onOpen: (id: string) => void
  onEdit: (id: string) => void
  onSplit: (id: string) => void
  onAssign: (id: string) => void
  onReturnAssignment: (assignment: InventoryAssignment) => Promise<void>
  onDelete: (record: InventoryRecord) => Promise<void>
}) {
  const copy = useInventoryCopy()
  const groupedRecords = groupRecords(records, groupBy, itemsById, locationsById, copy)

  return (
    <div className="inventory-table-wrap">
      <table className="inventory-table stock-record-table responsive-record-table">
        <thead>
          <tr>
            <th>{copy.table.item}</th>
            <th>{copy.table.quantity}</th>
            <th>{copy.table.place}</th>
            <th>{copy.table.identity}</th>
            <th>{copy.table.updated}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 ? (
            <tr>
              <td className="empty-table-cell" colSpan={6}>{copy.empty.noStockRecords}</td>
            </tr>
          ) : (
            groupedRecords.map((group) => (
              <Fragment key={group.key}>
                {groupBy !== 'none' && (
                  <tr className="inventory-group-row" key={`${group.key}-heading`}>
                    <td colSpan={6}>{group.label}</td>
                  </tr>
                )}
                {group.records.map((record) => {
                  const item = itemsById.get(record.itemId)
                  const location = locationsById.get(record.locationId)
                  const activeAssignments = activeAssignmentsByRecordId.get(record.id) ?? []
                  const recordTags = tagsForRecord(record, item, recordTagIds, categoryTagIds, tagsById)
                  const assignedQuantity = activeAssignments.reduce((total, assignment) => total + assignment.quantity, 0)
                  const availableQuantity = Math.max(0, record.quantity - assignedQuantity)
                  return (
                    <tr
                      aria-label={`${recordDisplayName(record, item)} - ${copy.details.stock}`}
                      className="inventory-record-row"
                      key={record.id}
                      tabIndex={0}
                      onClick={() => onOpen(record.id)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                        event.preventDefault()
                        onOpen(record.id)
                      }}
                    >
                      <td data-label={copy.table.item}>
                        <div className="inventory-record-item">
                          {record.photoPath && <img className="inventory-record-thumb" alt="" loading="lazy" src={inventoryAssetUrl(record.photoPath)} />}
                          <div>
                            <strong>{recordDisplayName(record, item)}</strong>
                            <small>{recordMetaLine(record, item)}</small>
                            <TagList tags={recordTags} />
                            {record.notes && <small>{record.notes}</small>}
                          </div>
                        </div>
                      </td>
                      <td data-label={copy.table.quantity}>
                        <strong>{record.quantityLabel || `${formatQuantity(availableQuantity)} / ${formatQuantity(record.quantity)}`} {item?.unit ?? ''}</strong>
                        <span className={`state-pill state-${record.state}`}>{copy.states[record.state]}</span>
                        <small>{record.condition ? copy.conditions[record.condition] : ''}</small>
                      </td>
                      <td data-label={copy.table.place}>
                        {locationLabel(location)}
                        <small>{locationDetails(location)}</small>
                      </td>
                      <td data-label={copy.table.identity}>
                        {recordIdentityLine(record)}
                        <small>{recordSupplyLine(record)}</small>
                      </td>
                      <td data-label={copy.table.updated}>
                        {ownerLabel(record, usersById)}
                        <small>{formatDateTime(record.updatedAt)}</small>
                        <AssignmentList
                          assignments={activeAssignments}
                          loading={loading}
                          usersById={usersById}
                          onReturnAssignment={onReturnAssignment}
                        />
                      </td>
                      <td className="record-actions-cell">
                        <div className="row-actions">
                          <button className="icon-action" title={copy.actions.editRecord} type="button" onClick={(event) => { event.stopPropagation(); onEdit(record.id) }}>
                            <Edit3 size={16} />
                          </button>
                          <button
                            className="icon-action"
                            disabled={!canAdjust || loading || record.quantity <= 1}
                            title={copy.actions.splitRecord}
                            type="button"
                            onClick={(event) => { event.stopPropagation(); onSplit(record.id) }}
                          >
                            <PackagePlus size={16} />
                          </button>
                          <button
                            className="icon-action"
                            disabled={!canAdjust || loading || availableQuantity <= 0}
                            title={copy.actions.assign}
                            type="button"
                            onClick={(event) => { event.stopPropagation(); onAssign(record.id) }}
                          >
                            <UserCheck size={16} />
                          </button>
                          <button className="icon-action danger" disabled={!canAdjust || loading} title={copy.actions.deleteRecord} type="button" onClick={(event) => { event.stopPropagation(); void onDelete(record) }}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function ItemDetailPage({
  item,
  records,
  locationsById,
  totals,
  onBack,
  onEdit,
  onOpenRecord,
}: {
  item: InventoryItemDefinition
  records: InventoryRecord[]
  locationsById: Map<string, InventoryLocation>
  totals?: InventoryItemTotals
  onBack: () => void
  onEdit: () => void
  onOpenRecord: (id: string) => void
}) {
  const copy = useInventoryCopy()
  const { state: catalogState, de } = useCatalog()
  const activeRecords = records.filter((record) => record.state !== 'retired')
  const photoRecord = activeRecords.find((record) => record.photoPath)
  const storagePlaceCount = new Set(activeRecords.map((record) => record.locationId)).size

  return (
    <div className="record-detail-page">
      <div className="record-detail-toolbar">
        <button className="secondary-action" type="button" onClick={onBack}><ArrowLeft size={16} /> {copy.details.backToCatalog}</button>
        <button className="primary-action" type="button" onClick={onEdit}><Edit3 size={16} /> {copy.workspace.editData}</button>
      </div>

      <section className="inventory-panel record-detail-hero">
        <div className="record-detail-media">
          {(item.photoPath || photoRecord?.photoPath) ? <img alt={item.name} src={inventoryAssetUrl(item.photoPath || photoRecord?.photoPath)} /> : <div className="record-detail-photo-empty"><ImageOff size={42} /><span>{copy.details.noPhoto}</span></div>}
        </div>
        <div className="record-detail-summary">
          <span className="record-detail-eyebrow">{item.sku || item.category}</span>
          <h2>{item.name}</h2>
          {item.description && <p className="record-detail-description">{item.description}</p>}
          <div className="record-detail-status-row">
            <span className={totals?.belowMinimum ? 'status-note warning' : 'status-note'}>{totals?.belowMinimum ? copy.status.low : copy.status.ok}</span>
            <span className="record-detail-condition">{item.category}</span>
          </div>
          <dl className="record-detail-metrics item-detail-metrics">
            <div><dt>{copy.metrics.inStock}</dt><dd>{formatQuantity(totals?.inStockQuantity ?? 0)} {item.unit}</dd></div>
            <div><dt>{copy.table.ordered}</dt><dd>{formatQuantity(totals?.orderedQuantity ?? 0)} {item.unit}</dd></div>
            <div><dt>{copy.table.requested}</dt><dd>{formatQuantity(totals?.requestedQuantity ?? 0)} {item.unit}</dd></div>
            <div><dt>{copy.workspace.storagePlaces}</dt><dd>{storagePlaceCount}</dd></div>
          </dl>
        </div>
      </section>

      <div className="record-detail-grid">
        <section className="inventory-panel record-detail-section">
          <PanelTitle icon={<ClipboardList size={18} />} title={copy.details.item} />
          <dl className="record-detail-fields">
            <DetailField label={copy.table.sku} value={item.sku} />
            <DetailField label={copy.form.category} value={item.category} />
            <DetailField label={copy.form.manufacturer} value={item.manufacturer} />
            <DetailField label={copy.form.model} value={item.model} />
            <DetailField label={de ? "Bauteilwert (z. B. 10 kΩ)" : "Component value (e.g. 10 kΩ)"} value={item.value} />
            <DetailField label={de ? "Richtpreis je Einheit (EUR)" : "Estimated unit price (EUR)"} value={item.estimatedUnitCost === undefined ? undefined : new Intl.NumberFormat(de ? "de-DE" : "en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 4 }).format(item.estimatedUnitCost)} />
            <DetailField label={de ? "Projekte" : "Projects"} value={(item.projectIds ?? []).map(id => catalogState.projects.find(p => p.id === id)?.name).filter(Boolean).join(", ")} />
            {item.supplierUrl && <div><dt>{de ? "Artikellink" : "Article link"}</dt><dd><a href={item.supplierUrl} target="_blank" rel="noreferrer">{item.supplierUrl}</a></dd></div>}
            <DetailField label="Manufacturer Part Number" value={item.manufacturerPartNumber} />
            <DetailField label="LCSC Part Number" value={item.lcscPartNumber} />
            <DetailField label="Package / Form" value={item.packageForm} />
          </dl>
        </section>
        <section className="inventory-panel record-detail-section">
          <PanelTitle icon={<BarChart3 size={18} />} title={copy.workspace.itemDetails} />
          <dl className="record-detail-fields">
            <DetailField label={copy.workspace.minimumStock} value={`${formatQuantity(item.minQuantity)} ${item.unit}`} />
            <DetailField label={copy.form.reorderQuantity} value={`${formatQuantity(item.reorderQuantity)} ${item.unit}`} />
            <DetailField label={copy.workspace.positions} value={String(activeRecords.length)} />
            <DetailField label={copy.status.active} value={item.active ? copy.status.active : copy.status.inactive} />
          </dl>
        </section>
        <section className="inventory-panel record-detail-section record-detail-section-wide">
          <PanelTitle icon={<Boxes size={18} />} title={copy.workspace.positions} />
          <CatalogHistory key={item.id} itemId={item.id} />
          <StockPositionTable records={activeRecords} itemsById={new Map([[item.id, item]])} locationsById={locationsById} onOpenRecord={onOpenRecord} emptyText={copy.workspace.noItemStock} />
        </section>
      </div>
    </div>
  )
}

function LocationDetailPage({
  location,
  locations,
  records,
  itemsById,
  onBack,
  onEdit,
  onOpenRecord,
}: {
  location: InventoryLocation
  locations: InventoryLocation[]
  records: InventoryRecord[]
  itemsById: Map<string, InventoryItemDefinition>
  onBack: () => void
  onEdit: () => void
  onOpenRecord: (id: string) => void
}) {
  const copy = useInventoryCopy()
  const distinctItems = new Set(records.map((record) => record.itemId)).size
  const totalQuantity = records.reduce((total, record) => total + record.quantity, 0)
  const photoCount = records.filter((record) => record.photoPath).length

  return (
    <div className="record-detail-page">
      <div className="record-detail-toolbar">
        <button className="secondary-action" type="button" onClick={onBack}><ArrowLeft size={16} /> {copy.details.backToLocations}</button>
        <button className="primary-action" type="button" onClick={onEdit}><Edit3 size={16} /> {copy.workspace.editData}</button>
      </div>

      <section className="inventory-panel location-detail-hero">
        <div className="location-detail-visual">
          {location.planImagePath ? (
            <div className="floorplan-stage">
              <img alt={`${copy.workspace.roomPlan} ${location.roomCode ?? ''}`} src={inventoryAssetUrl(location.planImagePath)} />
              {location.highlightX !== undefined && location.highlightY !== undefined && (
                <span className="floorplan-highlight" style={{ left: `${location.highlightX}%`, top: `${location.highlightY}%`, width: `${location.highlightWidth ?? 5}%`, height: `${location.highlightHeight ?? 5}%` }}>
                  <span>{location.fixtureCode || location.code}</span>
                </span>
              )}
            </div>
          ) : location.photoPath ? (
            <img alt={location.name} src={inventoryAssetUrl(location.photoPath)} />
          ) : (
            <div className="record-detail-photo-empty"><MapPin size={42} /><span>{copy.details.noPhoto}</span></div>
          )}
        </div>
        <div className="record-detail-summary">
          <span className="record-detail-eyebrow">{locationKindLabel(location.kind, copy)}</span>
          <h2>{locationLabel(location)}</h2>
          <p className="record-detail-description">{location.description || locationDetails(location, locations)}</p>
          <dl className="record-detail-metrics item-detail-metrics">
            <div><dt>{copy.workspace.distinctItems}</dt><dd>{distinctItems}</dd></div>
            <div><dt>{copy.workspace.positions}</dt><dd>{records.length}</dd></div>
            <div><dt>{copy.workspace.totalQuantity}</dt><dd>{formatQuantity(totalQuantity)}</dd></div>
            <div><dt>{copy.workspace.photos}</dt><dd>{photoCount}</dd></div>
          </dl>
        </div>
      </section>

      <div className="record-detail-grid">
        <section className="inventory-panel record-detail-section">
          <PanelTitle icon={<MapPin size={18} />} title={copy.details.place} />
          <dl className="record-detail-fields">
            <DetailField label={copy.form.placeCodeOptional} value={location.code} />
            <DetailField label={copy.form.name} value={location.name} />
            <DetailField label={copy.workspace.locationType} value={locationKindLabel(location.kind, copy)} />
            <DetailField label={copy.details.place} value={locationDetails(location, locations)} />
            <DetailField label={copy.form.roomArea} value={[location.roomCode, location.roomName].filter(Boolean).join(' · ')} />
            <DetailField label={copy.form.shelfCabinet} value={[location.fixtureCode, location.fixtureType].filter(Boolean).join(' · ')} />
            <DetailField label={copy.form.boxCompartment} value={location.rowCode || location.bin} />
            <DetailField label={copy.form.description} value={location.description} />
          </dl>
        </section>
        <section className="inventory-panel record-detail-section record-detail-section-wide">
          <PanelTitle icon={<Boxes size={18} />} title={copy.workspace.locationDetails} />
          <StockPositionTable records={records} itemsById={itemsById} locationsById={new Map(locations.map((entry) => [entry.id, entry]))} onOpenRecord={onOpenRecord} emptyText={copy.workspace.noLocationStock} hideLocation={location.kind === 'container'} />
        </section>
      </div>
    </div>
  )
}

function StockPositionTable({
  records,
  itemsById,
  locationsById,
  onOpenRecord,
  emptyText,
  hideLocation = false,
}: {
  records: InventoryRecord[]
  itemsById: Map<string, InventoryItemDefinition>
  locationsById: Map<string, InventoryLocation>
  onOpenRecord: (id: string) => void
  emptyText: string
  hideLocation?: boolean
}) {
  const copy = useInventoryCopy()
  return (
    <div className="inventory-table-wrap">
      <table className="inventory-table detail-stock-table responsive-record-table">
        <thead><tr><th>{copy.table.item}</th><th>{copy.table.quantity}</th>{!hideLocation && <th>{copy.table.place}</th>}<th>{copy.table.status}</th><th>{copy.table.identity}</th><th></th></tr></thead>
        <tbody>
          {records.length === 0 ? <tr><td className="empty-table-cell" colSpan={hideLocation ? 5 : 6}>{emptyText}</td></tr> : records.map((record) => {
            const item = itemsById.get(record.itemId)
            return (
              <tr className="inventory-record-row" key={record.id} tabIndex={0} onClick={() => onOpenRecord(record.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpenRecord(record.id) } }}>
                <td data-label={copy.table.item}><div className="inventory-record-item">{record.photoPath && <img className="inventory-record-thumb" alt="" loading="lazy" src={inventoryAssetUrl(record.photoPath)} />}<div><strong>{recordDisplayName(record, item)}</strong><small>{item?.sku || item?.category || '-'}</small></div></div></td>
                <td data-label={copy.table.quantity}><strong>{record.quantityLabel || `${formatQuantity(record.quantity)} ${item?.unit ?? ''}`}</strong></td>
                {!hideLocation && <td data-label={copy.table.place}>{locationLabel(locationsById.get(record.locationId))}<small>{locationDetails(locationsById.get(record.locationId))}</small></td>}
                <td data-label={copy.table.status}><span className={`state-pill state-${record.state}`}>{copy.states[record.state]}</span><small>{copy.conditions[record.condition]}</small></td>
                <td data-label={copy.table.identity}>{recordIdentityLine(record)}<small>{record.groupName || record.sourceReference || ''}</small></td>
                <td className="record-actions-cell"><ChevronRight size={17} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function RecordDetailPage({
  record,
  item,
  location,
  tags,
  activeAssignments,
  usersById,
  onBack,
  onEdit,
}: {
  record: InventoryRecord
  item?: InventoryItemDefinition
  location?: InventoryLocation
  tags: InventoryTag[]
  activeAssignments: InventoryAssignment[]
  usersById: Map<string, InventoryUser>
  onBack: () => void
  onEdit: () => void
}) {
  const copy = useInventoryCopy()
  const projects = useContext(InventoryProjectsContext)
  const assignedQuantity = activeAssignments.reduce((total, assignment) => total + assignment.quantity, 0)
  const availableQuantity = Math.max(0, record.quantity - assignedQuantity)
  const assignees = activeAssignments
    .map((assignment) => `${projects.find(project => project.id === assignment.projectId)?.name ?? ""} ${usersById.get(assignment.userId)?.name ?? assignment.userId} (${formatQuantity(assignment.quantity)})`.trim())
    .join(', ')

  return (
    <div className="record-detail-page">
      <div className="record-detail-toolbar">
        <button className="secondary-action" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          {copy.details.back}
        </button>
        <button className="primary-action" type="button" onClick={onEdit}>
          <Edit3 size={16} />
          {copy.actions.editRecord}
        </button>
      </div>

      <section className="inventory-panel record-detail-hero">
        <div className="record-detail-media">
          {record.photoPath ? (
            <img alt={recordDisplayName(record, item)} src={inventoryAssetUrl(record.photoPath)} />
          ) : (
            <div className="record-detail-photo-empty">
              <ImageOff size={42} />
              <span>{copy.details.noPhoto}</span>
            </div>
          )}
        </div>
        <div className="record-detail-summary">
          <span className="record-detail-eyebrow">{[item?.sku, item?.category].filter(Boolean).join(' · ')}</span>
          <h2>{recordDisplayName(record, item)}</h2>
          {item?.description && <p className="record-detail-description">{item.description}</p>}
          <div className="record-detail-status-row">
            <span className={`state-pill state-${record.state}`}>{copy.states[record.state]}</span>
            <span className="record-detail-condition">{copy.conditions[record.condition]}</span>
            <TagList tags={tags} />
          </div>
          <dl className="record-detail-metrics">
            <div>
              <dt>{copy.details.available}</dt>
              <dd>{record.quantityLabel || `${formatQuantity(availableQuantity)} ${item?.unit ?? ''}`}</dd>
            </div>
            <div>
              <dt>{copy.details.total}</dt>
              <dd>{record.quantityLabel || `${formatQuantity(record.quantity)} ${item?.unit ?? ''}`}</dd>
            </div>
            <div>
              <dt>{copy.details.assigned}</dt>
              <dd>{formatQuantity(assignedQuantity)} {item?.unit ?? ''}</dd>
            </div>
          </dl>
          <div className="record-detail-location-callout">
            <MapPin size={20} />
            <div>
              <strong>{locationLabel(location)}</strong>
              <span>{locationDetails(location)}</span>
            </div>
          </div>
        </div>
      </section>

      <div className="record-detail-grid">
        <section className="inventory-panel record-detail-section">
          <PanelTitle icon={<ClipboardList size={18} />} title={copy.details.item} />
          <dl className="record-detail-fields">
            <DetailField label={copy.table.sku} value={item?.sku} />
            <DetailField label={copy.form.category} value={item?.category} />
            <DetailField label={copy.form.manufacturer} value={item?.manufacturer} />
            <DetailField label={copy.form.model} value={item?.model} />
            <DetailField label="Component value / Bauteilwert" value={item?.value} />
            <DetailField label="Manufacturer Part Number" value={item?.manufacturerPartNumber} />
            <DetailField label="LCSC Part Number" value={item?.lcscPartNumber} />
            <DetailField label="Package / Form" value={item?.packageForm} />
          </dl>
        </section>

        <section className="inventory-panel record-detail-section">
          <PanelTitle icon={<MapPin size={18} />} title={copy.details.place} />
          <dl className="record-detail-fields">
            <DetailField label={copy.form.placeCodeOptional} value={location?.code} />
            <DetailField label={copy.form.name} value={location?.name} />
            <DetailField label={copy.form.roomArea} value={[location?.roomCode, location?.roomName].filter(Boolean).join(' · ')} />
            <DetailField label={copy.form.shelfCabinet} value={[location?.fixtureCode, location?.fixtureType].filter(Boolean).join(' · ')} />
            <DetailField label={copy.form.boxCompartment} value={location?.rowCode || location?.bin} />
            <DetailField label={copy.form.description} value={location?.description} />
          </dl>
        </section>

        <section className="inventory-panel record-detail-section record-detail-section-wide">
          <PanelTitle icon={<Boxes size={18} />} title={copy.details.stock} />
          <dl className="record-detail-fields record-detail-fields-wide">
            <DetailField label={copy.form.pieceName} value={record.label} />
            <DetailField label={copy.form.groupName} value={record.groupName} />
            <DetailField label={copy.form.assetTag} value={record.assetTag} />
            <DetailField label={copy.form.serial} value={record.serialNumber} />
            <DetailField label={copy.form.lot} value={record.lotNumber} />
            <DetailField label={copy.form.supplier} value={record.supplier} />
            <DetailField label={copy.form.orderReference} value={record.orderReference} />
            <DetailField label={copy.form.unitCost} value={record.unitCost === undefined ? undefined : String(record.unitCost)} />
            <DetailField label={copy.table.holder} value={assignees} />
            <DetailField label={copy.table.updated} value={formatDateTime(record.updatedAt)} />
            <DetailField label={copy.details.source} value={record.sourceReference} />
            <DetailField label={copy.form.notes} value={record.notes} />
          </dl>
        </section>
      </div>
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function QuickStateButtons({
  record,
  canWriteState,
  loading,
  onQuickState,
  compact = false,
}: {
  record: InventoryRecord
  canWriteState: (state: InventoryState) => boolean
  loading: boolean
  onQuickState: (record: InventoryRecord, nextState: InventoryState) => Promise<void>
  compact?: boolean
}) {
  const copy = useInventoryCopy()
  const nextStates =
    record.state === 'requested' || record.state === 'approved'
      ? (['ordered'] as InventoryState[])
      : record.state === 'ordered'
        ? (['delivered'] as InventoryState[])
        : record.state === 'delivered'
          ? (['in_stock'] as InventoryState[])
          : record.state === 'in_stock'
            ? (['reserved', 'in_use', 'maintenance'] as InventoryState[])
            : []

  if (nextStates.length === 0) {
    return null
  }

  return (
    <div className={compact ? 'quick-actions compact' : 'quick-actions'}>
      {nextStates.map((nextState) => (
        <button
          className="secondary-action"
          disabled={loading || !canWriteState(nextState)}
          key={nextState}
          type="button"
          onClick={() => void onQuickState(record, nextState)}
        >
          <Check size={14} />
          {copy.actions.moveTo} {copy.states[nextState]}
        </button>
      ))}
    </div>
  )
}

function FormSection({
  title,
  hint,
  optional = false,
  children,
}: {
  title: string
  hint?: string
  optional?: boolean
  children: ReactNode
}) {
  const copy = useInventoryCopy()
  return (
    <fieldset className="form-section">
      <legend>
        <span>{title}</span>
        {optional && <small>{copy.workspace.optionalDetails}</small>}
      </legend>
      {hint && <p>{hint}</p>}
      <div className="form-section-grid">{children}</div>
    </fieldset>
  )
}

function FormDetails({
  title,
  hint,
  open = false,
  children,
}: {
  title: string
  hint?: string
  open?: boolean
  children: ReactNode
}) {
  return (
    <details className="form-advanced form-details-section" open={open}>
      <summary>
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </summary>
      <div className="form-section-grid">{children}</div>
    </details>
  )
}

function RecordRevisionNotice({ record, expectedVersion, onReload }: { record?: InventoryRecord; expectedVersion?: number; onReload: () => void }) {
  const copy = useInventoryCopy()
  const de = readSuiteLanguage([languageStorageKey]) === 'de'
  if (!record || expectedVersion === record.version) return null
  return <div className="record-revision-notice" role="alert">
    <p>{de ? 'Dieser Bestand wurde geändert. Ihre Eingaben bleiben erhalten; bitte zuerst den aktuellen Bestand prüfen.' : 'This stock record changed. Your inputs were kept; review the current stock before continuing.'}</p>
    <p>{copy.form.quantity}: {formatQuantity(record.quantity)} · {copy.form.state}: {copy.states[record.state]} · {copy.form.condition}: {copy.conditions[record.condition]}</p>
    <button className="secondary-action" type="button" onClick={() => {
      if (window.confirm(de ? 'Ihre ungespeicherten Eingaben durch die aktuellen Bestandswerte ersetzen?' : 'Replace your unsaved inputs with the current stock values?')) onReload()
    }}>{de ? 'Aktuelle Werte übernehmen' : 'Load current values'}</button>
  </div>
}

function RecordForm({
  title,
  intro,
  record,
  defaultState,
  items,
  locations,
  tags = [],
  selectedTagIds = [],
  loading,
  canWriteState,
  onCancel,
  onSubmit,
}: {
  title: string
  intro?: string
  record?: InventoryRecord
  defaultState: InventoryState
  items: InventoryItemDefinition[]
  locations: InventoryLocation[]
  tags?: InventoryTag[]
  selectedTagIds?: string[]
  loading: boolean
  canWriteState: (state: InventoryState) => boolean
  onCancel?: () => void
  onSubmit: (recordId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const firstItemId = record?.itemId ?? ''
  const incomingLocation = locations.find((location) => location.code === 'INCOMING')?.id
  const firstLocationId = record?.locationId ?? (defaultState === 'requested' ? incomingLocation ?? '' : '')
  const [itemSearch, setItemSearch] = useState('')
  const [values, setValues] = useState(() => ({
    ...recordValues(record, defaultState, firstItemId, firstLocationId),
    expectedVersion: record?.version,
    tagIds: selectedTagIds,
    changeReason: '',
  }))
  const selectedItem = items.find((item) => item.id === values.itemId)
  const selectedLocation = locations.find((location) => location.id === values.locationId)
  const quantity = Number(values.quantity)
  const availableStates = inventoryStates.filter((state) => canWriteState(state) || state === values.state)
  const normalizedItemSearch = itemSearch.trim().toLocaleLowerCase()
  const selectableItems = items.filter((item) => item.active && (item.id === values.itemId || inventorySearchScore(normalizedItemSearch, [item.name, item.sku, item.category, item.description, item.manufacturer, item.model, item.value, item.packageForm, item.manufacturerPartNumber, item.lcscPartNumber]) > 0))

  const correctionReasonRequired = Boolean(record && physicalStockStates.has(record.state))
  const canSubmit = (!record || values.expectedVersion === record.version) && canWriteState(values.state) && Boolean(values.itemId && values.locationId) && Number.isFinite(quantity) && quantity > 0 && (!correctionReasonRequired || Boolean(values.changeReason.trim()))

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(record?.id, values)
    if (saved && !record) {
      setItemSearch('')
      setValues({
        ...recordValues(undefined, defaultState, firstItemId, firstLocationId),
        expectedVersion: undefined,
        tagIds: [],
        changeReason: '',
      })
    }
  }

  return (
    <section className="inventory-panel form-panel workflow-form-panel">
      <PanelTitle icon={<PackagePlus size={18} />} title={title} />
      <p className="workflow-form-intro">{intro ?? copy.workspace.requiredHint}</p>
      <RecordRevisionNotice record={record} expectedVersion={values.expectedVersion} onReload={() => setValues({ ...recordValues(record, defaultState, firstItemId, firstLocationId), expectedVersion: record?.version, tagIds: selectedTagIds, changeReason: '' })} />
      {(items.length === 0 || locations.length === 0) && (
        <p className="empty-note">{copy.empty.needItemAndPlace}</p>
      )}
      <form className="inventory-form workflow-form" onSubmit={submit}>
        <FormSection title={copy.workspace.stockStepItem} hint={copy.workspace.stockStepItemHint}>
          {record ? (
            <label className="form-section-wide">{copy.form.item}<input readOnly value={itemOptionLabel(selectedItem)} /></label>
          ) : (
            <>
              <label>{copy.form.searchItem}<input autoFocus value={itemSearch} placeholder={copy.workspace.catalogSearch} onChange={(event) => setItemSearch(event.target.value)} /></label>
              <label>{copy.form.item}<select value={values.itemId} onChange={(event) => setValues({ ...values, itemId: event.target.value })}><option value="">{copy.form.selectItem}</option>{selectableItems.map((item) => <option key={item.id} value={item.id}>{itemOptionLabel(item)}</option>)}</select></label>
            </>
          )}
          {selectedItem && (
            <div className="form-section-wide stock-form-selection">
              <span className="stock-form-selection-icon"><Boxes size={20} /></span>
              <div><small>{copy.workspace.selectedItem}</small><strong>{selectedItem.name}</strong><span>{[selectedItem.sku, selectedItem.category, selectedItem.manufacturer].filter(Boolean).join(' · ')}</span></div>
            </div>
          )}
          {record && <p className="form-section-wide hierarchy-form-note">{copy.workspace.itemLocked}</p>}
        </FormSection>

        <FormSection title={copy.workspace.stockStepPlacement} hint={copy.workspace.stockStepPlacementHint}>
          <label className="form-section-wide">{copy.form.place}<select value={values.locationId} onChange={(event) => setValues({ ...values, locationId: event.target.value })}><option value="">{copy.form.selectPlace}</option><LocationOptions locations={locations.filter((location) => location.active || location.id === values.locationId)} /></select></label>
          <label>{copy.form.quantity}<input min="0" step="0.01" type="number" value={values.quantity} onChange={(event) => setValues({ ...values, quantity: event.target.value })} /></label>
          <label>{copy.form.state}<select value={values.state} onChange={(event) => setValues({ ...values, state: event.target.value as InventoryState })}>{availableStates.map((state) => <option key={state} value={state}>{copy.states[state]}</option>)}</select></label>
          <label>{copy.form.condition}<select value={values.condition} onChange={(event) => setValues({ ...values, condition: event.target.value as InventoryCondition })}>{inventoryConditions.map((condition) => <option key={condition} value={condition}>{copy.conditions[condition]}</option>)}</select></label>
          {selectedLocation && (
            <div className="form-section-wide stock-form-location-preview">
              <MapPin size={17} />
              <div><small>{copy.workspace.selectedPlace}</small><strong>{locationPath(selectedLocation, locations)}</strong></div>
            </div>
          )}
        </FormSection>

        <FormDetails title={copy.workspace.formIdentity} hint={copy.workspace.formIdentityHint} open={Boolean(record && (record.label || record.groupName || record.assetTag || record.serialNumber || record.lotNumber))}>
          <label>{copy.form.pieceName}<input value={values.label} onChange={(event) => setValues({ ...values, label: event.target.value })} /></label>
          <label>{copy.form.groupName}<input value={values.groupName} onChange={(event) => setValues({ ...values, groupName: event.target.value })} /></label>
          <label>{copy.form.assetTag}<input value={values.assetTag} onChange={(event) => setValues({ ...values, assetTag: event.target.value })} /></label>
          <label>{copy.form.serial}<input value={values.serialNumber} onChange={(event) => setValues({ ...values, serialNumber: event.target.value })} /></label>
          <label>{copy.form.lot}<input value={values.lotNumber} onChange={(event) => setValues({ ...values, lotNumber: event.target.value })} /></label>
          {!record && Number.isInteger(quantity) && quantity > 1 && <label className="toggle-field form-section-wide"><input checked={values.individualize} type="checkbox" onChange={(event) => setValues({ ...values, individualize: event.target.checked })} />{copy.form.individualize}</label>}
        </FormDetails>

        <FormDetails title={copy.workspace.formProcurement} hint={copy.workspace.formProcurementHint} open={Boolean(record && (record.supplier || record.orderReference || record.unitCost || record.dueDate))}>
          <label>{copy.form.supplier}<input value={values.supplier} onChange={(event) => setValues({ ...values, supplier: event.target.value })} /></label>
          <label>{copy.form.orderReference}<input value={values.orderReference} onChange={(event) => setValues({ ...values, orderReference: event.target.value })} /></label>
          <label>{copy.form.unitCost}<input min="0" step="0.01" type="number" value={values.unitCost} onChange={(event) => setValues({ ...values, unitCost: event.target.value })} /></label>
          <label>{copy.form.dueDate}<input type="date" value={values.dueDate} onChange={(event) => setValues({ ...values, dueDate: event.target.value })} /></label>
        </FormDetails>

        <FormDetails title={copy.workspace.optionalDetails} open={Boolean(record && (record.notes || selectedTagIds.length > 0))}>
          <label className="form-section-wide">{copy.form.notes}<textarea rows={3} value={values.notes} onChange={(event) => setValues({ ...values, notes: event.target.value })} /></label>
          {tags.length > 0 && <div className="form-section-wide tag-picker"><span>{copy.form.recordTags}</span><div>{tags.map((tag) => <label className="tag-option" key={tag.id}><input checked={values.tagIds.includes(tag.id)} type="checkbox" onChange={(event) => setValues({ ...values, tagIds: toggleString(values.tagIds, tag.id, event.target.checked) })} /><TagPill tag={tag} /></label>)}</div></div>}
        </FormDetails>
        {correctionReasonRequired && <FormSection title={copy.actions.saveRecord}>
          <label className="form-section-wide">Begründung / correction reason (required)<textarea required rows={2} value={values.changeReason} onChange={(event) => setValues({ ...values, changeReason: event.target.value })} /></label>
        </FormSection>}
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canSubmit} type="submit">
            <Check size={16} />
            {record ? copy.actions.saveRecord : copy.actions.createRecord}
          </button>
          {onCancel && (
            <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
              {copy.actions.cancel}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function SplitRecordForm({
  record,
  item,
  locations,
  loading,
  canWriteState,
  onCancel,
  onSubmit,
}: {
  record: InventoryRecord
  item?: InventoryItemDefinition
  locations: InventoryLocation[]
  loading: boolean
  canWriteState: (state: InventoryState) => boolean
  onCancel: () => void
  onSubmit: (recordId: string, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const [values, setValues] = useState(() => ({ ...splitRecordValues(record), expectedVersion: record.version }))

  const splitQuantity = Number(values.quantity)
  const canSubmit = values.expectedVersion === record.version && Number.isFinite(splitQuantity) && splitQuantity > 0 && splitQuantity < record.quantity && canWriteState(values.state)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(record.id, values)
    if (saved) {
      setValues({ ...splitRecordValues(record), expectedVersion: record.version })
    }
  }

  return (
    <section className="inventory-panel form-panel">
      <PanelTitle icon={<PackagePlus size={18} />} title={copy.actions.splitRecord} />
      <RecordRevisionNotice record={record} expectedVersion={values.expectedVersion} onReload={() => setValues({ ...splitRecordValues(record), expectedVersion: record.version })} />
      <form className="inventory-form" onSubmit={submit}>
        <label>
          {copy.form.item}
          <input readOnly value={itemOptionLabel(item)} />
        </label>
        <label>
          {copy.form.splitQuantity}
          <input
            max={record.quantity - 0.01}
            min="0.01"
            step="0.01"
            type="number"
            value={values.quantity}
            onChange={(event) => setValues({ ...values, quantity: event.target.value })}
          />
        </label>
        <label>
          {copy.form.state}
          <select value={values.state} onChange={(event) => setValues({ ...values, state: event.target.value as InventoryState })}>
            {inventoryStates.map((state) => (
              <option key={state} value={state}>
                {copy.states[state]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.form.place}
          <select value={values.locationId} onChange={(event) => setValues({ ...values, locationId: event.target.value })}>
            <LocationOptions locations={locations} />
          </select>
        </label>
        <label>
          {copy.form.pieceName}
          <input value={values.label} onChange={(event) => setValues({ ...values, label: event.target.value })} />
        </label>
        <label>
          {copy.form.groupName}
          <input value={values.groupName} onChange={(event) => setValues({ ...values, groupName: event.target.value })} />
        </label>
        <label className="form-wide">
          {copy.form.notes}
          <textarea rows={3} value={values.notes} onChange={(event) => setValues({ ...values, notes: event.target.value })} />
        </label>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canSubmit} type="submit">
            <Check size={16} />
            {copy.actions.splitMove}
          </button>
          <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
            {copy.actions.cancel}
          </button>
        </div>
      </form>
    </section>
  )
}

function ItemForm({
  item,
  intro,
  categories,
  tags = [],
  selectedCategoryTagIds = [],
  loading,
  canEdit,
  onCancel,
  onSubmit,
}: {
  item?: InventoryItemDefinition
  intro?: string
  categories: string[]
  tags?: InventoryTag[]
  selectedCategoryTagIds?: string[]
  loading: boolean
  canEdit: boolean
  onCancel?: () => void
  onSubmit: (itemId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const { state: catalogState, de } = useCatalog()
  const selectedTagKey = selectedCategoryTagIds.join('|')
  const [values, setValues] = useState(() => ({
    ...itemValues(item),
    categoryTagIds: selectedCategoryTagIds,
  }))
  const categoryOptions = useMemo(() => {
    const optionSet = new Set(categories.map((category) => category.trim()).filter(Boolean))
    if (item?.category) {
      optionSet.add(item.category)
    }
    return Array.from(optionSet).sort((first, second) => first.localeCompare(second))
  }, [categories, item?.category])
  const selectedCategory = categoryOptions.includes(values.category) ? values.category : newCategoryOptionValue
  const showNewCategoryInput = canEdit && selectedCategory === newCategoryOptionValue

  useEffect(() => {
    setValues({
      ...itemValues(item),
      categoryTagIds: selectedCategoryTagIds,
    })
  }, [item, selectedCategoryTagIds, selectedTagKey])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(item?.id, values)
    if (saved && !item) {
      setValues({
        ...itemValues(undefined),
        categoryTagIds: [],
      })
    }
  }

  return (
    <section className="inventory-panel form-panel workflow-form-panel">
      <PanelTitle icon={<ClipboardList size={18} />} title={item ? copy.panels.editItem : copy.panels.newItem} />
      <p className="workflow-form-intro">{intro ?? copy.workspace.requiredHint}</p>
      <form className="inventory-form workflow-form" onSubmit={submit}>
        <FormSection title={copy.workspace.catalogStepBasics} hint={copy.workspace.catalogStepBasicsHint}>
          <label>{copy.form.name}<input autoFocus value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></label>
          <label>{copy.form.skuOptional}<input value={values.sku} onChange={(event) => setValues({ ...values, sku: event.target.value })} /></label>
          <label className="toggle-field form-section-wide"><input checked={values.active} type="checkbox" onChange={(event) => setValues({ ...values, active: event.target.checked })} />{copy.form.active}</label>
        </FormSection>

        <FormSection title={copy.workspace.catalogStepClassification} hint={copy.workspace.catalogStepClassificationHint}>
          <label>
            {copy.form.category}
            <select value={selectedCategory} onChange={(event) => { const nextCategory = event.target.value; setValues({ ...values, category: nextCategory === newCategoryOptionValue ? '' : nextCategory }) }}>
              {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
              {(canEdit || selectedCategory === newCategoryOptionValue) && <option value={newCategoryOptionValue}>{canEdit ? copy.form.newCategory : copy.form.selectCategory}</option>}
            </select>
          </label>
          {showNewCategoryInput && <label>{copy.form.newCategory}<input value={values.category} onChange={(event) => setValues({ ...values, category: event.target.value })} /></label>}
          <label>{copy.form.unit}<UnitSelect aria-label={copy.form.unit} value={values.unit} onChange={(event) => setValues({ ...values, unit: event.target.value })} /></label>
          <div className="form-section-wide"><ProjectPicker projects={catalogState.projects} value={values.projectIds} onChange={projectIds => setValues({ ...values, projectIds })} /></div>
          {tags.length > 0 && (
            <div className="form-section-wide tag-picker">
              <span>{copy.form.categoryTags}</span>
              <div>{tags.map((tag) => <label className="tag-option" key={tag.id}><input checked={values.categoryTagIds.includes(tag.id)} type="checkbox" onChange={(event) => setValues({ ...values, categoryTagIds: toggleString(values.categoryTagIds, tag.id, event.target.checked) })} /><TagPill tag={tag} /></label>)}</div>
            </div>
          )}
        </FormSection>

        <FormSection title={de ? 'Foto & Einkauf' : 'Photo & purchasing'} hint={de ? 'Link und EUR-Richtpreis werden in Kaufanfragen vorgeschlagen.' : 'The link and estimated EUR price are suggested in purchase requests.'}>
          <label className="form-section-wide">{de ? 'Artikellink (optional)' : 'Article link (optional)'}<input type="url" maxLength={2000} placeholder="https://…" value={values.supplierUrl} onChange={e => setValues({ ...values, supplierUrl: e.target.value })} /></label>
          <label>{de ? 'Richtpreis je Einheit (EUR)' : 'Estimated unit price (EUR)'}<EuroInput aria-label={de ? 'Richtpreis je Einheit (EUR)' : 'Estimated unit price (EUR)'} value={values.estimatedUnitCost} onChange={e => setValues({ ...values, estimatedUnitCost: e.target.value })} /><small>{de ? '12,50 oder 12.50 · ohne Tausendertrennzeichen' : '12,50 or 12.50 · no thousands separators'}</small></label>
          <div className="form-section-wide"><ArticlePhoto value={values.photoData ?? inventoryAssetUrl(item?.photoPath)} onChange={photoData => setValues({ ...values, photoData })} /></div>
        </FormSection>
        <FormSection title={copy.workspace.catalogStepStockRules} hint={copy.workspace.catalogStepStockRulesHint}>
          <label>{copy.form.minimum}<input min="0" step="0.01" type="number" value={values.minQuantity} onChange={(event) => setValues({ ...values, minQuantity: event.target.value })} /></label>
          <label>{copy.form.reorderQuantity}<input min="0" step="0.01" type="number" value={values.reorderQuantity} onChange={(event) => setValues({ ...values, reorderQuantity: event.target.value })} /></label>
        </FormSection>

        <FormDetails title={copy.workspace.catalogTechnicalDetails} open={Boolean(item && (item.manufacturer || item.model || item.value || item.manufacturerPartNumber || item.lcscPartNumber || item.packageForm || item.description))}>
          <label>{copy.form.manufacturer}<input value={values.manufacturer} onChange={(event) => setValues({ ...values, manufacturer: event.target.value })} /></label>
          <label>{copy.form.model}<input value={values.model} onChange={(event) => setValues({ ...values, model: event.target.value })} /></label>
          <label>{de ? "Bauteilwert (z. B. 10 kΩ, kein Preis)" : "Component value (e.g. 10 kΩ, not a price)"}<input value={values.value} onChange={(event) => setValues({ ...values, value: event.target.value })} /></label>
          <label>Manufacturer Part Number<input value={values.manufacturerPartNumber} onChange={(event) => setValues({ ...values, manufacturerPartNumber: event.target.value })} /></label>
          <label>LCSC Part Number<input value={values.lcscPartNumber} onChange={(event) => setValues({ ...values, lcscPartNumber: event.target.value })} /></label>
          <label>Package / Form<input value={values.packageForm} onChange={(event) => setValues({ ...values, packageForm: event.target.value })} /></label>
          <label className="form-section-wide">{copy.form.description}<textarea rows={3} value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></label>
        </FormDetails>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canEdit || !values.name || !values.category} type="submit">
            <Check size={16} />
            {item ? copy.actions.saveItem : copy.actions.createItem}
          </button>
          {onCancel && (
            <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
              {copy.actions.cancel}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function LocationForm({
  location,
  locations,
  loading,
  canEdit,
  onCancel,
  onSubmit,
}: {
  location?: InventoryLocation
  locations: InventoryLocation[]
  loading: boolean
  canEdit: boolean
  onCancel?: () => void
  onSubmit: (locationId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const [values, setValues] = useState(() => locationValues(location))
  const hasChildren = Boolean(location && locations.some((entry) => entry.parentId === location.id))
  const parentOptions = locations.filter((entry) =>
    (entry.active || entry.id === values.parentId) && entry.id !== location?.id && entry.kind === (values.kind === 'fixture' ? 'room' : 'fixture'),
  )
  const parentIsValid = values.kind === 'room' || parentOptions.some((entry) => entry.id === values.parentId)

  useEffect(() => {
    setValues(locationValues(location))
  }, [location])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(location?.id, values)
    if (saved && !location) {
      setValues(locationValues(undefined))
    }
  }

  return (
    <section className="inventory-panel form-panel workflow-form-panel">
      <PanelTitle icon={<MapPin size={18} />} title={location ? copy.panels.editPlace : copy.panels.newPlace} />
      <p className="workflow-form-intro">{copy.workspace.requiredHint}</p>
      <form className="inventory-form workflow-form" onSubmit={submit}>
        <FormSection title={copy.workspace.formBasics}>
          <label>
            {copy.workspace.locationType}
            <select
              disabled={hasChildren}
              value={values.kind}
              onChange={(event) => setValues({ ...values, kind: event.target.value as InventoryLocationKind, parentId: '' })}
            >
              {inventoryLocationKinds.map((kind) => <option key={kind} value={kind}>{locationKindLabel(kind, copy)}</option>)}
            </select>
          </label>
          <label>{copy.form.name}<input autoFocus value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></label>
          <label>{copy.form.placeCodeOptional}<input value={values.code} onChange={(event) => setValues({ ...values, code: event.target.value })} /></label>
          <label className="toggle-field form-section-wide"><input checked={values.active} type="checkbox" onChange={(event) => setValues({ ...values, active: event.target.checked })} />{copy.form.active}</label>
          {hasChildren && <p className="form-section-wide hierarchy-form-note">{copy.workspace.typeLockedHint}</p>}
        </FormSection>

        <FormSection title={copy.workspace.formPosition} hint={copy.workspace.formPositionHint}>
          {values.kind !== 'room' && (
            <label className="form-section-wide">
              {values.kind === 'fixture' ? copy.workspace.parentRoom : copy.workspace.parentFixture}
              <select value={values.parentId} onChange={(event) => setValues({ ...values, parentId: event.target.value })}>
                <option value="">{values.kind === 'fixture' ? copy.form.selectRoom : copy.form.selectFixture}</option>
                {parentOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>{locationPath(entry, locations)}</option>
                ))}
              </select>
            </label>
          )}
          <p className="form-section-wide hierarchy-form-note">
            {values.kind === 'room' ? copy.workspace.roomHint : values.kind === 'fixture' ? copy.workspace.fixtureHint : copy.workspace.containerHint}
          </p>
          {values.kind !== 'room' && parentOptions.length === 0 && (
            <p className="form-section-wide empty-note">{copy.workspace.createParentFirst}</p>
          )}
          {values.kind === 'container' && (
            <label>{copy.form.rowPosition}<input value={values.rowCode} onChange={(event) => setValues({ ...values, rowCode: event.target.value })} /></label>
          )}
          <label className="form-section-wide">{copy.form.description}<textarea rows={3} value={values.description} onChange={(event) => setValues({ ...values, description: event.target.value })} /></label>
        </FormSection>

        <details className="form-advanced">
          <summary><span>{copy.workspace.formMapping}</span><small>{copy.workspace.formMappingHint}</small></summary>
          <div className="form-section-grid">
            <label className="form-section-wide">Room plan image path<input value={values.planImagePath} onChange={(event) => setValues({ ...values, planImagePath: event.target.value })} /></label>
            <label className="form-section-wide">Location photo path<input value={values.photoPath} onChange={(event) => setValues({ ...values, photoPath: event.target.value })} /></label>
            <div className="form-section-wide location-highlight-fields">{(['highlightX', 'highlightY', 'highlightWidth', 'highlightHeight'] as const).map((field) => <label key={field}>{field.replace('highlight', '')} (%)<input min="0" max="100" step="0.1" type="number" value={values[field]} onChange={(event) => setValues({ ...values, [field]: event.target.value })} /></label>)}</div>
          </div>
        </details>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canEdit || !values.name || !parentIsValid} type="submit">
            <Check size={16} />
            {location ? copy.actions.savePlace : copy.actions.createPlace}
          </button>
          {onCancel && (
            <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
              {copy.actions.cancel}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function UserForm({
  user,
  loading,
  canEdit,
  onCancel,
  onSubmit,
}: {
  user?: InventoryUser
  loading: boolean
  canEdit: boolean
  onCancel?: () => void
  onSubmit: (userId: string | undefined, body: Record<string, unknown>) => MutationResult
}) {
  const copy = useInventoryCopy()
  const [values, setValues] = useState(() => userValues(user))

  useEffect(() => {
    setValues(userValues(user))
  }, [user])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const saved = await onSubmit(user?.id, values)
    if (saved && !user) {
      setValues(userValues(undefined))
    }
  }

  return (
    <section className="inventory-panel form-panel workflow-form-panel">
      <PanelTitle icon={<Users size={18} />} title={user ? copy.panels.editUser : copy.panels.newUser} />
      <p className="workflow-form-intro">{copy.workspace.requiredHint}</p>
      <form className="inventory-form workflow-form" onSubmit={submit}>
        <FormSection title={copy.workspace.formIdentity}>
          <label>{copy.form.name}<input autoFocus value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} /></label>
          <label>{copy.form.email}<input type="email" value={values.email} onChange={(event) => setValues({ ...values, email: event.target.value })} /></label>
        </FormSection>

        <FormSection title={copy.workspace.formAccess} hint={copy.workspace.formAccessHint}>
          <label>{copy.form.role}<select value={values.role} onChange={(event) => setValues({ ...values, role: event.target.value as InventoryRole })}>{inventoryRoles.map((role) => <option key={role} value={role}>{copy.roles[role]}</option>)}</select></label>
          <label className="toggle-field"><input checked={values.active} type="checkbox" onChange={(event) => setValues({ ...values, active: event.target.checked })} />{copy.form.active}</label>
        </FormSection>

        <FormSection title={copy.workspace.formSecurity} hint={copy.workspace.formSecurityHint}>
          <label>{user ? copy.form.newPassword : copy.form.password}<PasswordInput aria-label={user ? copy.form.newPassword : copy.form.password} language={readSuiteLanguage()} autoComplete="new-password" minLength={14} value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} /></label>
          <label className="toggle-field"><input checked={values.mustChangePassword} type="checkbox" onChange={(event) => setValues({ ...values, mustChangePassword: event.target.checked })} />{copy.form.mustChangePassword}</label>
        </FormSection>
        <div className="form-actions">
          <button className="primary-action" disabled={loading || !canEdit || !values.name || !values.email || (!user && !values.password)} type="submit">
            <Check size={16} />
            {user ? copy.actions.saveUser : copy.actions.createUser}
          </button>
          {onCancel && (
            <button className="secondary-action" disabled={loading} type="button" onClick={onCancel}>
              {copy.actions.cancel}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function TagPill({ tag }: { tag: InventoryTag }) {
  return (
    <span className="tag-pill" style={{ borderColor: tag.color, color: tag.color }}>
      {tag.name}
    </span>
  )
}

function TagList({ tags }: { tags: InventoryTag[] }) {
  if (tags.length === 0) {
    return null
  }

  return (
    <div className="record-tags">
      {tags.map((tag) => (
        <TagPill key={tag.id} tag={tag} />
      ))}
    </div>
  )
}

function AssignmentList({
  assignments,
  usersById,
  loading,
  onReturnAssignment,
}: {
  assignments: InventoryAssignment[]
  usersById: Map<string, InventoryUser>
  loading: boolean
  onReturnAssignment: (assignment: InventoryAssignment) => Promise<void>
}) {
  const copy = useInventoryCopy()
  if (assignments.length === 0) {
    return null
  }

  return (
    <div className="assignment-list">
      {assignments.map((assignment) => (
        <span className="assignment-pill" key={assignment.id}>
          <UserCheck size={12} />
          <AssignmentTarget assignment={assignment} usersById={usersById} /> · {formatQuantity(assignment.quantity)}
          <button disabled={loading} title={copy.actions.returnItem} type="button" onClick={() => void onReturnAssignment(assignment)}>
            <RotateCcw size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="inventory-panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  )
}

function recordValues(record: InventoryRecord | undefined, defaultState: InventoryState, itemId: string, locationId: string) {
  return {
    itemId: record?.itemId ?? itemId,
    locationId: record?.locationId ?? locationId,
    label: record?.label ?? '',
    groupName: record?.groupName ?? '',
    quantity: String(record?.quantity ?? 1),
    state: record?.state ?? defaultState,
    condition: record?.condition ?? 'new',
    assetTag: record?.assetTag ?? '',
    serialNumber: record?.serialNumber ?? '',
    lotNumber: record?.lotNumber ?? '',
    supplier: record?.supplier ?? '',
    orderReference: record?.orderReference ?? '',
    unitCost: record?.unitCost === undefined ? '' : String(record.unitCost),
    dueDate: record?.dueDate ?? '',
    notes: record?.notes ?? '',
    individualize: false,
  }
}

function splitRecordValues(record: InventoryRecord) {
  return {
    locationId: record.locationId,
    label: record.label ?? '',
    groupName: record.groupName ?? '',
    quantity: record.quantity > 1 ? '1' : String(record.quantity),
    state: record.state,
    notes: record.notes ?? '',
  }
}

function itemValues(item: InventoryItemDefinition | undefined) {
  return {
    supplierUrl: item?.supplierUrl ?? '',
    estimatedUnitCost: String(item?.estimatedUnitCost ?? ''),
    projectIds: item?.projectIds ?? [],
    photoData: undefined as string | undefined,
    sku: item?.sku ?? '',
    name: item?.name ?? '',
    category: item?.category ?? '',
    unit: item?.unit ?? 'pcs',
    manufacturer: item?.manufacturer ?? '',
    model: item?.model ?? '',
    value: item?.value ?? '',
    manufacturerPartNumber: item?.manufacturerPartNumber ?? '',
    lcscPartNumber: item?.lcscPartNumber ?? '',
    packageForm: item?.packageForm ?? '',
    minQuantity: String(item?.minQuantity ?? 0),
    reorderQuantity: String(item?.reorderQuantity ?? 0),
    description: item?.description ?? '',
    active: item?.active ?? true,
  }
}

function categoriesFromItems(items: InventoryItemDefinition[]) {
  return Array.from(new Set(items.map((item) => item.category.trim()).filter(Boolean))).sort((first, second) =>
    first.localeCompare(second),
  )
}

function itemOptionLabel(item: InventoryItemDefinition | undefined) {
  if (!item) {
    return '-'
  }
  return item.sku ? `${item.sku} · ${item.name}` : item.name
}

function recordMetaLine(record: InventoryRecord, item: InventoryItemDefinition | undefined) {
  const distinctRecordLabel = record.label && record.label !== item?.name ? record.label : undefined
  return [item?.sku, distinctRecordLabel, item?.category, record.groupName].filter(Boolean).join(' / ') || '-'
}

function recordDisplayName(record: InventoryRecord, item: InventoryItemDefinition | undefined) {
  return item?.name || record.label || record.id
}

function recordIdentityLine(record: InventoryRecord) {
  return [record.assetTag, record.serialNumber, record.lotNumber].filter(Boolean).join(' / ') || '-'
}

function recordSupplyLine(record: InventoryRecord) {
  return [record.supplier, record.orderReference].filter(Boolean).join(' / ')
}

function groupRecords(
  records: InventoryRecord[],
  groupBy: RecordGroupBy,
  itemsById: Map<string, InventoryItemDefinition>,
  locationsById: Map<string, InventoryLocation>,
  copy: InventoryCopy,
) {
  if (groupBy === 'none') {
    return [{ key: 'all', label: '', records }]
  }

  const groups = new Map<string, { key: string; label: string; records: InventoryRecord[] }>()
  for (const record of records) {
    const item = itemsById.get(record.itemId)
    const location = locationsById.get(record.locationId)
    const label =
      groupBy === 'item'
        ? itemOptionLabel(item)
        : groupBy === 'category'
          ? item?.category || '-'
          : groupBy === 'place'
            ? locationLabel(location)
            : groupBy === 'state'
              ? copy.states[record.state]
              : record.groupName || '-'
    const key = `${groupBy}:${label}`
    const group = groups.get(key) ?? { key, label, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  return Array.from(groups.values())
}

function locationKindLabel(kind: InventoryLocationKind, copy: InventoryCopy) {
  return kind === 'room'
    ? copy.form.locationKindRoom
    : kind === 'fixture'
      ? copy.form.locationKindFixture
      : copy.form.locationKindContainer
}

function LocationOptions({ locations }: { locations: InventoryLocation[] }) {
  const copy = useInventoryCopy()
  return (
    <>
      {inventoryLocationKinds.map((kind) => {
        const entries = locations.filter((location) => location.kind === kind)
        return entries.length > 0 ? (
          <optgroup key={kind} label={locationKindLabel(kind, copy)}>
            {entries.map((location) => <option key={location.id} value={location.id}>{locationPath(location, locations)}</option>)}
          </optgroup>
        ) : null
      })}
    </>
  )
}

function locationDetails(location: InventoryLocation | undefined, locations: InventoryLocation[] = []) {
  if (!location) {
    return '-'
  }
  if (locations.length > 0) {
    return locationPath(location, locations)
  }
  return [location.area, location.rack, location.bin].filter(Boolean).join(' / ') || '-'
}

function locationValues(location: InventoryLocation | undefined) {
  return {
    code: location?.code ?? '',
    name: location?.name ?? '',
    kind: location?.kind ?? 'room' as InventoryLocationKind,
    parentId: location?.parentId ?? '',
    area: location?.area ?? '',
    rack: location?.rack ?? '',
    bin: location?.bin ?? '',
    roomCode: location?.roomCode ?? '',
    roomName: location?.roomName ?? '',
    fixtureCode: location?.fixtureCode ?? '',
    fixtureType: location?.fixtureType ?? '',
    rowCode: location?.rowCode ?? '',
    planImagePath: location?.planImagePath ?? '',
    photoPath: location?.photoPath ?? '',
    highlightX: location?.highlightX === undefined ? '' : String(location.highlightX),
    highlightY: location?.highlightY === undefined ? '' : String(location.highlightY),
    highlightWidth: location?.highlightWidth === undefined ? '' : String(location.highlightWidth),
    highlightHeight: location?.highlightHeight === undefined ? '' : String(location.highlightHeight),
    description: location?.description ?? '',
    active: location?.active ?? true,
  }
}

function userValues(user: InventoryUser | undefined) {
  return {
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user?.role ?? 'viewer',
    active: user?.active ?? true,
    mustChangePassword: user?.mustChangePassword ?? true,
    password: '',
  }
}

function ownerLabel(record: InventoryRecord, usersById: Map<string, InventoryUser>) {
  return (
    usersById.get(record.receivedBy ?? '')?.name ??
    usersById.get(record.orderedBy ?? '')?.name ??
    usersById.get(record.requestedBy ?? '')?.name ??
    usersById.get(record.lastCountedBy ?? '')?.name ??
    '-'
  )
}

function formatQuantity(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function groupTagIds<T extends { tagId: string }>(entries: T[], key: keyof T) {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const groupKey = String(entry[key] ?? '')
    if (!groupKey) continue
    const tagIds = groups.get(groupKey) ?? []
    tagIds.push(entry.tagId)
    groups.set(groupKey, tagIds)
  }
  return groups
}

function groupActiveAssignments(assignments: InventoryAssignment[]) {
  const groups = new Map<string, InventoryAssignment[]>()
  for (const assignment of assignments) {
    if (assignment.returnedAt || assignment.quantity <= 0) continue
    const recordAssignments = groups.get(assignment.recordId) ?? []
    recordAssignments.push(assignment)
    groups.set(assignment.recordId, recordAssignments)
  }
  return groups
}

function tagsForCategory(category: string | undefined, categoryTagIds: Map<string, string[]>, tagsById: Map<string, InventoryTag>) {
  return (category ? categoryTagIds.get(category) ?? [] : []).map((tagId) => tagsById.get(tagId)).filter(Boolean) as InventoryTag[]
}

function tagsForRecord(
  record: InventoryRecord,
  item: InventoryItemDefinition | undefined,
  recordTagIds: Map<string, string[]>,
  categoryTagIds: Map<string, string[]>,
  tagsById: Map<string, InventoryTag>,
) {
  const tagIds = new Set<string>([...(recordTagIds.get(record.id) ?? []), ...(item ? categoryTagIds.get(item.category) ?? [] : [])])
  return Array.from(tagIds)
    .map((tagId) => tagsById.get(tagId))
    .filter(Boolean) as InventoryTag[]
}

function toggleString(values: string[], value: string, enabled: boolean) {
  if (enabled) {
    return values.includes(value) ? values : [...values, value]
  }
  return values.filter((candidate) => candidate !== value)
}

function dateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localDateBoundaryIso(value: string, endOfDay: boolean) {
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (!year || !month || !day) {
    return new Date().toISOString()
  }
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0)
  return date.toISOString()
}

function dayRangeForDate(date: Date): ActivityRange {
  const value = dateInputValue(date)
  return { from: value, to: value }
}

function weekRangeForDate(date: Date): ActivityRange {
  const start = new Date(date)
  const day = start.getDay() || 7
  start.setDate(start.getDate() - day + 1)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  return { from: dateInputValue(start), to: dateInputValue(end) }
}

function monthRangeForDate(date: Date): ActivityRange {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  return { from: dateInputValue(start), to: dateInputValue(end) }
}

function toLocalDateTimeInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function compactDetails(details: Record<string, unknown>) {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 4)
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '-'
}

function auditDetails(details: Record<string, unknown>, copy: InventoryCopy) {
  const labels: Record<string, string> = { quantity: copy.table.quantity, state: copy.table.status, condition: copy.form.condition, notes: copy.form.notes }
  return Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => {
    const display = key === 'state' ? copy.states[value as InventoryRecord['state']] ?? value
      : key === 'condition' ? copy.conditions[value as InventoryCondition] ?? value : value
    return `${labels[key] ?? key}: ${typeof display === 'object' ? JSON.stringify(display) : String(display)}`
  }).join(' · ') || '—'
}

function barcodeDetectorConstructor() {
  return (window as unknown as { BarcodeDetector?: BrowserBarcodeDetectorConstructor }).BarcodeDetector
}

function stopScanner(streamRef: MutableRefObject<MediaStream | null>, timerRef: MutableRefObject<number | undefined>) {
  if (timerRef.current) {
    window.clearTimeout(timerRef.current)
    timerRef.current = undefined
  }
  streamRef.current?.getTracks().forEach((track) => track.stop())
  streamRef.current = null
}

function localInventoryPathFromScanned(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const base = inventoryBaseUrlPath().replace(/\/+$/, '')
  try {
    const url = new URL(trimmed, window.location.origin)
    const hasExplicitOrigin = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    const remoteBase = isInventoryMobileBuild && inventoryApiBase ? new URL(inventoryApiBase) : null
    if (hasExplicitOrigin && remoteBase && url.origin !== remoteBase.origin) return ''
    if (remoteBase && url.origin === remoteBase.origin) {
      const remotePath = remoteBase.pathname.replace(/\/+$/, '')
      if (url.pathname === remotePath || url.pathname.startsWith(`${remotePath}/`)) {
        const relativePath = url.pathname.slice(remotePath.length) || '/overview'
        return `${base}${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`
      }
    }
    const inventoryMatch = url.pathname.match(/\/inventorySystem(\/.*)?$/i)
    if (inventoryMatch) {
      return `${base}${inventoryMatch[1] || '/overview'}`
    }
    if (base && url.pathname.startsWith(`${base}/`)) {
      return url.pathname
    }
    if (!base && url.origin === window.location.origin) {
      return url.pathname
    }
  } catch {
    if (trimmed.startsWith('/')) {
      const inventoryMatch = trimmed.match(/\/inventorySystem(\/.*)?$/i)
      if (inventoryMatch) return `${base}${inventoryMatch[1] || '/overview'}`
      if (base && trimmed.startsWith(`${base}/`)) return trimmed
      if (!base) return trimmed
    }
  }
  return ''
}

function qrLoginTokenFromScanned(value: string) {
  const trimmed = value.trim()
  const prefixed = trimmed.match(/^inventory-(?:qr-)?login:([A-Za-z0-9_-]{30,240})$/i)
  if (prefixed) {
    return prefixed[1]
  }

  try {
    const payload = JSON.parse(trimmed) as { type?: unknown; token?: unknown }
    if (
      payload.type === 'inventory-qr-login' &&
      typeof payload.token === 'string' &&
      /^[A-Za-z0-9_-]{30,240}$/.test(payload.token)
    ) {
      return payload.token
    }
  } catch {
    // Not a structured QR payload.
  }

  if (/^[A-Za-z0-9_-]{30,240}$/.test(trimmed)) {
    return trimmed
  }

  const fromPath = (path: string) => {
    const match = path.match(/(?:^|\/)qr-login\/([^/?#]+)/i) ?? path.match(/\/inventorySystem\/qr-login\/([^/?#]+)/i)
    return match ? decodeURIComponent(match[1]) : ''
  }

  try {
    const url = new URL(trimmed, window.location.origin)
    return fromPath(url.pathname)
  } catch {
    return fromPath(trimmed)
  }
}

function InventorySystem() {
  if (isInventoryMobileBuild && (!inventoryApiBase || mobileServerSetupRequested())) {
    return <MobileServerSetupScreen currentServer={inventoryApiBase} />
  }
  return <InventoryWorkspace />
}

export default InventorySystem
