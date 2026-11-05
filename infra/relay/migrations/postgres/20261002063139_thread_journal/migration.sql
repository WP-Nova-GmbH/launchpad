CREATE TABLE "relay_thread_commands" (
	"command_id" varchar(191) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"position" integer NOT NULL,
	"accepted_generation" integer NOT NULL,
	"actor_json" jsonb NOT NULL,
	"payload_json" jsonb NOT NULL,
	"receipt_json" jsonb,
	CONSTRAINT "relay_thread_commands_position" CHECK ("position" > 0 AND "accepted_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "relay_thread_history" (
	"thread_id" varchar(191),
	"cursor" integer,
	"environment_id" varchar(191) NOT NULL,
	"source_sequence" integer NOT NULL,
	"event_json" jsonb NOT NULL,
	CONSTRAINT "relay_thread_history_pkey" PRIMARY KEY("thread_id","cursor"),
	CONSTRAINT "relay_thread_history_cursor" CHECK ("cursor" > 0 AND "source_sequence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_commands_position" ON "relay_thread_commands" ("thread_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_history_source" ON "relay_thread_history" ("environment_id","source_sequence");--> statement-breakpoint
ALTER TABLE "relay_thread_commands" ADD CONSTRAINT "relay_thread_commands_z2yPoRGbom1F_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_history" ADD CONSTRAINT "relay_thread_history_GusR8J83drfh_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");