import { AgentQaError } from '../../src/core/errors.js'
import type { CommandRegistry } from '../../src/daemon/server.js'

/**
 * Dispatches a command and rethrows a failed response as the `AgentQaError` it
 * describes, so tests can use `rejects`/`try-catch` and read `code` and
 * `details` directly. `dispatch` itself returns errors rather than throwing,
 * which makes `await expect(...).rejects` silently pass nothing.
 */
export function callFor(registry: CommandRegistry) {
  return async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const res = await registry.dispatch({ id: 'x', version: '0.1.0', cmd, args })
    if (!res.ok) {
      const e = res.error!
      throw new AgentQaError(e.error, e.message, e.details)
    }
    return res.data
  }
}
