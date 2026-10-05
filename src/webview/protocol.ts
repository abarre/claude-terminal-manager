import type { ViewModel } from '../viewModel.js'

export type PanelView = 'active' | 'recent' | 'tickets'
export type PanelDensity = 'comfortable' | 'compact'

/** Extension -> webview. */
export interface StateMessage {
  readonly type: 'state'
  readonly model: ViewModel
  readonly view: PanelView
  readonly density: PanelDensity
  readonly shortcutsEnabled: boolean
}

/** Extension -> webview: the VS Code window gained or lost focus. */
export interface WindowMessage {
  readonly type: 'window'
  readonly focused: boolean
}

export type ToWebview = StateMessage | WindowMessage

/** Webview -> extension. */
export type FromWebview =
  | { readonly type: 'ready' }
  /** Reveal a live session's terminal. */
  | { readonly type: 'focus'; readonly id: string }
  /** Start a finished session again with `claude --resume`. */
  | { readonly type: 'resume'; readonly id: string; readonly cwd?: string }
  | { readonly type: 'close'; readonly id: string }
  /** A plain terminal row, addressed by pid since it has no session. */
  | { readonly type: 'focusTerminal'; readonly pid: number }
  | { readonly type: 'closeTerminal'; readonly pid: number }
  | { readonly type: 'rename'; readonly id: string }
  | {
      readonly type: 'newSession'
      readonly project?: string
      /** The project's folder, so the session opens in that project's window. */
      readonly folder?: string
    }
  | { readonly type: 'openTicket'; readonly url: string }
  | { readonly type: 'setView'; readonly view: PanelView }
  | { readonly type: 'refreshTickets' }
