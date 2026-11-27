CREATE TABLE "relay_thread_vm_enrollments" (
	"allocation_id" varchar(64) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"seed_hash" varchar(64) NOT NULL UNIQUE,
	"sealed_seed" text,
	"expires_at" timestamp with time zone NOT NULL,
	"environment_id" varchar(191),
	"environment_public_key" text,
	"sealed_response" text,
	"credential_id" varchar(64),
	CONSTRAINT "relay_thread_vm_enrollments_claim" CHECK (("environment_id" IS NULL AND "environment_public_key" IS NULL AND "sealed_response" IS NULL AND "credential_id" IS NULL AND "sealed_seed" IS NOT NULL)
      OR ("environment_id" IS NOT NULL AND "environment_public_key" IS NOT NULL AND "sealed_response" IS NOT NULL AND "credential_id" IS NOT NULL AND "sealed_seed" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_enrollments" ADD CONSTRAINT "relay_thread_vm_enrollments_bepb74dZxSQN_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_enrollments" ADD CONSTRAINT "relay_thread_vm_enrollments_NXByQ9cigITF_fkey" FOREIGN KEY ("credential_id") REFERENCES "relay_environment_credentials"("credential_id");