declare const Bun: any;

interface ArrayConstructor {
  fromAsync<T = any>(iterable: AsyncIterable<T> | Iterable<T>, mapFn?: (value: T, index: number) => unknown): Promise<any[]>;
}
