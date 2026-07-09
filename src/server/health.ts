export interface HealthEndpoint {
  isReady(): boolean
  setReady(): void
  setNotReady(): void
}

export const createHealthEndpoint = (): HealthEndpoint => {
  let ready = false
  return {
    isReady: () => ready,
    setReady: () => {
      ready = true
    },
    setNotReady: () => {
      ready = false
    },
  }
}
