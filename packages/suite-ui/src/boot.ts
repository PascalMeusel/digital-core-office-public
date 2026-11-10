export const suiteBootMinimumMs = 900
export const suiteBootFadeOutMs = 240

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export async function waitForSuiteBootMinimum() {
  const remainingMs = suiteBootMinimumMs - window.performance.now()
  if (remainingMs > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remainingMs))
  }
}

export async function fadeOutSuiteBoot(rootElement: HTMLElement) {
  const bootShell = rootElement.querySelector('.initial-app-shell')
  if (!bootShell) {
    return
  }

  rootElement.setAttribute('data-boot-exit', 'true')
  if (!prefersReducedMotion()) {
    await new Promise((resolve) => window.setTimeout(resolve, suiteBootFadeOutMs))
  }
}
