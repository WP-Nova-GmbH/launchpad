CREATE TABLE "relay_thread_native_checkpoint_operations" (
	"operation_id" varchar(64) PRIMARY KEY,
	"checkpoint_operation_id" varchar(64) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "relay_thread_native_checkpoint_operations_phase" CHECK ("phase" IN ('active','released'))
);
--> statement-breakpoint
ALTER TABLE "relay_thread_native_checkpoints" ADD COLUMN "artifact_count" integer NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_relay_thread_native_checkpoint_operations_point" ON "relay_thread_native_checkpoint_operations" ("checkpoint_operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_native_checkpoint_operations" ADD CONSTRAINT "relay_thread_native_checkpoint_operations_BXPpzWq1iSWY_fkey" FOREIGN KEY ("checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_native_checkpoints" ADD CONSTRAINT "relay_thread_native_checkpoints_artifact_count" CHECK ("artifact_count" > 0);