import { AgentQaError } from '../core/errors.js'
import type { GateStatus } from './evaluate.js'

export interface AuthErrorContext {
  serial: string
  /** The visible screen, when `screen.current` is instrumented. */
  screen?: string | undefined
  /** What to put in the suggested resume command. */
  timeout?: string
}

/**
 * Builds the one error every command may return (spec 9).
 *
 * The payload is the whole point: the agent's handling has to be uniform —
 * relay `message` to the human, run `resume`, retry — and that only works if
 * every field it needs is here rather than in prose it would have to parse.
 *
 * `confirmed` is carried explicitly because a `ui_any` detection is inferred
 * (spec 7.5): the screen showing a login button is good evidence, not proof.
 * An agent that treats an inferred detection as fact will tell the human to log
 * in when they already are.
 */
export function authRequiredError(status: GateStatus, ctx: AuthErrorContext): AgentQaError {
  const timeout = ctx.timeout ?? '5m'
  const resume = `agentqa auth wait --gate ${status.name} --timeout ${timeout}`
  const qualifier = status.confirmed ? '' : ' (inferred from the screen, not confirmed by app state)'
  return new AgentQaError(
    'E_AUTH_REQUIRED',
    `authentication gate "${status.name}" is blocking${qualifier}: ${status.message}`,
    {
      gate: status.name,
      kind: status.kind,
      gate_message: status.message,
      device: ctx.serial,
      ...(ctx.screen === undefined ? {} : { screen: ctx.screen }),
      basis: status.basis,
      confirmed: status.confirmed,
      resume,
      human_action_required: true,
    },
  )
}
