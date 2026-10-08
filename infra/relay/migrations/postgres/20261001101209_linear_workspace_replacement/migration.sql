ALTER TABLE "relay_issue_tracker_connections" ADD COLUMN "authorization_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_issue_tracker_connections" ADD COLUMN "replacement" jsonb;