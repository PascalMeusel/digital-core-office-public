import { useEffect, useRef, useState } from 'react'
import { QrCode } from 'lucide-react'
import { requestDigitalCoreOfficeAndroid, type SuiteLanguage } from '@digital-core-office/suite-ui'

export default function DeviceSignIn({ user, language }: {
  user: { id: string; email: string }
  language: SuiteLanguage
}) {
  const [step, setStep] = useState<'idle' | 'scanning' | 'confirm' | 'approving' | 'success' | 'error'>('idle')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const scanButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const mounted = useRef(false)
  const busy = useRef(false)
  const approval = useRef<AbortController | null>(null)
  const de = language === 'de'
  const label = de ? 'Auf anderem Gerät anmelden' : 'Sign in on another device'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; approval.current?.abort() }
  }, [])

  useEffect(() => {
    if (step !== 'idle' && step !== 'scanning' && !dialog.current?.open) dialog.current?.showModal()
    if (step === 'idle' && restoreFocus.current) {
      restoreFocus.current = false
      scanButton.current?.focus()
    }
  }, [step])

  function close() {
    if (busy.current) return
    dialog.current?.close()
    restoreFocus.current = true
    setToken('')
    setStep('idle')
  }

  async function scan() {
    if (busy.current) return
    busy.current = true
    setStep('scanning')
    setError('')
    try {
      const scanned = (await requestDigitalCoreOfficeAndroid('scanQr')).trim()
      if (!mounted.current) return
      // Desktop Core generates a 32-byte, base64url challenge. Never navigate to
      // scanned URLs or submit credentials to an origin supplied by a QR code.
      if (!/^[A-Za-z0-9_-]{43}$/.test(scanned)) {
        setError(de ? 'Scannen Sie den QR-Code auf der Anmeldeseite Ihres Servers.' : 'Scan the QR code on your server’s sign-in page.')
        setStep('error')
        return
      }
      setToken(scanned)
      setStep('confirm')
    } catch (scanError) {
      if (!mounted.current) return
      if (scanError instanceof Error && /cancel|abgebrochen/i.test(scanError.message)) {
        restoreFocus.current = true
        setStep('idle')
      }
      else {
        setError(de ? 'Der Scanner konnte nicht geöffnet werden. Bitte versuchen Sie es erneut.' : 'The scanner could not be opened. Please try again.')
        setStep('error')
      }
    } finally { busy.current = false }
  }

  async function approve() {
    if (busy.current || !token) return
    busy.current = true
    setStep('approving')
    const controller = new AbortController()
    approval.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch('/api/core/auth/qr-login/challenges/approve', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, expectedUserId: user.id }),
        signal: controller.signal,
      })
      if (!mounted.current) return
      if (!response.ok) {
        setError(response.status === 401 || response.status === 403 || response.status === 409
          ? de ? 'Bitte melden Sie sich erneut in der App an und scannen Sie einen neuen QR-Code.' : 'Please sign in to the app again and scan a new QR code.'
          : response.status === 400
            ? de ? 'Dieser QR-Code ist abgelaufen oder gehört zu einem anderen Server. Zeigen Sie auf dem Computer einen neuen Code an.' : 'This QR code has expired or belongs to another server. Show a new code on the computer.'
            : de ? 'Die Anmeldung konnte nicht freigegeben werden. Bitte versuchen Sie es erneut.' : 'Sign-in could not be approved. Please try again.')
        setStep('error')
        return
      }
      setStep('success')
    } catch {
      if (mounted.current) {
        setError(de ? 'Die Verbindung wurde unterbrochen. Prüfen Sie die Anmeldung auf dem anderen Gerät, bevor Sie erneut scannen.' : 'The connection was interrupted. Check the other device’s sign-in before scanning again.')
        setStep('error')
      }
    } finally {
      window.clearTimeout(timeout)
      approval.current = null
      busy.current = false
      if (mounted.current) setToken('')
    }
  }

  return <>
    <button ref={scanButton} className="core-device-sign-in" type="button" title={label} aria-label={label}
      disabled={step !== 'idle'} onClick={() => void scan()}>
      <QrCode size={23} aria-hidden="true" />
    </button>
    <dialog className="core-device-dialog" ref={dialog} aria-labelledby="device-sign-in-title"
      onCancel={event => { event.preventDefault(); close() }}>
      <h2 id="device-sign-in-title">{step === 'success' ? de ? 'Anmeldung freigegeben' : 'Sign-in approved' : label}</h2>
      {step === 'confirm' || step === 'approving' ? <>
        <p>{de ? 'Das Gerät mit dem gescannten QR-Code wird mit Ihrem Konto angemeldet:' : 'The device showing the scanned QR code will sign in with your account:'}</p>
        <p className="core-device-identity"><strong>{user.email}</strong><span>{window.location.host}</span></p>
      </> : step === 'success' ? <p role="status">{de ? 'Sie können auf dem anderen Gerät weiterarbeiten.' : 'You can continue on the other device.'}</p> : <p role="alert">{error}</p>}
      <div className="core-device-dialog-actions">
        <button type="button" autoFocus disabled={step === 'approving'} onClick={close}>
          {step === 'confirm' || step === 'approving' ? de ? 'Abbrechen' : 'Cancel' : de ? 'Schließen' : 'Close'}
        </button>
        {step === 'confirm' || step === 'approving' ? <button className="core-device-approve" type="button"
          disabled={step === 'approving'} onClick={() => void approve()}>
          {step === 'approving' ? de ? 'Anmeldung wird freigegeben…' : 'Approving sign-in…' : de ? 'Anmeldung freigeben' : 'Approve sign-in'}
        </button> : null}
      </div>
    </dialog>
  </>
}
