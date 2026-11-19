import { describe, expect, it } from 'vitest'
import { greet } from './greeting.js'

describe('greet', () => {
  it('formats the configured greeting', () => {
    expect(greet('Hello', 'DSH')).toBe('Hello, DSH!')
  })
})
