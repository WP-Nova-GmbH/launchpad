CREATE TABLE "relay_thread_vm_bindings" (
	"environment_id" varchar(191) PRIMARY KEY,
	"allocation_id" varchar(64) NOT NULL UNIQUE,
	"thread_id" varchar(191) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"generation" integer NOT NULL,
	"environment_public_key" text NOT NULL,
	"credential_id" varchar(64) NOT NULL UNIQUE,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "relay_thread_vm_bindings_generation" CHECK ("generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_bindings" ADD CONSTRAINT "relay_thread_vm_bindings_tSLvEfBF5Fhu_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_bindings" ADD CONSTRAINT "relay_thread_vm_bindings_86MZ8oYEns2p_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_bindings" ADD CONSTRAINT "relay_thread_vm_bindings_5EJlmBUUVA2K_fkey" FOREIGN KEY ("credential_id") REFERENCES "relay_environment_credentials"("credential_id");