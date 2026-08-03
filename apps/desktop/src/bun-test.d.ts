declare module 'bun:test' {
  export const describe: (name: string, callback: () => void) => void
  export const test: (name: string, callback: () => void | Promise<void>) => void
  export const expect: (value: unknown) => any
  type MockFn = ((...args: any[]) => any) & {
    mock: { calls: any[][]; results: { type: 'return' | 'throw'; value: unknown }[] }
    toHaveBeenCalled: () => void
    toHaveBeenCalledTimes: (n: number) => void
    toHaveBeenCalledWith: (...args: any[]) => void
    mockReturnValue: <R>(value: R) => MockFn
    mockImplementation: <F extends (...args: any[]) => any>(fn: F) => MockFn
  }
  export const mock: {
    (factory?: (...args: any[]) => any): MockFn
    module: (id: string, factory: () => Record<string, unknown>) => Promise<void>
  }
}
