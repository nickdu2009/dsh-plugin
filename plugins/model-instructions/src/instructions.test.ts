import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ORDER,
  DEFAULT_SECTION,
  admits,
  compileGlob,
  compileRules,
  currentRules,
  instructionsFor,
  selectionOf,
} from './instructions.js'

/** A row config with the given rules, as the Host sees it. */
function row(rules: unknown[]): { rules: unknown[] } {
  return { rules }
}

describe('compileGlob', () => {
  it('matches the whole id case-insensitively', () => {
    expect(compileGlob('deepseek-reasoner*').test('deepseek-reasoner-max')).toBe(true)
    expect(compileGlob('deepseek-reasoner*').test('deepseek-flash')).toBe(false)
    expect(compileGlob('DEEPSEEK-FLASH').test('deepseek-flash')).toBe(true)
    expect(compileGlob('flash').test('deepseek-flash')).toBe(false)
  })

  it('matches one character per question mark', () => {
    const pattern = compileGlob('v?')
    expect(pattern.test('v1')).toBe(true)
    expect(pattern.test('v12')).toBe(false)
  })

  it('treats regular-expression metacharacters literally', () => {
    expect(compileGlob('a.b').test('a.b')).toBe(true)
    expect(compileGlob('a.b').test('axb')).toBe(false)
    expect(compileGlob('a+b').test('a+b')).toBe(true)
  })
})

describe('currentRules', () => {
  it('returns a plain rule list', () => {
    expect(currentRules(row([{ instruction: 'one' }]))).toEqual([{ instruction: 'one' }])
  })

  it('reads a volatile field through get()', () => {
    const live = { get: () => [{ instruction: 'live' }] }
    expect(currentRules(row(live as unknown as never))).toEqual([{ instruction: 'live' }])
  })

  it('falls back to an empty list for missing or malformed values', () => {
    expect(currentRules(undefined)).toEqual([])
    expect(currentRules({})).toEqual([])
    expect(currentRules({ rules: 'nope' })).toEqual([])
  })
})

describe('compileRules', () => {
  it('trims patterns, drops blanks, and keeps declaration order', () => {
    const compiled = compileRules([
      { providers: [' deepseek-* ', '', '  '], models: [], instruction: ' first ' },
      { instruction: 'second' },
    ])
    expect(compiled).toHaveLength(2)
    expect(compiled[0]?.instruction).toBe('first')
    expect(compiled[0]?.providers).toHaveLength(1)
    expect(compiled[0]?.models).toHaveLength(0)
    expect(compiled[1]?.instruction).toBe('second')
  })

  it('rejects a rule that is not a mapping', () => {
    expect(() => compileRules([null])).toThrow(TypeError)
    expect(() => compileRules(['nope'])).toThrow(TypeError)
    expect(() => compileRules([[]])).toThrow(TypeError)
  })
})

describe('selectionOf', () => {
  it('prefers the captured step selection', () => {
    expect(
      selectionOf({
        modelSelection: { provider: 'deepseek-account', model: 'deepseek-flash' },
        agent: { options: { provider: 'other', model: 'other-model' } },
      }),
    ).toEqual({ provider: 'deepseek-account', model: 'deepseek-flash' })
  })

  it('falls back to the agent live options', () => {
    expect(
      selectionOf({ agent: { options: { provider: 'deepseek-account', model: 'deepseek-pro' } } }),
    ).toEqual({ provider: 'deepseek-account', model: 'deepseek-pro' })
  })

  it('ignores non-string ids and missing contexts', () => {
    expect(selectionOf(undefined)).toEqual({ provider: undefined, model: undefined })
    expect(selectionOf({ modelSelection: { provider: 42, model: null } })).toEqual({
      provider: undefined,
      model: undefined,
    })
  })
})

describe('admits', () => {
  it('admits every value when unfiltered', () => {
    expect(admits([], 'anything')).toBe(true)
    expect(admits([], undefined)).toBe(true)
  })

  it('refuses an unknown value when filtered', () => {
    expect(admits([compileGlob('deepseek-*')], undefined)).toBe(false)
    expect(admits([compileGlob('deepseek-*')], 'deepseek-flash')).toBe(true)
  })
})

describe('instructionsFor', () => {
  it('joins every matching rule in declaration order', () => {
    const config = row([
      { providers: ['deepseek-account'], instruction: 'universal rule' },
      { models: ['deepseek-reasoner*'], instruction: 'reasoning addendum' },
      { models: ['deepseek-flash'], instruction: 'flash addendum' },
    ])
    expect(
      instructionsFor(config, {
        modelSelection: { provider: 'deepseek-account', model: 'deepseek-reasoner-max' },
      }),
    ).toBe('universal rule\n\nreasoning addendum')
  })

  it('returns an empty section when nothing matches', () => {
    const config = row([{ models: ['deepseek-pro'], instruction: 'pro only' }])
    expect(instructionsFor(config, { modelSelection: { model: 'deepseek-flash' } })).toBe('')
  })

  it('keeps blank instructions inert', () => {
    const config = row([{ instruction: '   ' }, { instruction: 'kept' }])
    expect(instructionsFor(config, {})).toBe('kept')
  })

  it('reads the live volatile list at each call', () => {
    let live: unknown[] = []
    const config = { rules: { get: () => live } }
    expect(instructionsFor(config, {})).toBe('')
    live = [{ instruction: 'edited in Settings' }]
    expect(instructionsFor(config, {})).toBe('edited in Settings')
  })

  it('fails closed on malformed rules instead of failing the model request', () => {
    expect(instructionsFor(row([null]), {})).toBe('')
  })

  it('exposes the default placement constants', () => {
    expect(DEFAULT_ORDER).toBe(9500)
    expect(DEFAULT_SECTION).toBe('deployment:model-instructions')
  })
})
