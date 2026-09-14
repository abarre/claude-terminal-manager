import { describe, it, expect } from 'vitest'
import { extractJson, parseTickets, runTicketCommand } from './ticketProvider.js'

describe('parseTickets', () => {
  it('maps the French keys the reference command emits', () => {
    const tickets = parseTickets([
      {
        ticket: 'sc-7465',
        etat: 'In Development',
        titre: 'expose origin TTFB',
        url: 'https://example.test/7465',
        sessions: [
          {
            id: '735a448d-3716',
            nom: 'Couchbase config replication',
            prompts: 9,
            fin: 1789370908474,
            projet: 'fstrz',
            branche: true,
            score: 1002,
          },
        ],
      },
    ])
    expect(tickets).toEqual([
      {
        id: 'sc-7465',
        state: 'In Development',
        title: 'expose origin TTFB',
        url: 'https://example.test/7465',
        sessions: [
          {
            id: '735a448d-3716',
            name: 'Couchbase config replication',
            project: 'fstrz',
            endedAt: 1789370908474,
          },
        ],
      },
    ])
  })

  it('accepts the English key names too', () => {
    const tickets = parseTickets([
      {
        id: 'ENG-1',
        state: 'Doing',
        title: 'a thing',
        sessions: [{ id: 'abc', name: 'sess', project: 'repo', endedAt: 5 }],
      },
    ])
    expect(tickets[0]!.id).toBe('ENG-1')
    expect(tickets[0]!.sessions[0]!.name).toBe('sess')
  })

  it('returns an empty list for non-array input', () => {
    expect(parseTickets({ nope: true })).toEqual([])
    expect(parseTickets(null)).toEqual([])
    expect(parseTickets('a string')).toEqual([])
  })

  it('skips rows with no ticket identifier', () => {
    expect(parseTickets([{ titre: 'orphan' }, { ticket: 'ok' }])).toHaveLength(1)
  })

  it('skips malformed sessions but keeps the ticket', () => {
    const tickets = parseTickets([
      { ticket: 'sc-1', sessions: [{ nom: 'no id' }, { id: 'good' }, 42] },
    ])
    expect(tickets[0]!.sessions.map((s) => s.id)).toEqual(['good'])
  })

  it('tolerates a missing sessions array', () => {
    expect(parseTickets([{ ticket: 'sc-1' }])[0]!.sessions).toEqual([])
  })

  it('defaults a missing state so the row is still grouped', () => {
    expect(parseTickets([{ ticket: 'sc-1' }])[0]!.state).toBe('Other')
  })

  it('falls back to a short id when a session has no name', () => {
    const tickets = parseTickets([
      { ticket: 'sc-1', sessions: [{ id: 'abcdefgh-1234-5678' }] },
    ])
    expect(tickets[0]!.sessions[0]!.name).toBe('abcdefgh')
  })
})

describe('extractJson', () => {
  it('returns clean output unchanged', () => {
    expect(extractJson('  [{"a":1}]  ')).toBe('[{"a":1}]')
  })

  it('digs the array out of a chatty shell profile', () => {
    // `zsh -ic` sources .zshrc, which can print banners around the payload.
    expect(extractJson('nvm: using v20\n[{"a":1}]\nbye')).toBe('[{"a":1}]')
  })

  it('returns undefined when there is no array at all', () => {
    expect(extractJson('command not found')).toBeUndefined()
    expect(extractJson('')).toBeUndefined()
  })
})

describe('runTicketCommand', () => {
  it('reports why a failing command produced nothing', async () => {
    const lines: string[] = []
    const result = await runTicketCommand({
      command: 'echo "SHORTCUT_API_TOKEN absent" >&2; exit 1',
      log: (m) => lines.push(m),
    })
    expect(result).toBeUndefined()
    expect(lines.join(' ')).toContain('SHORTCUT_API_TOKEN absent')
  })

  it('reports output that carries no JSON', async () => {
    const lines: string[] = []
    await runTicketCommand({ command: 'echo hello', log: (m) => lines.push(m) })
    expect(lines.join(' ')).toContain('no JSON array')
  })

  it('resolves undefined for an empty command', async () => {
    expect(await runTicketCommand({ command: '   ' })).toBeUndefined()
  })

  it('resolves undefined when the command fails', async () => {
    expect(
      await runTicketCommand({ command: 'exit 3' }),
    ).toBeUndefined()
  })

  it('resolves undefined when the output is not JSON', async () => {
    expect(
      await runTicketCommand({ command: 'echo not-json' }),
    ).toBeUndefined()
  })

  it('parses valid JSON output', async () => {
    const json = JSON.stringify([
      { ticket: 'sc-9', etat: 'Doing', titre: 'x', sessions: [] },
    ])
    const tickets = await runTicketCommand({
      command: `printf '%s' '${json}'`,
    })
    expect(tickets).toHaveLength(1)
    expect(tickets![0]!.id).toBe('sc-9')
  })
})
