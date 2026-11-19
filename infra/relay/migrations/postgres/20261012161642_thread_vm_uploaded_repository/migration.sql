ALTER TABLE "relay_thread_move_checkpoints" ADD COLUMN "repository_upload" jsonb;--> statement-breakpoint
ALTER TABLE "relay_thread_move_checkpoints" ADD COLUMN "repository_retained" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_resets" ADD COLUMN "repository_upload" jsonb;