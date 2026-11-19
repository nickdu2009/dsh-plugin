import { describe, expect, it } from 'vitest'
import { configByCategory, configValues, hasConfigValue, selectConfigs } from './acp-config.js'

const options = selectConfigs([
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini',
    options: [
      { value: 'gemini', name: 'Gemini' },
      {
        group: 'third-party',
        options: [{ value: 'claude', name: 'Claude', description: 'Third-party model' }],
      },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  },
])

describe('ACP session config options', () => {
  it('keeps actual model and thought_level categories, including grouped third-party models', () => {
    const models = configByCategory(options, 'model')
    const thought = configByCategory(options, 'thought_level')
    expect(configValues(models!).map((entry) => entry.value)).toEqual(['gemini', 'claude'])
    expect(configValues(thought!).map((entry) => entry.value)).toEqual(['low', 'high'])
    expect(hasConfigValue(models!, 'claude')).toBe(true)
    expect(configByCategory(options, 'thought_level')?.currentValue).toBe('medium')
  })

  it('uses a complete replacement list and can omit thought levels', () => {
    const refreshed = selectConfigs([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'plain',
        options: [{ value: 'plain', name: 'Plain' }],
      },
    ])
    expect(configValues(configByCategory(refreshed, 'model')!).map((entry) => entry.value)).toEqual(
      ['plain'],
    )
    expect(configByCategory(refreshed, 'thought_level')).toBeUndefined()
  })

  it('flattens grouped config options and ignores malformed entries', () => {
    const grouped = selectConfigs([
      {
        id: 'root',
        name: 'Root',
        category: 'model',
        type: 'group',
        options: [
          {
            id: 'child',
            name: 'Child',
            type: 'select',
            currentValue: 'one',
            options: [{ value: 'one', name: 'One' }, null],
          },
        ],
      },
    ])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.category).toBe('model')
    expect(configValues(grouped[0]!)).toEqual([{ value: 'one', name: 'One' }])
  })
})
