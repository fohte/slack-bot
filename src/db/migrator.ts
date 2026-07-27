import { fileURLToPath } from 'node:url'

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
)

export const runMigrations = async (databaseUrl: string): Promise<void> => {
  const client = postgres(databaseUrl, { max: 1 })
  // eslint-disable-next-line no-restricted-syntax -- boundary: drizzle-kit migration runner, process entrypoint fail-fast; finally guarantees the postgres client closes even on migration failure
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end()
  }
}
