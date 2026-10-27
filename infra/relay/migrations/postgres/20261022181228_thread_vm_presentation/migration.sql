CREATE TABLE "relay_thread_move_progress" (
	"operation_id" varchar(64),
	"environment_id" varchar(191),
	"generation" integer NOT NULL,
	"attempt" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"stage" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "relay_thread_move_progress_pkey" PRIMARY KEY("operation_id","environment_id")
);
--> statement-breakpoint
ALTER TABLE "relay_thread_move_progress" ADD CONSTRAINT "relay_thread_move_progress_qipH8oE2S7Xm_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_thread_moves"("operation_id") ON DELETE CASCADE;