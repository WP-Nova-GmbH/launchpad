CREATE TABLE "relay_thread_vm_move_destinations" (
	"operation_id" varchar(64) PRIMARY KEY,
	"allocation_id" varchar(64) NOT NULL UNIQUE
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_move_destinations" ADD CONSTRAINT "relay_thread_vm_move_destinations_z9zneCEwQx0i_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_thread_moves"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_move_destinations" ADD CONSTRAINT "relay_thread_vm_move_destinations_RmivAGQtOYTn_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");