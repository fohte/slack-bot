import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const databaseUrl = process.env['DATABASE_URL']
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL environment variable is required')
}

const client = postgres(databaseUrl, { max: 1 })
try {
  await migrate(drizzle(client), { migrationsFolder: './drizzle' })
} finally {
  await client.end()
}
