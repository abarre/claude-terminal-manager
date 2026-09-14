import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { describe, it, expect } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgPath = join(__dirname, '..', 'package.json')

interface MenuEntry {
  command: string
  when?: string
  group?: string
}

interface ViewEntry {
  id: string
  name: string
  type?: string
}

interface PackageJson {
  contributes: {
    views: Record<string, ViewEntry[]>
    menus: Record<string, MenuEntry[]>
    commands: Array<{ command: string }>
  }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
const panel = pkg.contributes.views['claudeTerminalManagerSidebar']![0]!
const menus = pkg.contributes.menus

describe('manifest', () => {
  describe('the panel is a webview', () => {
    it('declares the panel view as type webview', () => {
      expect(panel.id).toBe('claudeTerminalManagerPanel')
      expect(panel.type).toBe('webview')
    })

    it('contributes no tree item menus, since there are no tree items', () => {
      expect(menus['view/item/context']).toBeUndefined()
    })
  })

  describe('view title actions', () => {
    const title = menus['view/title'] ?? []

    it('offers new session, refresh and reset', () => {
      expect(title.map((e) => e.command)).toEqual([
        'claudeTerminalManager.newSession',
        'claudeTerminalManager.refreshTickets',
        'claudeTerminalManager.resetState',
      ])
    })

    it('puts the new session button first in the navigation group', () => {
      const first = title[0]!
      expect(first.group).toBe('navigation@1')
      expect(first.when).toBe('view == claudeTerminalManagerPanel')
    })
  })

  describe('command palette hygiene', () => {
    const hidden = new Set(
      (menus['commandPalette'] ?? [])
        .filter((e) => e.when === 'false')
        .map((e) => e.command),
    )

    it.each([
      'claudeTerminalManager.resumeSession',
      'claudeTerminalManager.focusSession',
      'claudeTerminalManager.closeSession',
      'claudeTerminalManager.renameSessionById',
    ])('hides %s, which is useless without an argument', (command) => {
      expect(hidden.has(command)).toBe(true)
    })

    it('leaves newSession visible in the palette', () => {
      expect(hidden.has('claudeTerminalManager.newSession')).toBe(false)
    })
  })

  describe('no orphan menu entries', () => {
    it('every menu command is a declared command', () => {
      const declared = new Set(pkg.contributes.commands.map((c) => c.command))
      for (const entries of Object.values(menus)) {
        for (const entry of entries) {
          expect(declared).toContain(entry.command)
        }
      }
    })
  })
})
