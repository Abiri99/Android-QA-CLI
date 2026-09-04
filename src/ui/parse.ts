import { XMLParser } from 'fast-xml-parser'
import { AgentQaError } from '../core/errors.js'

export interface Bounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface UiNode {
  cls: string
  text: string
  desc: string
  testTag: string | null
  viewId: string | null
  clickable: boolean
  longClickable: boolean
  scrollable: boolean
  editable: boolean
  enabled: boolean
  bounds: Bounds
  children: UiNode[]
}

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/

export function parseBounds(raw: string): Bounds {
  const m = BOUNDS_RE.exec(raw.trim())
  if (!m) throw new AgentQaError('E_UI_PARSE', `malformed bounds: ${raw}`)
  return { x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'node',
})

type RawNode = Record<string, unknown> & { node?: RawNode[] }

function bool(v: unknown): boolean {
  return v === 'true' || v === true
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function convert(raw: RawNode): UiNode {
  const resourceId = str(raw['resource-id'])
  const cls = str(raw['class'])
  return {
    cls,
    text: str(raw['text']),
    desc: str(raw['content-desc']),
    testTag: resourceId && !resourceId.includes(':id/') ? resourceId : null,
    viewId: resourceId.includes(':id/') ? (resourceId.split(':id/')[1] ?? null) : null,
    clickable: bool(raw['clickable']),
    longClickable: bool(raw['long-clickable']),
    scrollable: bool(raw['scrollable']),
    editable: cls.endsWith('EditText'),
    enabled: bool(raw['enabled']),
    bounds: parseBounds(str(raw['bounds'])),
    children: (raw.node ?? []).map(convert),
  }
}

export function parseHierarchy(xml: string): UiNode {
  const doc = parser.parse(xml) as { hierarchy?: { node?: RawNode[] } }
  const root = doc.hierarchy?.node?.[0]
  if (!root) throw new AgentQaError('E_UI_PARSE', 'no <hierarchy> root node in dump')
  return convert(root)
}
