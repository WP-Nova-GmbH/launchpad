CREATE TABLE "relay_thread_vm_codex_preferences" (
	"thread_id" varchar(191) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"revision" bigint NOT NULL,
	"mode" varchar(16),
	"connection_id" varchar(64),
	CONSTRAINT "relay_thread_vm_codex_preferences_revision" CHECK ("revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "relay_thread_vm_codex_preferences_selection" CHECK (("mode" IS NULL AND "connection_id" IS NULL) OR ("mode" IS NOT NULL AND (("mode"='personal' AND "connection_id" IS NULL) OR ("mode"='organization' AND "connection_id" IS NOT NULL))))
);
--> statement-breakpoint
ALTER TABLE "relay_thread_vm_codex_preferences" ADD CONSTRAINT "relay_thread_vm_codex_preferences_FWtlfxZST4Ur_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");