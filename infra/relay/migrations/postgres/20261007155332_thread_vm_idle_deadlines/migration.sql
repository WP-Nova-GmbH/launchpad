ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "pause_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "delete_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "deadline_idle_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "deadline_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "deadline_time_zone" varchar(128);--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD COLUMN "lifecycle_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_activity_delete_due" ON "relay_thread_vm_activity" ("delete_due_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_activity" ADD CONSTRAINT "relay_thread_vm_activity_deadline" CHECK (
      ("pause_due_at" IS NULL AND "delete_due_at" IS NULL AND "deadline_idle_since" IS NULL
        AND "deadline_policy_revision" IS NULL AND "deadline_time_zone" IS NULL)
      OR ("pause_due_at" IS NOT NULL AND "delete_due_at" IS NOT NULL AND "deadline_idle_since" IS NOT NULL
        AND "deadline_policy_revision" IS NOT NULL AND "deadline_policy_revision">=0
        AND "deadline_time_zone" IS NOT NULL AND "pause_due_at">"deadline_idle_since"
        AND "delete_due_at">"deadline_idle_since"));