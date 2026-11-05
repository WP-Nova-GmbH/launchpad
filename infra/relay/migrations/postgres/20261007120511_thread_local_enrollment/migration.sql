CREATE TABLE "relay_thread_local_enrollments" (
	"thread_id" varchar(191) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"phase" varchar(16) DEFAULT 'preparing' NOT NULL,
	"source_sequence" bigint,
	"receipt_count" integer,
	CONSTRAINT "relay_thread_local_enrollment_phase" CHECK ("phase" IN ('preparing','active'))
);
--> statement-breakpoint
CREATE TABLE "relay_thread_local_receipts" (
	"command_id" varchar(191) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"receipt_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_local_receipts_thread" ON "relay_thread_local_receipts" ("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_local_enrollments" ADD CONSTRAINT "relay_thread_local_enrollments_RF405Bgb3dJs_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_local_receipts" ADD CONSTRAINT "relay_thread_local_receipts_cjcwV80hAIEv_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_local_enrollments"("thread_id");