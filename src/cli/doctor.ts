export type CheckStatus = 'ok' | 'fail' | 'unknown'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

export interface DoctorDeps {
  adbPath: () => string
  adbVersion: () => Promise<string>
  devices: () => Promise<{ serial: string; state: string }[]>
  nodeVersion: () => string
}

const MIN_NODE_MAJOR = 22

/**
 * Runs every check independently, so one failure does not hide the rest — the
 * environment that needs `doctor` most is the one where several things are
 * wrong at once.
 */
export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  const node = deps.nodeVersion()
  const major = Number(/^v(\d+)/.exec(node)?.[1] ?? '0')
  results.push({
    name: 'node',
    status: major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: major >= MIN_NODE_MAJOR ? node : `${node} (need v${MIN_NODE_MAJOR}+)`,
  })

  try {
    const version = (await deps.adbVersion()).split('\n')[0] ?? ''
    results.push({ name: 'adb', status: 'ok', detail: `${version.trim()} at ${deps.adbPath()}` })
  } catch (e) {
    results.push({
      name: 'adb',
      status: 'fail',
      detail: `${e instanceof Error ? e.message : String(e)} (looked at ${deps.adbPath()})`,
    })
  }

  try {
    const devices = await deps.devices()
    const ready = devices.filter((d) => d.state === 'device')
    if (ready.length > 0) {
      results.push({ name: 'devices', status: 'ok', detail: ready.map((d) => d.serial).join(', ') })
    } else if (devices.length === 0) {
      results.push({
        name: 'devices',
        status: 'fail',
        detail: 'no device attached — start an emulator or plug in a phone',
      })
    } else {
      results.push({
        name: 'devices',
        status: 'fail',
        detail: devices
          .map((d) => `${d.serial} is ${d.state}`)
          .join('; ')
          .concat(' — accept the USB debugging prompt on the device'),
      })
    }
  } catch (e) {
    results.push({
      name: 'devices',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  return results
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', fail: 'FAIL', unknown: '?   ' }

export function renderChecks(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length))
  return results
    .map((r) => `${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
    .join('\n')
}
