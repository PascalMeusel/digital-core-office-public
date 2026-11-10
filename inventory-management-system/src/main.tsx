import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import InventorySystem from './InventorySystem.tsx'
import './index.css'
import { fadeOutSuiteBoot, waitForSuiteBootMinimum } from '@digital-core-office/suite-ui/boot'

async function bootstrap() {
  const rootElement = document.getElementById('root')!
  await waitForSuiteBootMinimum()
  await fadeOutSuiteBoot(rootElement)
  rootElement.removeAttribute('data-booting')
  rootElement.removeAttribute('data-boot-exit')

  createRoot(rootElement).render(
    <StrictMode>
      <InventorySystem />
    </StrictMode>,
  )
}

void bootstrap()
