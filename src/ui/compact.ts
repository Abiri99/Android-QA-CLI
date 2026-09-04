import type { Bounds, UiNode } from './parse.js'

export interface ScreenElement {
  ref: string
  role: string
  text: string
  testTag: string | null
  viewId: string | null
  bounds: Bounds
  enabled: boolean
  tappable: boolean
}

const MAX_TEXT = 80

function hasArea(b: Bounds): boolean {
  return b.x2 > b.x1 && b.y2 > b.y1
}

function isInteractive(n: UiNode): boolean {
  return n.clickable || n.longClickable || n.scrollable || n.editable
}

function isInteresting(n: UiNode): boolean {
  return isInteractive(n) || n.text.length > 0 || n.desc.length > 0
}

function hasInteractiveDescendant(n: UiNode): boolean {
  return n.children.some((c) => (hasArea(c.bounds) && isInteractive(c)) || hasInteractiveDescendant(c))
}

function firstText(n: UiNode): string {
  if (n.text) return n.text
  if (n.desc) return n.desc
  for (const c of n.children) {
    const t = firstText(c)
    if (t) return t
  }
  return ''
}

function roleOf(n: UiNode): string {
  if (n.editable) return 'EditText'
  if (n.scrollable) return 'Scrollable'
  if (n.clickable || n.longClickable) return 'Button'
  if (n.text || n.desc) return 'Text'
  return n.cls.split('.').pop() ?? 'View'
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s
}

export function compact(root: UiNode): ScreenElement[] {
  const out: ScreenElement[] = []

  function pushElement(n: UiNode, text: string): void {
    out.push({
      ref: `#${out.length + 1}`,
      role: roleOf(n),
      text: truncate(text),
      testTag: n.testTag,
      viewId: n.viewId,
      bounds: n.bounds,
      enabled: n.enabled,
      tappable: isInteractive(n),
    })
  }

  function walk(n: UiNode): void {
    const usable = hasArea(n.bounds)
    if (usable && isInteresting(n) && !hasInteractiveDescendant(n)) {
      pushElement(n, firstText(n))
      return // merged: descendants are absorbed
    } else if (usable && isInteresting(n)) {
      pushElement(n, n.text || n.desc)
    }
    for (const c of n.children) walk(c)
  }

  walk(root)
  return out
}

export function renderScreen(elements: ScreenElement[]): string {
  if (elements.length === 0) return '(no interactive or text elements found)'
  return elements
    .map((e) => {
      const parts = [e.ref, e.role, JSON.stringify(e.text)]
      if (e.testTag) parts.push(`tag=${e.testTag}`)
      else if (e.viewId) parts.push(`id=${e.viewId}`)
      if (!e.enabled) parts.push('disabled')
      parts.push(`[${e.bounds.x1},${e.bounds.y1}-${e.bounds.x2},${e.bounds.y2}]`)
      return parts.join(' ')
    })
    .join('\n')
}
