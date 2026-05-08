ALTER TABLE "channel_bindings"
ADD COLUMN "session_isolation_strategy" TEXT NOT NULL DEFAULT 'sessionKey';

CREATE TABLE "session_mappings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agent_id" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "session_key" TEXT NOT NULL,
  "protocol_session_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "session_mappings_agent_id_fkey"
    FOREIGN KEY ("agent_id")
    REFERENCES "agents" ("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "session_mappings_agent_id_protocol_session_key_key"
ON "session_mappings" ("agent_id", "protocol", "session_key");

CREATE INDEX "session_mappings_protocol_protocol_session_id_idx"
ON "session_mappings" ("protocol", "protocol_session_id");
