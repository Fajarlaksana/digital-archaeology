/** yyyy-mm-dd (local day) → ISO start of that day; with `end`, the start of the next day. */
export function dayBound(day: string, end = false): string | undefined {
  if (!day) return undefined
  const date = new Date(`${day}T00:00:00`)
  if (end) date.setDate(date.getDate() + 1)
  return date.toISOString()
}
