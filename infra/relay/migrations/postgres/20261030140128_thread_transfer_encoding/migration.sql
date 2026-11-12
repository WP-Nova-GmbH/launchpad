ALTER TABLE "relay_thread_moves" ADD COLUMN "source_formats_json" jsonb DEFAULT '["launchpad-thread-chunks-v1"]' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "transfer_encoding_policy" varchar(32) DEFAULT 'v1-64MiB';--> statement-breakpoint
ALTER TABLE "relay_thread_vm_enrollments" ADD COLUMN "thread_transfer_formats_json" jsonb;--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD CONSTRAINT "relay_thread_moves_source_formats" CHECK ("source_formats_json" IN (
      '["launchpad-thread-chunks-v1"]'::jsonb, '["launchpad-thread-chunks-v2"]'::jsonb,
      '["launchpad-thread-chunks-v1","launchpad-thread-chunks-v2"]'::jsonb));--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD CONSTRAINT "relay_thread_moves_encoding_policy" CHECK ("transfer_encoding_policy" IS NULL OR
      "transfer_encoding_policy" IN ('v1-64MiB','workspace-raw-v2-8MiB'));--> statement-breakpoint
ALTER TABLE "relay_thread_vm_enrollments" ADD CONSTRAINT "relay_thread_vm_enrollments_transfer_formats" CHECK ("thread_transfer_formats_json" IS NULL OR (
      "environment_id" IS NOT NULL AND "thread_transfer_formats_json" IN (
        '["launchpad-thread-chunks-v1"]'::jsonb, '["launchpad-thread-chunks-v2"]'::jsonb,
        '["launchpad-thread-chunks-v1","launchpad-thread-chunks-v2"]'::jsonb)));