ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "pause_dispatch_claim_id" varchar(64);--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "pause_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_thread_vm_pauses" ADD COLUMN "pause_acknowledged_at" timestamp with time zone;