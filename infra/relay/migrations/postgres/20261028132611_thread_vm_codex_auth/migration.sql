CREATE TABLE "relay_thread_vm_codex_auth" (
	"allocation_id" varchar(64),
	"environment_id" varchar(191),
	"generation" integer,
	"thread_id" varchar(191) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"connection_id" varchar(64),
	"acknowledged_connection_id" varchar(64),
	CONSTRAINT "relay_thread_vm_codex_auth_pkey" PRIMARY KEY("allocation_id","environment_id","generation"),
	CONSTRAINT "relay_thread_vm_codex_auth_selection" CHECK (("mode"='personal' AND "connection_id" IS NULL) OR ("mode"='organization' AND "connection_id" IS NOT NULL)),
	CONSTRAINT "relay_thread_vm_codex_auth_generation" CHECK ("generation">0),
	CONSTRAINT "relay_thread_vm_codex_auth_acknowledgement" CHECK ("acknowledged_connection_id" IS NULL OR ("mode"='organization' AND "acknowledged_connection_id"="connection_id"))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_codex_auth_thread" ON "relay_thread_vm_codex_auth" ("thread_id","generation");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_codex_auth" ADD CONSTRAINT "relay_thread_vm_codex_auth_jzBfu5Gj0XgG_fkey" FOREIGN KEY ("allocation_id") REFERENCES "relay_thread_vm_allocations"("allocation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_codex_auth" ADD CONSTRAINT "relay_thread_vm_codex_auth_OWsawEcZQX19_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");