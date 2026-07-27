import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
)

export const runMigrations = (databaseUrl: string): Promise<void> => {
  const client = postgres(databaseUrl, { max: 1 })
  return migrate(drizzle(client), { migrationsFolder }).finally(() =>
    client.end(),
  )
}
