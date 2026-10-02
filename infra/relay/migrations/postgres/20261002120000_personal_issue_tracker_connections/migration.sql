CREATE TABLE "relay_user_issue_tracker_connections" (
	"owner_user_id" varchar(191),
	"service" varchar(16),
	"version" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"account_label" text,
	"payload_sealed" text,
	"authorization_id" varchar(64),
	"replacement" jsonb,
	"jira_selection" jsonb,
	"pending_oauth_sealed" text,
	"pending_state_hash" text,
	"pending_expires_at" varchar(64),
	"updated_by_user_id" varchar(191) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_user_issue_tracker_connections_pkey" PRIMARY KEY("owner_user_id","service")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_user_issue_tracker_pending_state" ON "relay_user_issue_tracker_connections" ("pending_state_hash");