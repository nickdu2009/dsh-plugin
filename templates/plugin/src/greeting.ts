/** Compose the text returned by the `__TOOL__` tool. */
export function greet(greeting: string, name: string): string {
  return `${greeting}, ${name}!`
}
