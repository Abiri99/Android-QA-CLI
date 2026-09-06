import { describe, it, expect } from 'vitest'
import {
  SKILL_DIR,
  appendPointer,
  pointerLine,
  skillMarkdown,
  stampContents,
} from '../../src/init/skill.js'

describe('skillMarkdown', () => {
  const md = skillMarkdown()

  it('carries frontmatter with a name and a description', () => {
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain('name: agentqa-instrumentation')
    expect(md).toContain('description:')
  })

  it('triggers on the engineer\'s task, not on the tool\'s name', () => {
    // Nobody types "agentqa" while building a checkout screen. The description
    // has to fire on what they are actually doing.
    const description = /description:.*/.exec(md)![0]
    expect(description).toMatch(/screen|ViewModel|state/)
  })

  it('states the reserved keys the auth gates depend on', () => {
    expect(md).toContain('auth.authenticated')
    expect(md).toContain('screen.current')
  })

  it('warns that renaming a key silently breaks gate config', () => {
    expect(md).toContain('agentqa.toml')
    expect(md.toLowerCase()).toContain('renam')
  })

  it('forbids emitting secrets', () => {
    expect(md.toLowerCase()).toMatch(/credential|token/)
  })

  it('explains that high-frequency emission causes dropped lines elsewhere', () => {
    expect(md.toLowerCase()).toContain('ring')
  })

  it('tells the agent how to verify what it did', () => {
    expect(md).toContain('agentqa doctor')
  })

  it('covers placing AgentQa.kt when init could not', () => {
    expect(md).toContain('package')
  })
})

describe('pointerLine', () => {
  it('names the skill file by path, so an agent without skills can still read it', () => {
    expect(pointerLine()).toContain(`${SKILL_DIR}/SKILL.md`)
  })
})

describe('appendPointer', () => {
  it('creates the content when the file does not exist', () => {
    expect(appendPointer(null)).toContain(pointerLine().trim())
  })

  it('appends to an existing file, keeping what was there', () => {
    const result = appendPointer('# My project\n\nSome notes.\n')
    expect(result).toContain('Some notes.')
    expect(result).toContain(pointerLine().trim())
  })

  it('returns null when the pointer is already present, so re-running adds nothing', () => {
    const once = appendPointer('# My project\n')!
    expect(appendPointer(once)).toBeNull()
  })

  it('recognises a pointer the user has reworded, by its marker', () => {
    // Matched on the skill directory rather than the exact sentence: an
    // engineer who rewrote the line still has a pointer, and a second one
    // would be noise.
    expect(appendPointer('See .claude/skills/agentqa-instrumentation/SKILL.md before editing.\n')).toBeNull()
  })

  it('leaves exactly one blank line between existing content and the pointer', () => {
    const result = appendPointer('# My project\n')!
    expect(result).not.toContain('\n\n\n')
  })
})

describe('stampContents', () => {
  it('records the cli and wire versions', () => {
    const stamp = JSON.parse(stampContents('0.1.0')) as { cli: string; wire: string }
    expect(stamp.cli).toBe('0.1.0')
    expect(stamp.wire).toBe('v1')
  })
})
