ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "native_checkpoint_operation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "source_sequence" integer;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "source_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD CONSTRAINT "relay_thread_vm_pauses_source_certificate" CHECK (
      ("native_checkpoint_operation_id" IS NULL AND "source_sequence" IS NULL AND "source_frozen_at" IS NULL)
      OR ("native_checkpoint_operation_id" IS NOT NULL AND "source_sequence" IS NOT NULL AND "source_sequence" >= 0 AND "source_frozen_at" IS NOT NULL AND "boot_id" IS NOT NULL));