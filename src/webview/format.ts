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
