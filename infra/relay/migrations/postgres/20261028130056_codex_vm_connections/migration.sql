CREATE TABLE "relay_codex_vm_connections" (
	"organization_id" varchar(64) PRIMARY KEY,
	"connection_id" varchar(64) NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"token_revision" integer DEFAULT 0 NOT NULL,
	"action_revision" integer DEFAULT 0 NOT NULL,
	"latest_attempt_id" varchar(64),
	"issuer" text,
	"subject" text,
	"client_id" text,
	"label" text,
	"status" varchar(32) NOT NULL,
	"error_code" varchar(32),
	"payload_sealed" text,
	"expires_at" varchar(64),
	"earliest_refresh_at" varchar(64),
	"refresh_attempt_id" varchar(64),
	"last_refresh_attempt_id" varchar(64),
	"refresh_started_at" varchar(64),
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_codex_vm_connections_status" CHECK ("status" IN ('disconnected','connected','reconnect_required')),
	CONSTRAINT "relay_codex_vm_connections_active" CHECK ("status" != 'connected' OR ("payload_sealed" IS NOT NULL AND "expires_at" IS NOT NULL AND "issuer" IS NOT NULL AND "subject" IS NOT NULL AND "client_id" IS NOT NULL)),
	CONSTRAINT "relay_codex_vm_connections_refresh" CHECK (("refresh_attempt_id" IS NULL) = ("refresh_started_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "relay_codex_vm_installation" (
	"key" varchar(32) PRIMARY KEY,
	"host_id" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_codex_vm_oauth_attempts" (
	"attempt_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"intent" varchar(16) NOT NULL,
	"redirect_uri" text NOT NULL,
	"state_hash" varchar(64) NOT NULL UNIQUE,
	"pending_sealed" text,
	"issued_client_id" text,
	"expected_connection_id" varchar(64) NOT NULL,
	"expected_epoch" integer NOT NULL,
	"action_revision" integer NOT NULL,
	"phase" varchar(16) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_codex_vm_oauth_intent" CHECK ("intent" IN ('connect','reconnect','replace')),
	CONSTRAINT "relay_codex_vm_oauth_phase" CHECK ("phase" IN ('pending','exchanging','completed','cancelled','denied','failed','expired','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_codex_vm_connection_id" ON "relay_codex_vm_connections" ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_relay_codex_vm_oauth_org" ON "relay_codex_vm_oauth_attempts" ("organization_id");--> statement-breakpoint
ALTER TABLE "relay_codex_vm_connections" ADD CONSTRAINT "relay_codex_vm_connections_4x1yMdikvA9G_fkey" FOREIGN KEY ("organization_id") REFERENCES "relay_organizations"("organization_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_codex_vm_oauth_attempts" ADD CONSTRAINT "relay_codex_vm_oauth_attempts_WgllKqbZPmGv_fkey" FOREIGN KEY ("organization_id") REFERENCES "relay_organizations"("organization_id") ON DELETE CASCADE;