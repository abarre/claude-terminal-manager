import * as vscode from 'vscode'

export const getShowNonClaudeTerminals = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('sidebar.showNonClaudeTerminals', false)

export const getVerboseToolNames = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('status.verboseToolNames', true)

export const getShowTerminalsFromAllWindows = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('sidebar.showTerminalsFromAllWindows', true)

export const getUseMacOSAccessibilityForWindowFocus = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('windowFocus.useMacOSAccessibility', false)

export const getEnableTerminalShortcuts = (): boolean =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<boolean>('keyboard.enableTerminalShortcuts', false)

export const getPanelDensity = (): 'comfortable' | 'compact' =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<'comfortable' | 'compact'>('sidebar.density', 'comfortable')

/** Hours of finished sessions to list per project. 0 disables the section. */
export const getHistoryHours = (): number =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<number>('history.hours', 168)

/** Shell command emitting ticket JSON. Empty hides the Tickets tab entirely. */
export const getTicketsCommand = (): string =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<string>('tickets.command', '')

/** Longest session name shown in a terminal tab title. 0 leaves titles alone. */
export const getTerminalTitleMaxLength = (): number =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<number>('terminalTitle.maxLength', 30)

export const getTicketsRefreshSeconds = (): number =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<number>('tickets.refreshSeconds', 60)

export type NewSessionLocation = 'editor' | 'editorMain' | 'beside' | 'panel'

export const getNewSessionLocation = (): NewSessionLocation =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<NewSessionLocation>('newSession.location', 'editorMain')

export const getNewSessionCommand = (): string =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<string>('newSession.command', 'claude')

/** Auto-compact window passed to `--autocompact` on resume. 0 omits the flag. */
export const getResumeAutocompact = (): number =>
  vscode.workspace
    .getConfiguration('claudeTerminalManager')
    .get<number>('newSession.resumeAutocompact', 400_000)
