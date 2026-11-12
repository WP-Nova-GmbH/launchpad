ALTER TABLE "relay_thread_move_checkpoints" ADD COLUMN "workspace_branch" text;--> statement-breakpoint
ALTER TABLE "relay_thread_move_checkpoints" ADD COLUMN "workspace_revision" varchar(64);