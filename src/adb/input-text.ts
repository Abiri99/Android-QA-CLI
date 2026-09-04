import { AgentQaError } from '../core/errors.js'

// Characters the device shell would otherwise interpret. Backslash is handled
// first and separately, so escaping it does not double-escape everything else.
const SHELL_SPECIAL = new Set([
  '&', ';', '|', '*', '~', '<', '>', '^', '(', ')', '[', ']', '{', '}',
  '$', '`', '"', "'", '%', '#', '!', '?',
])

/**
 * Encodes a string for `adb shell input text`.
 *
 * Two hard limits of that command drive this: a literal space terminates the
 * argument (so spaces become `%s`), and it cannot represent non-ASCII at all —
 * it types nothing or garbage rather than failing. Silently typing the wrong
 * text is the worst outcome for an agent, which proceeds believing the field is
 * filled, so non-ASCII raises instead.
 */
export function encodeInputText(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x0d) {
      throw new AgentQaError(
        'E_UNSUPPORTED_TEXT',
        `\`input text\` cannot type a newline (position ${i}); send \`key enter\` instead`,
        { index: i },
      )
    }
    // `input text` substitutes `%s` -> space AFTER the device shell has run,
    // so escaping the `%` (`\\%`) does not help: the shell strips the
    // backslash and `input text` still sees `%s`. A literal `%s` is therefore
    // indistinguishable from an encoded space, and `type '100%sale'` would
    // type `100 ale`. A bare `%` is fine; only the two-character sequence is
    // unrepresentable, so only that is refused.
    if (text[i] === '%' && text[i + 1] === 's') {
      throw new AgentQaError(
        'E_UNSUPPORTED_TEXT',
        `\`input text\` cannot type a literal "%s" (position ${i}): it encodes spaces as %s and cannot tell the two apart, so this text would be typed with a space instead`,
        { index: i },
      )
    }
    if (code > 0x7e || code < 0x20) {
      throw new AgentQaError(
        'E_UNSUPPORTED_TEXT',
        `\`input text\` cannot type non-ASCII character ${JSON.stringify(text[i])} at position ${i}; typing non-ASCII needs a test-only IME on the device`,
        { index: i, char: text[i] },
      )
    }
  }

  let out = ''
  for (const ch of text) {
    if (ch === '\\') out += '\\\\'
    else if (ch === ' ') out += '%s'
    else if (SHELL_SPECIAL.has(ch)) out += `\\${ch}`
    else out += ch
  }
  return out
}
