import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { ResultAsync } from 'neverthrow'

import { ConversationCheckpointSchemaSetupError } from '@/types/errors'

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
export const setupConversationCheckpointSchema = (
  databaseUrl: string,
): ResultAsync<void, ConversationCheckpointSchemaSetupError> => {
  const checkpointer = createConversationCheckpointer(databaseUrl)
  return ResultAsync.fromPromise(
    checkpointer.setup().finally(() => checkpointer.end()),
    (caughtErr) =>
      new ConversationCheckpointSchemaSetupError(
        'failed to set up conversation checkpoint schema',
        caughtErr,
      ),
  )
}
