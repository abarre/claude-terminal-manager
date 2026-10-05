import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect } from 'effect'

/** Absent means focus: requests written before close existed carry no action. */
export type FocusAction = 'focus' | 'close'

export interface FocusRequest {
  readonly terminalName: string
  readonly pid?: number
  readonly sessionId?: string
  readonly action?: FocusAction
  readonly timestamp: number
}

export const getFocusRequestPath = (
  globalStoragePath: string,
  targetWindowId: string,
): string => path.join(globalStoragePath, 'focus-' + targetWindowId + '.json')

export const writeFocusRequest = (
  globalStoragePath: string,
  targetWindowId: string,
  terminalName: string,
  pid?: number,
  sessionId?: string,
  action?: FocusAction,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    const req: FocusRequest = {
      terminalName,
      ...(pid !== undefined ? { pid } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(action === 'close' ? { action } : {}),
      timestamp: Date.now(),
    }
    fs.writeFileSync(
      getFocusRequestPath(globalStoragePath, targetWindowId),
      JSON.stringify(req),
    )
  }).pipe(
    Effect.catchAll((e) =>
      Effect.logWarning('focusIpc write failed: ' + String(e)),
    ),
  )

// b8e3f197d2
export const deleteFocusRequest = (
  globalStoragePath: string,
  windowId: string,
): Effect.Effect<void, never> =>
  Effect.try(() => {
    fs.unlinkSync(getFocusRequestPath(globalStoragePath, windowId))
  }).pipe(Effect.catchAll(() => Effect.void))
