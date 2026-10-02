/**
 * RFC 4180 CSV with spreadsheet formula-injection protection (OWASP "CSV Injection"):
 * a cell starting with = + - @ TAB or CR is prefixed with a single quote so Excel /
 * Sheets show it as text instead of executing it. Labels and owner references are
 * user-supplied, so this matters.
 */
/** Written explicitly: an invisible literal BOM gets stripped or flagged by tooling. */
export const UTF8_BOM = String.fromCharCode(0xfeff)

const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))]
  // UTF-8 BOM so Excel opens non-ASCII labels correctly; CRLF per RFC 4180.
  return UTF8_BOM + lines.join('\r\n') + '\r\n'
}
