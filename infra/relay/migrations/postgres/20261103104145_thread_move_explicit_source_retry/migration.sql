ALTER TABLE "relay_thread_move_participant_status" ADD COLUMN "failure_requires_retry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_move_participant_status" DROP CONSTRAINT "relay_thread_move_participant_failure", ADD CONSTRAINT "relay_thread_move_participant_failure" CHECK ((
      "failure_attempt" IS NULL AND "failure_detail" IS NULL AND "failure_reported_at" IS NULL
      AND NOT "failure_requires_retry"
    ) OR (
      "failure_attempt" IS NOT NULL AND "failure_attempt" BETWEEN 1 AND 9007199254740991 AND "failure_detail" IS NOT NULL
      AND length(trim("failure_detail")) > 0 AND "failure_reported_at" IS NOT NULL
    ));--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "destination_verified_commit" boolean DEFAULT false NOT NULL;