DELETE FROM "relay_issue_tracker_connections" WHERE "service" = 'linear' AND "payload_sealed" IS NULL;
--> statement-breakpoint
UPDATE "relay_issue_tracker_connections"
SET "status" = 'reconnect_required', "payload_sealed" = NULL, "authorization_id" = NULL,
    "pending_state_hash" = NULL, "pending_expires_at" = NULL, "pending_oauth_sealed" = NULL,
    "replacement" = NULL, "version" = gen_random_uuid()::text
WHERE "service" = 'linear';
