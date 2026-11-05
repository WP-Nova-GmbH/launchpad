CREATE TABLE "relay_thread_vm_backup_pins" (
	"backup_operation_id" varchar(64),
	"operation_id" varchar(64),
	CONSTRAINT "relay_thread_vm_backup_pins_pkey" PRIMARY KEY("backup_operation_id","operation_id")
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backup_pins" ADD CONSTRAINT "relay_thread_vm_backup_pins_kdZnBHl7qXcI_fkey" FOREIGN KEY ("backup_operation_id") REFERENCES "relay_thread_vm_backups"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_backups" DROP CONSTRAINT "relay_thread_vm_backups_phase", ADD CONSTRAINT "relay_thread_vm_backups_phase" CHECK ("phase" IN ('pending','creating','captured','verifying','cleanup','verified','failed','retiring','retired'));