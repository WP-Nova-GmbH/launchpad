CREATE TABLE "relay_issue_tracker_connections" (
	"organization_id" varchar(64),
	"service" varchar(16),
	"version" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"account_label" text,
	"payload_sealed" text,
	"pending_state_hash" text,
	"pending_expires_at" varchar(64),
	"updated_by_user_id" varchar(191) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_issue_tracker_connections_pkey" PRIMARY KEY("organization_id","service")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_issue_tracker_pending_state" ON "relay_issue_tracker_connections" ("pending_state_hash");--> statement-breakpoint
ALTER TABLE "relay_issue_tracker_connections" ADD CONSTRAINT "relay_issue_tracker_connections_hebJBW51rJmT_fkey" FOREIGN KEY ("organization_id") REFERENCES "relay_organizations"("organization_id") ON DELETE CASCADE;