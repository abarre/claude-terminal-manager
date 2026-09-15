/**
 * Relative age for a session row.
 *
 * Rendered in the webview rather than baked into the view model, so a row's
 * "2m" keeps climbing between state pushes instead of freezing at whatever it
 * said when the last hook fired.
 */
export const ageOf = (at: number, now: number): string => {
  if (at <= 0) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Context size for a session row, e.g. `59k`.
 *
 * Rounded hard: the point is the order of magnitude, and an exact token count
 * would only compete with the session name for the eye.
 */
export const tokensOf = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens < 1000) return '<1k'
  const thousands = tokens / 1000
  return thousands < 999.5
    ? `${Math.round(thousands)}k`
    : `${(tokens / 1_000_000).toFixed(1)}M`
}

/** How many tints the stylesheet defines. */
export const TINT_COUNT = 12

/**
 * Pick a colour for a label from the label itself.
 *
 * Hashing rather than assigning in render order is what keeps a label the same
 * colour as the rows around it come and go.
 */
export const tintOf = (label: string): number => {
  let hash = 2166136261
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % TINT_COUNT
}

/**
 * Ticket states, unlike project names, mean something — and there are few
 * enough of them that hashing lands three of a workflow's states on
 * neighbouring reds. So the states a workflow actually uses are mapped: red
 * for blocked, green for shipped, and the stages in between in the order the
 * eye reads them. Anything unrecognised still falls back to the hash.
 *
 * Order matters: "Ready for Review" is a review, not a ready, and "Deployed in
 * production" is not a deploy still to come.
 */
const STATE_TINTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/block|bloqu|hold|stuck/, 3],
  [/deployed|production|prod\b|live/, 9],
  [/deploy|déploi|deliver|ship/, 7],
  [/complete|completed|done|closed|termin|fini/, 1],
  [/test|qa\b|recette|verif|vérif|valid/, 2],
  [/review|revue|relecture/, 4],
  [/ready|todo|to do|backlog|à faire|a faire|plan/, 5],
  [/dev|progress|en cours|wip|doing/, 0],
]

/** Colour for a ticket state heading. */
export const stateTintOf = (state: string): number => {
  const text = state.toLowerCase()
  for (const [pattern, tint] of STATE_TINTS) {
    if (pattern.test(text)) return tint
  }
  return tintOf(state)
}
