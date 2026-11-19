/** ACP v1 session configuration values used by the native model selector. */
export interface AcpConfigValue {
  value: string
  name: string
  description?: string
}

export interface AcpSelectConfig {
  id: string
  name: string
  category?: string
  type: 'select'
  currentValue: string
  options: readonly (AcpConfigValue | AcpConfigValueGroup)[]
}

export interface AcpConfigValueGroup {
  group: string
  name?: string
  options: readonly AcpConfigValue[]
}

export interface AcpConfigGroup {
  id: string
  name: string
  category?: string
  type: 'group'
  options: readonly AcpConfigOption[]
}

export type AcpConfigOption = AcpSelectConfig | AcpConfigGroup

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate and flatten only ACP select options; unknown update shapes are ignored. */
export function selectConfigs(options: unknown): AcpSelectConfig[] {
  if (!Array.isArray(options)) return []
  const result: AcpSelectConfig[] = []
  const visit = (value: unknown, inheritedCategory?: string): void => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return
    const category = typeof value.category === 'string' ? value.category : inheritedCategory
    if (value.type === 'group') {
      if (Array.isArray(value.options)) {
        for (const child of value.options) visit(child, category)
      }
      return
    }
    if (
      value.type !== 'select' ||
      typeof value.currentValue !== 'string' ||
      !Array.isArray(value.options)
    )
      return
    const values: (AcpConfigValue | AcpConfigValueGroup)[] = []
    for (const entry of value.options) {
      if (!isRecord(entry)) continue
      if (typeof entry.value === 'string' && typeof entry.name === 'string') {
        values.push({
          value: entry.value,
          name: entry.name,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        })
      } else if (typeof entry.group === 'string' && Array.isArray(entry.options)) {
        const children = entry.options.flatMap((child): AcpConfigValue[] => {
          if (!isRecord(child) || typeof child.value !== 'string' || typeof child.name !== 'string')
            return []
          return [
            {
              value: child.value,
              name: child.name,
              ...(typeof child.description === 'string' ? { description: child.description } : {}),
            },
          ]
        })
        values.push({
          group: entry.group,
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          options: children,
        })
      }
    }
    result.push({
      id: value.id,
      name: value.name,
      ...(category ? { category } : {}),
      type: 'select',
      currentValue: value.currentValue,
      options: values,
    })
  }
  for (const option of options) visit(option)
  return result
}

export function configValues(option: AcpSelectConfig): AcpConfigValue[] {
  return option.options.flatMap((entry) => ('value' in entry ? [entry] : [...entry.options]))
}

export function configByCategory(
  options: readonly AcpSelectConfig[],
  category: 'model' | 'thought_level',
): AcpSelectConfig | undefined {
  return options.find((option) => option.category === category)
}

export function hasConfigValue(option: AcpSelectConfig, value: string): boolean {
  return configValues(option).some((entry) => entry.value === value)
}

export function selectedConfigValue(
  option: AcpSelectConfig | undefined,
): AcpConfigValue | undefined {
  return option === undefined
    ? undefined
    : configValues(option).find((entry) => entry.value === option.currentValue)
}
