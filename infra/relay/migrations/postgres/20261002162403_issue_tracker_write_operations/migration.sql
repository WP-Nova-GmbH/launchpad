CREATE TABLE "relay_issue_tracker_write_operations" (
	"operation_id" varchar(64) PRIMARY KEY,
	"owner_user_id" varchar(191) NOT NULL,
	"service" varchar(16) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"thread_id" varchar(191) NOT NULL,
	"command_id" varchar(191) NOT NULL,
	"provider_session_id" varchar(191) NOT NULL,
	"invocation_id" varchar(191) NOT NULL,
	"connection_version" varchar(64) NOT NULL,
	"write_generation" integer NOT NULL,
	"runtime_mode" varchar(32) NOT NULL,
	"action" varchar(32) NOT NULL,
	"target" varchar(512) NOT NULL,
	"payload_digest" varchar(64) NOT NULL,
	"payload_sealed" text,
	"baseline_sealed" text,
	"state" varchar(32) NOT NULL,
	"approved_by_user_id" varchar(191),
	"approved_at" varchar(64),
	"claimed_at" varchar(64),
	"result_resource_id" varchar(191),
	"result_url" text,
	"safe_error" text,
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_issue_tracker_write_invocation" ON "relay_issue_tracker_write_operations" ("environment_id","provider_session_id","invocation_id");--> statement-breakpoint
CREATE INDEX "idx_relay_issue_tracker_write_fingerprint" ON "relay_issue_tracker_write_operations" ("owner_user_id","service","thread_id","action","target","payload_digest");--> statement-breakpoint
CREATE INDEX "idx_relay_issue_tracker_write_expiry" ON "relay_issue_tracker_write_operations" ("expires_at","state");
