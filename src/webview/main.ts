import type {
  ProjectGroup,
  SessionView,
  TerminalView,
  ViewModel,
} from '../viewModel.js'
import type { FromWebview, PanelView, StateMessage } from './protocol.js'
import { ageOf, stateTintOf, tokensOf } from './format.js'

interface VsCodeApi {
  postMessage(message: FromWebview): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

const vscode = acquireVsCodeApi()

const ICON_CHEV =
  '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5 10.5 8l-5 4.5"/></svg>'
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
const ICON_RESUME =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.7-3.8"/><path d="M13.2 2.6v2.9h-2.9"/></svg>'
const ICON_PLUS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>'
const ICON_TERM =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5 6 7.5 3.5 10M7.6 10.4h5"/></svg>'
const ICON_SPIN =
  '<svg class="spin" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6"/></svg>'

interface Persisted {
  collapsed?: string[]
}

const persisted = (vscode.getState() as Persisted | undefined) ?? {}
const collapsed = new Set<string>(persisted.collapsed ?? [])

const persist = (): void => {
  vscode.setState({ collapsed: [...collapsed] } satisfies Persisted)
}

let current: StateMessage | undefined

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (cls !== undefined) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const iconButton = (html: string, cls: string, label: string): HTMLElement => {
  const b = document.createElement('button')
  b.className = cls
  b.innerHTML = html
  b.title = label
  b.setAttribute('aria-label', label)
  return b
}

const indicator = (state: SessionView['state']): HTMLElement => {
  if (state === 'running') {
    const holder = el('span')
    holder.innerHTML = ICON_SPIN
    return holder.firstElementChild as HTMLElement
  }
  const cls =
    state === 'attention'
      ? 'dot attention pulse'
      : state === 'background'
        ? 'dot background'
        : state === 'ended'
          ? 'dot ended'
          : 'dot idle'
  return el('span', cls)
}

interface RowOptions {
  readonly indent?: boolean
  readonly showProject?: boolean
  readonly showBranch?: boolean
  readonly shortcutsEnabled?: boolean
}

const renderRow = (
  session: SessionView,
  now: number,
  options: RowOptions,
): HTMLElement => {
  const row = el(
    'div',
    `row ${session.state}${options.indent === true ? ' indent' : ''}`,
  )
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.title = session.live
    ? 'Focus this session\u2019s terminal'
    : 'Resume this session'
  row.dataset['id'] = session.id
  row.dataset['live'] = String(session.live)

  const ind = el('div', 'ind')
  ind.appendChild(indicator(session.state))
  row.appendChild(ind)

  const r1 = el('div', 'r1')
  if (options.shortcutsEnabled === true && session.shortcut !== undefined) {
    r1.appendChild(el('span', 'kbd', String(session.shortcut)))
  }
  r1.appendChild(el('span', 'name', session.title))
  if (session.contextTokens !== undefined) {
    const ctx = el('span', 'ctx', tokensOf(session.contextTokens))
    ctx.title = `${session.contextTokens.toLocaleString()} tokens in context`
    r1.appendChild(ctx)
  }
  if (session.at > 0) {
    const age = el('span', 'age', ageOf(session.at, now))
    age.dataset['at'] = String(session.at)
    r1.appendChild(age)
  }
  row.appendChild(r1)

  const project = options.showProject === true ? session.project : undefined
  const showProject = project !== undefined
  const showBranch = options.showBranch === true && session.branch !== undefined
  if (showProject || showBranch) {
    const r2 = el('div', 'r2')
    if (project !== undefined) r2.appendChild(el('span', 'repo', project))
    if (showBranch) {
      if (showProject) r2.appendChild(el('span', 'sep', '·'))
      r2.appendChild(el('span', 'brn', session.branch))
    }
    row.appendChild(r2)
  }

  if (session.lead !== undefined || session.detail !== undefined) {
    const r3 = el('div', 'r3')
    if (session.lead !== undefined) r3.appendChild(el('span', 'lead', session.lead))
    if (session.detail !== undefined) r3.appendChild(el('span', 'txt', session.detail))
    row.appendChild(r3)
  }

  const acts = el('div', 'acts')
  if (session.live) {
    acts.appendChild(iconButton(ICON_CLOSE, 'close', 'Close terminal'))
  } else {
    acts.appendChild(iconButton(ICON_RESUME, 'resume', 'Resume this session'))
  }
  row.appendChild(acts)

  return row
}

const renderTerminalRow = (
  terminal: TerminalView,
  shortcutsEnabled: boolean,
): HTMLElement => {
  const row = el('div', 'row terminal indent')
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.title = 'Focus this terminal'
  if (terminal.pid !== undefined) row.dataset['pid'] = String(terminal.pid)

  const ind = el('div', 'ind')
  const glyph = el('span', 'term')
  glyph.innerHTML = ICON_TERM
  ind.appendChild(glyph)
  row.appendChild(ind)

  const r1 = el('div', 'r1')
  if (shortcutsEnabled && terminal.shortcut !== undefined) {
    r1.appendChild(el('span', 'kbd', String(terminal.shortcut)))
  }
  r1.appendChild(el('span', 'name', terminal.name))
  row.appendChild(r1)

  const acts = el('div', 'acts')
  acts.appendChild(iconButton(ICON_CLOSE, 'close', 'Close terminal'))
  row.appendChild(acts)
  return row
}

const renderGroup = (
  group: ProjectGroup,
  section: string,
  now: number,
  shortcutsEnabled: boolean,
  frag: DocumentFragment,
): void => {
  // Keyed by section as well as project: the same project can sit in both, and
  // collapsing it in one should not collapse it in the other.
  const key = `${section}:${group.key}`
  const isCollapsed = collapsed.has(key)
  const rows = section === 'recent' ? group.past : group.live

  const header = el('div', 'grp')
  header.setAttribute('role', 'button')
  header.tabIndex = 0
  header.dataset['group'] = key
  header.setAttribute('aria-expanded', String(!isCollapsed))
  header.title = isCollapsed ? 'Expand' : 'Collapse'
  header.innerHTML = ICON_CHEV
  header.appendChild(el('span', 'gname', group.name))
  header.appendChild(el('span', 'gmeta', group.branch ?? ''))
  header.appendChild(
    el('span', 'count', String(rows.length + group.terminals.length)),
  )
  if (group.folder !== undefined) {
    const add = iconButton(
      ICON_PLUS,
      'add',
      `New Claude session in ${group.name}`,
    )
    add.dataset['newIn'] = group.name
    add.dataset['folder'] = group.folder
    header.appendChild(add)
  }
  frag.appendChild(header)

  if (isCollapsed) return

  for (const session of rows) {
    frag.appendChild(
      renderRow(session, now, {
        indent: true,
        showBranch: session.branch !== group.branch,
        shortcutsEnabled,
      }),
    )
  }

  for (const terminal of group.terminals) {
    frag.appendChild(renderTerminalRow(terminal, shortcutsEnabled))
  }
}

const renderGroups = (
  groups: readonly ProjectGroup[],
  section: string,
  now: number,
  shortcutsEnabled: boolean,
): DocumentFragment => {
  const frag = document.createDocumentFragment()
  for (const group of groups) {
    renderGroup(group, section, now, shortcutsEnabled, frag)
  }
  return frag
}

const renderTickets = (
  model: ViewModel,
  now: number,
  shortcutsEnabled: boolean,
): DocumentFragment => {
  const frag = document.createDocumentFragment()

  for (const tier of model.tickets) {
    const head = el('div', `tier tint tint-${stateTintOf(tier.state)}`)
    head.appendChild(el('span', 'tdot'))
    head.appendChild(document.createTextNode(tier.state))
    frag.appendChild(head)

    for (const ticket of tier.tickets) {
      const header = el('div', ticket.url !== undefined ? 'tkt linked' : 'tkt')
      header.setAttribute('role', 'button')
      header.tabIndex = 0
      if (ticket.url !== undefined) {
        header.dataset['url'] = ticket.url
        header.title = `Open ${ticket.id} in your browser`
      }
      header.appendChild(el('span', 'tid', ticket.id))
      header.appendChild(el('span', 'ttl', ticket.title))
      frag.appendChild(header)

      for (const session of ticket.sessions) {
        frag.appendChild(
          renderRow(session, now, {
            indent: true,
            showProject: true,
            shortcutsEnabled,
          }),
        )
      }
    }
  }

  return frag
}

const renderEmpty = (view: PanelView): HTMLElement => {
  const wrap = el('div', 'empty')

  if (view === 'tickets') {
    wrap.appendChild(
      el('p', undefined, 'No tickets came back from the configured command.'),
    )
    return wrap
  }

  if (view === 'recent') {
    wrap.appendChild(
      el(
        'p',
        undefined,
        'No sessions have finished recently. Ones you close will show up here, ready to resume.',
      ),
    )
    return wrap
  }

  wrap.appendChild(
    el(
      'p',
      undefined,
      'No agent sessions running. Start one and it appears here the moment its first hook fires.',
    ),
  )
  const cta = document.createElement('button')
  cta.className = 'cta'
  cta.innerHTML = ICON_PLUS
  cta.appendChild(document.createTextNode('New Claude session'))
  cta.dataset['newIn'] = ''
  wrap.appendChild(cta)
  wrap.appendChild(
    el('p', undefined, 'Sessions started in any terminal are tracked automatically.'),
  )
  return wrap
}

const body = document.getElementById('body') as HTMLElement
const tabs: Record<string, HTMLElement> = {
  active: document.getElementById('seg-active') as HTMLElement,
  recent: document.getElementById('seg-recent') as HTMLElement,
  tickets: document.getElementById('seg-tickets') as HTMLElement,
}

const render = (): void => {
  if (current === undefined) return
  const { model, view, density, shortcutsEnabled } = current
  const now = Date.now()

  document.body.classList.toggle('compact', density === 'compact')
  // The Tickets tab only exists when a command is configured and working.
  tabs['tickets']!.hidden = !model.ticketsAvailable
  for (const [name, tab] of Object.entries(tabs)) {
    tab.setAttribute('aria-selected', String(view === name))
  }

  const groups =
    view === 'recent' ? model.recent : view === 'active' ? model.active : []
  const isEmpty =
    view === 'tickets' ? model.tickets.length === 0 : groups.length === 0

  const scroll = document.documentElement.scrollTop
  body.replaceChildren(
    isEmpty
      ? renderEmpty(view)
      : view === 'tickets'
        ? renderTickets(model, now, shortcutsEnabled)
        : renderGroups(groups, view, now, shortcutsEnabled),
  )
  document.documentElement.scrollTop = scroll
}

/** Re-stamp the ages without touching the rest of the DOM. */
const tickAges = (): void => {
  const now = Date.now()
  for (const node of document.querySelectorAll<HTMLElement>('.age')) {
    const at = Number(node.dataset['at'])
    if (Number.isFinite(at) && at > 0) node.textContent = ageOf(at, now)
  }
}

// ---- events ----

for (const name of ['active', 'recent', 'tickets'] as const) {
  tabs[name]!.addEventListener('click', () => {
    vscode.postMessage({ type: 'setView', view: name })
  })
}

body.addEventListener('click', (event) => {
  // Guard on Element, not HTMLElement: a click landing on an icon's <svg> or
  // <path> has an SVGElement target, and those are not HTMLElements.
  const target = event.target
  if (!(target instanceof Element)) return

  const action = target.closest<HTMLElement>('.acts button')
  if (action !== null) {
    event.stopPropagation()
    const row = action.closest<HTMLElement>('.row')
    const pid = row?.dataset['pid']
    if (pid !== undefined) {
      vscode.postMessage({ type: 'closeTerminal', pid: Number(pid) })
      return
    }
    const id = row?.dataset['id']
    if (id !== undefined) {
      vscode.postMessage(
        action.classList.contains('resume')
          ? { type: 'resume', id }
          : { type: 'close', id },
      )
    }
    return
  }

  const add = target.closest<HTMLElement>('[data-new-in]')
  if (add !== null) {
    event.stopPropagation()
    const project = add.dataset['newIn']
    const folder = add.dataset['folder']
    vscode.postMessage({
      type: 'newSession',
      ...(project !== undefined && project.length > 0 ? { project } : {}),
      ...(folder !== undefined && folder.length > 0 ? { folder } : {}),
    })
    return
  }

  const group = target.closest<HTMLElement>('.grp')
  if (group !== null) {
    const key = group.dataset['group']
    if (key !== undefined) {
      if (collapsed.has(key)) collapsed.delete(key)
      else collapsed.add(key)
      persist()
      render()
    }
    return
  }

  const ticket = target.closest<HTMLElement>('.tkt')
  if (ticket !== null) {
    const url = ticket.dataset['url']
    if (url !== undefined) vscode.postMessage({ type: 'openTicket', url })
    return
  }

  const row = target.closest<HTMLElement>('.row')
  if (row !== null) {
    const pid = row.dataset['pid']
    if (pid !== undefined) {
      vscode.postMessage({ type: 'focusTerminal', pid: Number(pid) })
      return
    }
    const id = row.dataset['id']
    if (id === undefined) return
    vscode.postMessage(
      row.dataset['live'] === 'true'
        ? { type: 'focus', id }
        : { type: 'resume', id },
    )
  }
})

body.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.getAttribute('role') !== 'button') return
  event.preventDefault()
  target.click()
})

body.addEventListener('contextmenu', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest<HTMLElement>('.row')
  const id = row?.dataset['id']
  if (id !== undefined && row?.dataset['live'] === 'true') {
    vscode.postMessage({ type: 'rename', id })
    event.preventDefault()
  }
})

let lastSignature: string | undefined

window.addEventListener('message', (event: MessageEvent<StateMessage>) => {
  if (event.data.type !== 'state') return
  const signature = JSON.stringify(event.data)
  if (signature === lastSignature) return
  lastSignature = signature
  current = event.data
  render()
})

// Ages drift as time passes even when no session event arrives. Stamping the
// text in place avoids a rebuild that would restart every spinner and drop
// whatever the pointer is hovering.
setInterval(tickAges, 30_000)

vscode.postMessage({ type: 'ready' })
