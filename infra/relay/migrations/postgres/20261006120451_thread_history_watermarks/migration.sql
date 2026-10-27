CREATE TABLE "relay_thread_history_watermarks" (
	"thread_id" varchar(191),
	"environment_id" varchar(191),
	"generation" integer,
	"source_sequence" integer NOT NULL,
	CONSTRAINT "relay_thread_history_watermarks_pkey" PRIMARY KEY("thread_id","environment_id","generation"),
	CONSTRAINT "relay_thread_history_watermarks_sequence" CHECK ("generation" > 0 AND "source_sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "relay_thread_history_watermarks" ADD CONSTRAINT "relay_thread_history_watermarks_oGryQ6ItGrKP_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");