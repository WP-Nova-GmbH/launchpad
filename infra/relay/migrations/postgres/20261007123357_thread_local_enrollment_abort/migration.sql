CREATE TABLE "relay_thread_local_enrollment_aborts" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"project_id" varchar(191) NOT NULL,
	"actor_user_id" varchar(191) NOT NULL,
	"canonical_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_thread_local_enrollments" DROP CONSTRAINT "relay_thread_local_enrollment_phase", ADD CONSTRAINT "relay_thread_local_enrollment_phase" CHECK ("phase" IN ('preparing','active','aborted'));