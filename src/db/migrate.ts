import { runMigrations } from '@/db/migrator'

const databaseUrl = process.env['DATABASE_URL']
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL environment variable is required')
}

await runMigrations(databaseUrl)
