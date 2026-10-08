ALTER TABLE "relay_issue_tracker_connections" ADD COLUMN "pending_oauth_sealed" text;
--> statement-breakpoint
DELETE FROM "relay_issue_tracker_connections" WHERE "service" = 'jira' AND "payload_sealed" IS NULL;
--> statement-breakpoint
UPDATE "relay_issue_tracker_connections"
SET "status" = 'reconnect_required', "payload_sealed" = NULL, "authorization_id" = NULL,
    "pending_state_hash" = NULL, "pending_expires_at" = NULL, "jira_selection" = NULL
WHERE "service" = 'jira';
