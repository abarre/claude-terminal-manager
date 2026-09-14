import { exec } from 'node:child_process'
import type { TicketRecord, TicketSessionRecord } from './viewModel.js'

/** Never let a misconfigured command wedge the panel. */
const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/**
 * Map the ticket command's JSON onto our shape.
 *
 * Accepts both English and French key names so the extension stays generic:
 * the reference producer (`shortcut-wip.py --json`) emits
 * `ticket / etat / titre / sessions[].nom / projet / fin`, but any command
 * emitting the English equivalents works without a wrapper.
 *
 * Anything malformed is skipped rather than thrown — a bad row must not cost
 * the user the whole view.
 */
export const parseTickets = (input: unknown): readonly TicketRecord[] => {
  if (!Array.isArray(input)) return []
  const out: TicketRecord[] = []

  for (const raw of input) {
    const t = asRecord(raw)
    if (t === undefined) continue

    const id = str(t['ticket']) ?? str(t['id'])
    if (id === undefined) continue

    const state = str(t['etat']) ?? str(t['state']) ?? 'Other'
    const title = str(t['titre']) ?? str(t['title']) ?? ''
    const url = str(t['url'])

    const sessions: TicketSessionRecord[] = []
    const rawSessions = t['sessions']
    if (Array.isArray(rawSessions)) {
      for (const rawSession of rawSessions) {
        const s = asRecord(rawSession)
        if (s === undefined) continue
        const sessionId = str(s['id'])
        if (sessionId === undefined) continue
        sessions.push({
          id: sessionId,
          name: str(s['nom']) ?? str(s['name']) ?? sessionId.slice(0, 8),
          project: str(s['projet']) ?? str(s['project']),
          endedAt: num(s['fin']) ?? num(s['endedAt']) ?? 0,
        })
      }
    }

    out.push({ id, state, title, url, sessions })
  }

  return out
}

export interface RunTicketCommandOptions {
  readonly command: string
  readonly cwd?: string | undefined
  readonly timeoutMs?: number | undefined
  /** Where to report a failure. Silence here is how a typo becomes a mystery. */
  readonly log?: ((message: string) => void) | undefined
}

/**
 * Pull the JSON array out of command output.
 *
 * The command usually runs through a shell, and a shell that sources a profile
 * can print banners or warnings around the payload. Anchoring on the outermost
 * brackets keeps a chatty rc file from costing the user the whole view.
 */
export const extractJson = (stdout: string): string | undefined => {
  const trimmed = stdout.trim()
  if (trimmed.startsWith('[')) return trimmed
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start === -1 || end <= start) return undefined
  return trimmed.slice(start, end + 1)
}

/**
 * Run the configured tickets command and parse its stdout.
 *
 * Returns `undefined` on any failure — a missing command, a non-zero exit, a
 * timeout, unparseable output. The caller treats that as "no ticket view",
 * which is exactly what should happen when nothing is configured.
 */
export const runTicketCommand = (
  options: RunTicketCommandOptions,
): Promise<readonly TicketRecord[] | undefined> => {
  const command = options.command.trim()
  if (command.length === 0) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim().split('\n')[0] ?? error.message
          options.log?.(
            `tickets command failed (${error.code ?? 'error'}): ${detail}`,
          )
          resolve(undefined)
          return
        }
        const json = extractJson(stdout)
        if (json === undefined) {
          options.log?.(
            `tickets command printed no JSON array (${stdout.length} bytes)`,
          )
          resolve(undefined)
          return
        }
        try {
          const tickets = parseTickets(JSON.parse(json))
          options.log?.(`tickets command returned ${tickets.length} ticket(s)`)
          resolve(tickets)
        } catch (parseError) {
          options.log?.(`tickets output was not valid JSON: ${String(parseError)}`)
          resolve(undefined)
        }
      },
    )
  })
}
