CREATE TABLE "relay_thread_vm_previews" (
	"preview_id" varchar(32) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"thread_id" varchar(191) NOT NULL,
	"allocation_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"port" integer NOT NULL,
	"ticket_sha256" varchar(64) NOT NULL,
	"session_sha256" varchar(64),
	"ticket_expires_at" timestamp with time zone DEFAULT clock_timestamp()+interval '1 minute' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT clock_timestamp()+interval '1 hour' NOT NULL,
	CONSTRAINT "relay_thread_vm_previews_generation" CHECK ("generation">0),
	CONSTRAINT "relay_thread_vm_previews_port" CHECK ("port" BETWEEN 1024 AND 65535 AND "port" NOT IN (3773,49983))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_vm_previews_thread" ON "relay_thread_vm_previews" ("thread_id","expires_at");--> statement-breakpoint
ALTER TABLE "relay_thread_vm_previews" ADD CONSTRAINT "relay_thread_vm_previews_V8c0NqDznAbi_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");