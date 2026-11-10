import nodemailer from 'nodemailer'
import type { Database, StoredUser } from './store.ts'
import { adminUsers, nowIso } from './store.ts'
import { randomUUID } from 'node:crypto'

interface ResolvedSmtpSettings {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

function smtpSettings(database: Database): ResolvedSmtpSettings | undefined {
  const saved = database.mailServerSettings
  if (saved?.host && saved.fromAddress) {
    return {
      host: saved.host,
      port: saved.port,
      secure: saved.secure,
      user: saved.user,
      pass: saved.password,
      from: saved.fromAddress,
    }
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
    return undefined
  }

  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM,
  }
}

async function smtpTransport(settings: ResolvedSmtpSettings) {
  const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS ?? 10_000)
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    connectionTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
    greetingTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
    socketTimeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
    auth: settings.user
      ? {
          user: settings.user,
          pass: settings.pass,
        }
      : undefined,
  })
}

export function mailServerConfigured(database: Database) {
  return Boolean(smtpSettings(database))
}

/** Dedicated durable alert queue owns persistence; this only performs one SMTP delivery. */
export async function deliverOvertimeEmail(database: Database, recipient: string, subject: string, text: string, id: string) {
  const settings = smtpSettings(database)
  if (!settings) throw Object.assign(new Error('Mail server not configured'), { code: 'ENOCONFIG' })
  const transport = await smtpTransport(settings)
  try {
    const result = await transport.sendMail({ from: settings.from, to: recipient, subject, text, messageId: `<overtime-${id}@digitalcoreoffice>` })
    if (!result.accepted?.length) throw Object.assign(new Error('Recipient rejected'), { code: 'EENVELOPE' })
  } finally { transport.close() }
}

export async function sendEmail(database: Database, recipients: Array<Pick<StoredUser, 'email'>>, subject: string, text: string) {
  const recipientEmails = [...new Set(recipients.map((user) => user.email).filter(Boolean))]
  if (recipientEmails.length === 0) {
    return
  }

  const settings = smtpSettings(database)
  const outboxItem = {
    id: randomUUID(),
    to: recipientEmails,
    subject,
    text,
    status: settings ? 'queued' : 'console',
    createdAt: nowIso(),
  } as const

  database.emailOutbox.unshift(outboxItem)

  if (!settings) {
    console.info(`[mail:fallback] queued email ${outboxItem.id} for ${recipientEmails.length} recipient(s); configure SMTP to send it.`)
    return
  }

  const transport = await smtpTransport(settings)
  await transport.sendMail({
    from: settings.from,
    to: recipientEmails,
    subject,
    text,
  })

  const stored = database.emailOutbox.find((item) => item.id === outboxItem.id)
  if (stored) {
    stored.status = 'sent'
  }
}

export async function sendAdminEmail(database: Database, subject: string, text: string) {
  await sendEmail(database, adminUsers(database), subject, text)
}
