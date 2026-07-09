export const createDeferred = <T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
