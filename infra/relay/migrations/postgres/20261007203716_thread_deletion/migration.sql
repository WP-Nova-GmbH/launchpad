CREATE TABLE "relay_thread_deletions" (
	"thread_id" varchar(191) PRIMARY KEY,
	"operation_id" varchar(191) NOT NULL UNIQUE,
	"owner_user_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"host_id" varchar(191) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"claim_id" varchar(64),
	"claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_code" varchar(64),
	CONSTRAINT "relay_thread_deletions_generation" CHECK ("generation">0),
	CONSTRAINT "relay_thread_deletions_phase" CHECK ("phase" IN ('stopping','cleaning','completed'))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_deletions_work" ON "relay_thread_deletions" ("host_id","phase","retry_at");--> statement-breakpoint
ALTER TABLE "relay_thread_deletions" ADD CONSTRAINT "relay_thread_deletions_4L1r0eCOpTxC_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");