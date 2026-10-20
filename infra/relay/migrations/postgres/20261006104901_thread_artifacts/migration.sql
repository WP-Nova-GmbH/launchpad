CREATE TABLE "relay_thread_artifact_pins" (
	"artifact_id" varchar(64),
	"operation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_artifact_pins_pkey" PRIMARY KEY("artifact_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "relay_thread_artifacts" (
	"artifact_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"operation_id" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"storage_key" varchar(191) NOT NULL UNIQUE,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"state" varchar(16) NOT NULL,
	"delete_claim_id" varchar(64),
	"delete_claim_until" timestamp with time zone,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	CONSTRAINT "relay_thread_artifacts_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "relay_thread_artifacts_size" CHECK ("size_bytes" >= 0),
	CONSTRAINT "relay_thread_artifacts_kind" CHECK ("kind" IN ('workspace','native','attachment','history','manifest')),
	CONSTRAINT "relay_thread_artifacts_state" CHECK ("state" IN ('pending','complete','deleting','deleted'))
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_artifact_pins_operation" ON "relay_thread_artifact_pins" ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_relay_thread_artifacts_thread" ON "relay_thread_artifacts" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_relay_thread_artifacts_retention" ON "relay_thread_artifacts" ("state","retention_until");--> statement-breakpoint
ALTER TABLE "relay_thread_artifact_pins" ADD CONSTRAINT "relay_thread_artifact_pins_xgJDUK5r0wPj_fkey" FOREIGN KEY ("artifact_id") REFERENCES "relay_thread_artifacts"("artifact_id");--> statement-breakpoint
ALTER TABLE "relay_thread_artifacts" ADD CONSTRAINT "relay_thread_artifacts_vZH87S5c2b8q_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");