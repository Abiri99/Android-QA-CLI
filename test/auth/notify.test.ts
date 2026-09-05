import { describe, it, expect } from 'vitest'
import { MacNotifier, NullNotifier } from '../../src/auth/notify.js'

describe('MacNotifier', () => {
  it('prefers terminal-notifier', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    await new MacNotifier(async (cmd, args) => {
      calls.push({ cmd, args })
    }).notify('agentqa', 'Log in')
    expect(calls[0]!.cmd).toBe('terminal-notifier')
    expect(calls[0]!.args.join(' ')).toContain('Log in')
  })

  it('falls back to osascript when terminal-notifier is missing', async () => {
    const calls: string[] = []
    await new MacNotifier(async (cmd) => {
      calls.push(cmd)
      if (cmd === 'terminal-notifier') throw new Error('ENOENT')
    }).notify('agentqa', 'Log in')
    expect(calls).toEqual(['terminal-notifier', 'osascript'])
  })

  it('resolves rather than throwing when both are unavailable', async () => {
    // A machine with neither must not fail the command that wanted to notify.
    // The pause still happens; the human just has to look at the terminal.
    await expect(
      new MacNotifier(async () => {
        throw new Error('ENOENT')
      }).notify('agentqa', 'Log in'),
    ).resolves.toBeUndefined()
  })

  it('escapes double quotes in the osascript message rather than breaking the script', async () => {
    const calls: string[][] = []
    await new MacNotifier(async (cmd, args) => {
      calls.push(args)
      if (cmd === 'terminal-notifier') throw new Error('ENOENT')
    }).notify('agentqa', 'Confirm it\'s "you"')
    const script = calls[1]!.join(' ')
    expect(script).toContain('\\"you\\"')
  })
})

describe('NullNotifier', () => {
  it('does nothing and resolves', async () => {
    await expect(new NullNotifier().notify('a', 'b')).resolves.toBeUndefined()
  })
})
