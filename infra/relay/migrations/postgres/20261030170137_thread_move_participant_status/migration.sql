CREATE TABLE "relay_thread_move_participant_status" (
	"operation_id" varchar(64),
	"environment_id" varchar(191),
	"generation" integer NOT NULL,
	"resolved_before_attempt" bigint DEFAULT 0 NOT NULL,
	"failure_attempt" bigint,
	"failure_detail" varchar(2000),
	"failure_reported_at" timestamp with time zone,
	CONSTRAINT "relay_thread_move_participant_status_pkey" PRIMARY KEY("operation_id","environment_id"),
	CONSTRAINT "relay_thread_move_participant_generation" CHECK ("generation" > 0),
	CONSTRAINT "relay_thread_move_participant_resolution" CHECK ("resolved_before_attempt" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "relay_thread_move_participant_failure" CHECK ((
      "failure_attempt" IS NULL AND "failure_detail" IS NULL AND "failure_reported_at" IS NULL
    ) OR (
      "failure_attempt" IS NOT NULL AND "failure_attempt" BETWEEN 1 AND 9007199254740991 AND "failure_detail" IS NOT NULL
      AND length(trim("failure_detail")) > 0 AND "failure_reported_at" IS NOT NULL
    ))
);
--> statement-breakpoint
ALTER TABLE "relay_thread_move_participant_status" ADD CONSTRAINT "relay_thread_move_participant_status_ryvuwUEwPKxT_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_thread_moves"("operation_id") ON DELETE CASCADE;