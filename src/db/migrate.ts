import { runMigrations } from '@/db/migrator'
import { setupConversationCheckpointSchema } from '@/plugins/llm-agent/conversation-agent/postgres-checkpointer'

const databaseUrl = process.env['DATABASE_URL']
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL environment variable is required')
}

await runMigrations(databaseUrl)
// Separate migration system: LangGraph's PostgresSaver owns the checkpoint
// schema and creates its own tables, so this runs alongside (not through)
// the Drizzle migrations above.
await setupConversationCheckpointSchema(databaseUrl)
