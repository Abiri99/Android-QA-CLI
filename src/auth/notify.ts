import { spawn } from 'node:child_process'

export interface Notifier {
  notify(title: string, message: string): Promise<void>
}

export type RunCommand = (cmd: string, args: string[]) => Promise<void>

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })

/**
 * macOS notification on pause, `terminal-notifier` first and `osascript` after.
 *
 * Never rejects. The notification is a courtesy on top of an error the caller
 * is already returning; a machine without `terminal-notifier` must not see
 * `tap` fail because of it.
 */
export class MacNotifier implements Notifier {
  constructor(private readonly run: RunCommand = defaultRun) {}

  async notify(title: string, message: string): Promise<void> {
    try {
      await this.run('terminal-notifier', ['-title', title, '-message', message])
      return
    } catch {
      // Not installed, or it failed. Fall through.
    }
    try {
      // Both fields are interpolated into an AppleScript string literal, so a
      // double quote in a gate message would end the literal and leave the rest
      // as syntax. Backslash first, or the escapes we add get escaped too.
      const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      await this.run('osascript', [
        '-e',
        `display notification "${escape(message)}" with title "${escape(title)}"`,
      ])
    } catch {
      // Nothing more to try. The pause is still reported through the error.
    }
  }
}

export class NullNotifier implements Notifier {
  async notify(_title: string, _message: string): Promise<void> {}
}
