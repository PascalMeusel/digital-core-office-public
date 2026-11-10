import { useId, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type'> & {
  language: 'de' | 'en'
}

export function PasswordInput({ language, id, disabled, ...props }: PasswordInputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [visible, setVisible] = useState(false)
  const action = language === 'de'
    ? visible ? 'Passwort verbergen' : 'Passwort anzeigen'
    : visible ? 'Hide password' : 'Show password'
  const Icon = visible ? EyeOff : Eye

  return (
    <span className="suite-password-field">
      <input autoCapitalize="none" autoCorrect="off" spellCheck={false} {...props} id={inputId} disabled={disabled} type={visible ? 'text' : 'password'} />
      <button
        className="suite-password-toggle"
        type="button"
        disabled={disabled}
        aria-label={action}
        aria-controls={inputId}
        title={action}
        onClick={() => setVisible(current => !current)}
      >
        <Icon size={20} aria-hidden="true" />
      </button>
    </span>
  )
}
