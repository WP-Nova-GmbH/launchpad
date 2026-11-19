ALTER TABLE "relay_thread_moves" ADD COLUMN "cancellation_protocol" varchar(16) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "source_reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "cancellation_blocker" varchar(32);--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "legacy_cancel_command_id" varchar(191);--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD CONSTRAINT "relay_thread_moves_cancellation_protocol" CHECK ("cancellation_protocol" IN ('legacy','available','source-reopen-v1'));--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD COLUMN "source_message_id" varchar(191);--> statement-breakpoint
ALTER TABLE "relay_thread_commands" ADD COLUMN "relay_move_cancel_operation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_thread_commands" ADD CONSTRAINT "relay_thread_commands_S7eklUHWkZiq_fkey" FOREIGN KEY ("relay_move_cancel_operation_id") REFERENCES "relay_thread_moves"("operation_id");