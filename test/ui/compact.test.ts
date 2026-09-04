import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHierarchy } from '../../src/ui/parse.js'
import { compact, renderScreen } from '../../src/ui/compact.js'
import type { UiNode, Bounds } from '../../src/ui/parse.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

function node(over: Partial<UiNode> = {}): UiNode {
  const bounds: Bounds = { x1: 0, y1: 0, x2: 100, y2: 100 }
  return {
    cls: 'android.view.View', text: '', desc: '', testTag: null, viewId: null,
    clickable: false, longClickable: false, scrollable: false, editable: false,
    enabled: true, bounds, children: [], ...over,
  }
}

describe('compact', () => {
  it('keeps only interesting nodes and numbers them from 1', () => {
    const els = compact(parseHierarchy(xml))
    expect(els.map((e) => e.ref)).toEqual(['#1', '#2', '#3', '#4'])
  })

  it('drops the non-interactive container root', () => {
    expect(compact(parseHierarchy(xml)).some((e) => e.role === 'FrameLayout')).toBe(false)
  })

  it('assigns semantic roles rather than class names', () => {
    const els = compact(parseHierarchy(xml))
    expect(els.map((e) => e.role)).toEqual(['Text', 'Button', 'EditText', 'Button'])
  })

  it('prefers text but falls back to content-desc', () => {
    const [total, checkout] = compact(parseHierarchy(xml))
    expect(total!.text).toBe('Total: $42.00')
    expect(checkout!.text).toBe('Checkout')
  })

  it('preserves the enabled flag', () => {
    expect(compact(parseHierarchy(xml))[3]!.enabled).toBe(false)
  })

  it('skips zero-area nodes', () => {
    const root = node({ children: [node({ text: 'ghost', bounds: { x1: 0, y1: 0, x2: 0, y2: 0 } })] })
    expect(compact(root)).toEqual([])
  })

  it('merges a clickable wrapper with its single text descendant', () => {
    const root = node({
      children: [node({ clickable: true, testTag: 'buy', children: [node({ text: 'Buy now' })] })],
    })
    const els = compact(root)
    expect(els).toHaveLength(1)
    expect(els[0]).toMatchObject({ role: 'Button', text: 'Buy now', testTag: 'buy' })
  })

  it('does not merge when a descendant is itself interactive', () => {
    const root = node({
      children: [node({ clickable: true, children: [node({ clickable: true, text: 'Inner' })] })],
    })
    expect(compact(root)).toHaveLength(2)
  })

  it('truncates long text at 80 characters', () => {
    const root = node({ children: [node({ text: 'x'.repeat(200) })] })
    expect(compact(root)[0]!.text).toBe('x'.repeat(80) + '…')
  })
})

describe('renderScreen', () => {
  it('emits one line per element with tag and bounds', () => {
    const out = renderScreen(compact(parseHierarchy(xml)))
    expect(out.split('\n')).toEqual([
      '#1 Text "Total: $42.00" [40,600-1040,680]',
      '#2 Button "Checkout" tag=checkout_btn [540,1810-1000,1920]',
      '#3 EditText "" id=email_field [40,900-1040,1000]',
      '#4 Button "Cancel" tag=cancel_btn disabled [40,2000-1040,2100]',
    ])
  })

  it('says so explicitly when the screen has nothing to report', () => {
    expect(renderScreen([])).toBe('(no interactive or text elements found)')
  })
})
