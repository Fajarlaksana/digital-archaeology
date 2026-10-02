import { describe, expect, it } from 'vitest'
import { csvCell, toCsv, UTF8_BOM } from '../../src/lib/csv'

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['with, comma', '"with, comma"'],
    ['with "quotes"', '"with ""quotes"""'],
    ['multi\nline', '"multi\nline"'],
    [null, ''],
    [undefined, ''],
    [42, '42'],
    [new Date('2026-10-03T00:00:00Z'), '2026-10-03T00:00:00.000Z'],
  ])('%j → %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it.each([
    ['=HYPERLINK("http://evil","click")', `"'=HYPERLINK(""http://evil"",""click"")"`],
    ['+1+1', "'+1+1"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTAB', "'\tTAB"],
  ])('neutralises formula injection in %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it('leaves addresses and decimals alone', () => {
    expect(csvCell('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    )
    expect(csvCell('0.50000000')).toBe('0.50000000')
  })
})

describe('toCsv', () => {
  it('writes a BOM, header and CRLF rows', () => {
    expect(toCsv(['a', 'b'], [['1', 'x,y']])).toBe(UTF8_BOM + 'a,b\r\n1,"x,y"\r\n')
  })
})
