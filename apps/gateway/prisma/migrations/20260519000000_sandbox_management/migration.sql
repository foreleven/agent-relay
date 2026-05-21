CREATE TABLE "sandboxes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agent_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "spec_json" TEXT NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'stopped',
  "provider_instance_id" TEXT,
  "last_error" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sandboxes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "sandboxes_agent_id_idx" ON "sandboxes"("agent_id");
