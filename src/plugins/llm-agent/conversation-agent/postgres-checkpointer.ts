import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

// LangGraph owns this schema end-to-end (tables are created by
// PostgresSaver.setup(), not by a Drizzle migration); Drizzle-managed tables
// stay out of it.
export const CONVERSATION_CHECKPOINT_SCHEMA = 'langgraph'

export const createConversationCheckpointer = (
  databaseUrl: string,
): PostgresSaver =>
  PostgresSaver.fromConnString(databaseUrl, {
    schema: CONVERSATION_CHECKPOINT_SCHEMA,
  })

// Creates the checkpoint schema/tables if they don't exist yet. Intended to
// run once per deploy, at the same migration-equivalent timing as the
// Drizzle migrations in src/db/migrate.ts.
export const setupConversationCheckpointSchema = async (
  databaseUrl: string,
): Promise<void> => {
  const checkpointer = createConversationCheckpointer(databaseUrl)
  try {
    await checkpointer.setup()
  } finally {
    await checkpointer.end()
  }
}
