import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseBounds, parseHierarchy } from '../../src/ui/parse.js'

const xml = readFileSync(new URL('../fixtures/hierarchy-simple.xml', import.meta.url), 'utf8')

describe('parseBounds', () => {
  it('reads the two corner pairs', () => {
    expect(parseBounds('[540,1810][1000,1920]')).toEqual({ x1: 540, y1: 1810, x2: 1000, y2: 1920 })
  })

  it('throws E_UI_PARSE on a malformed bounds string', () => {
    expect(() => parseBounds('nonsense')).toThrowError(/E_UI_PARSE|bounds/)
  })
})

describe('parseHierarchy', () => {
  it('returns the single root node with its children', () => {
    const root = parseHierarchy(xml)
    expect(root.cls).toBe('android.widget.FrameLayout')
    expect(root.children).toHaveLength(4)
  })

  it('treats a bare resource-id as a Compose test tag', () => {
    const node = parseHierarchy(xml).children[1]!
    expect(node.testTag).toBe('checkout_btn')
    expect(node.viewId).toBeNull()
  })

  it('treats a package-qualified resource-id as a view id, not a test tag', () => {
    const node = parseHierarchy(xml).children[2]!
    expect(node.viewId).toBe('email_field')
    expect(node.testTag).toBeNull()
  })

  it('reads booleans as booleans, not strings', () => {
    const node = parseHierarchy(xml).children[3]!
    expect(node.clickable).toBe(true)
    expect(node.enabled).toBe(false)
  })

  it('flags EditText as editable', () => {
    expect(parseHierarchy(xml).children[2]!.editable).toBe(true)
    expect(parseHierarchy(xml).children[1]!.editable).toBe(false)
  })

  it('carries text and content-desc through', () => {
    expect(parseHierarchy(xml).children[0]!.text).toBe('Total: $42.00')
    expect(parseHierarchy(xml).children[1]!.desc).toBe('Checkout')
  })

  it('throws E_UI_PARSE when the payload is not a hierarchy', () => {
    expect(() => parseHierarchy('<html>nope</html>')).toThrowError(/E_UI_PARSE|hierarchy/)
  })
})
