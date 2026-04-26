export interface HealthEndpoint {
  isReady(): boolean
  setReady(): void
}

export const createHealthEndpoint = (): HealthEndpoint => {
  let ready = false
  return {
    isReady: () => ready,
    setReady: () => {
      ready = true
    },
  }
}
