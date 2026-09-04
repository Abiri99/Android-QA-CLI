import { describe, it, expect } from 'vitest'
import { encodeInputText } from '../../src/adb/input-text.js'

describe('encodeInputText', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(encodeInputText('hello')).toBe('hello')
  })

  it('encodes spaces as %s, since a literal space ends the argument', () => {
    expect(encodeInputText('hello world')).toBe('hello%sworld')
  })

  it('escapes shell metacharacters', () => {
    expect(encodeInputText('a&b')).toBe('a\\&b')
    expect(encodeInputText('a;b')).toBe('a\\;b')
    expect(encodeInputText('a|b')).toBe('a\\|b')
    expect(encodeInputText('a$b')).toBe('a\\$b')
    expect(encodeInputText('a(b)')).toBe('a\\(b\\)')
  })

  it('escapes a literal percent so it cannot be read as an escape', () => {
    expect(encodeInputText('100%')).toBe('100\\%')
  })

  // `input text` turns `%s` into a space after the device shell has run, so
  // escaping the `%` does not survive: `type '100%sale'` would type `100 ale`.
  // A bare `%` is fine (above); only this two-character sequence is refused.
  it('refuses a literal %s rather than typing a space in its place', () => {
    expect(() => encodeInputText('100%sale')).toThrowError(
      expect.objectContaining({ code: 'E_UNSUPPORTED_TEXT' }),
    )
    expect(() => encodeInputText('100%sale')).toThrowError(/position 3/)
  })

  it('escapes backslashes before anything else, so escapes are not doubled', () => {
    expect(encodeInputText('a\\b')).toBe('a\\\\b')
  })

  it('escapes single and double quotes', () => {
    expect(encodeInputText(`it's`)).toBe(`it\\'s`)
    expect(encodeInputText('say "hi"')).toBe('say%s\\"hi\\"')
  })

  it('rejects non-ASCII rather than typing garbage', () => {
    expect(() => encodeInputText('café')).toThrowError(/E_UNSUPPORTED_TEXT|non-ASCII/)
  })

  it('names the offending character and its position', () => {
    try {
      encodeInputText('ab😀cd')
      throw new Error('should have thrown')
    } catch (e) {
      const details = (e as { details?: { index?: number } }).details
      expect(details?.index).toBe(2)
    }
  })

  it('rejects a newline, which input text cannot represent', () => {
    expect(() => encodeInputText('line1\nline2')).toThrowError(/E_UNSUPPORTED_TEXT|newline/)
  })

  it('accepts an empty string', () => {
    expect(encodeInputText('')).toBe('')
  })
})
