CREATE TABLE "relay_thread_vm_replacements" (
	"request_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"owner_user_id" varchar(191) NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"template_id" varchar(191) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"intent_json" text NOT NULL,
	"phase" varchar(24) NOT NULL,
	"victim_allocation_id" varchar(64),
	"final_save_operation_id" varchar(64),
	"position" bigserial,
	"checked_at" timestamp with time zone,
	"error_code" varchar(64),
	CONSTRAINT "relay_thread_vm_replacements_phase" CHECK ("phase" IN ('awaiting_choice','waiting','admitted','cancelled')),
	CONSTRAINT "relay_thread_vm_replacements_victim" CHECK (("victim_allocation_id" IS NULL) = ("final_save_operation_id" IS NULL) AND ("phase" != 'waiting' OR "victim_allocation_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_replacements_thread" ON "relay_thread_vm_replacements" ("thread_id") WHERE "phase" IN ('awaiting_choice','waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_vm_replacements_victim" ON "relay_thread_vm_replacements" ("victim_allocation_id") WHERE "phase" = 'waiting';--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_replacements_work" ON "relay_thread_vm_replacements" ("host_id","phase","checked_at","position");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_replacements" ADD CONSTRAINT "relay_thread_vm_replacements_NktJKQ0e9Z4o_fkey" FOREIGN KEY ("victim_allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_replacements" ADD CONSTRAINT "relay_thread_vm_replacements_nELw70xdqgnS_fkey" FOREIGN KEY ("final_save_operation_id") REFERENCES "relay_thread_vm_final_saves"("operation_id");