CREATE TABLE "relay_thread_native_checkpoints" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"turn_id" varchar(191) NOT NULL,
	"source_environment_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"source_sequence" integer NOT NULL,
	"native_thread_id" varchar(64) NOT NULL,
	"native_manifest_sha256" varchar(64) NOT NULL,
	"archive_sha256" varchar(64) NOT NULL,
	"manifest_artifact_id" varchar(64) NOT NULL,
	"manifest_sha256" varchar(64) NOT NULL,
	"retained" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_native_checkpoints_sequence" CHECK ("generation" > 0 AND "source_sequence" >= 0),
	CONSTRAINT "relay_thread_native_checkpoints_sha256" CHECK ("archive_sha256" ~ '^[0-9a-f]{64}$' AND "native_manifest_sha256" ~ '^[0-9a-f]{64}$' AND "manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_native_checkpoints_turn" ON "relay_thread_native_checkpoints" ("thread_id","generation","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_native_checkpoints_manifest" ON "relay_thread_native_checkpoints" ("manifest_artifact_id");--> statement-breakpoint
CREATE INDEX "idx_relay_thread_native_checkpoints_latest" ON "relay_thread_native_checkpoints" ("thread_id","generation","source_sequence");--> statement-breakpoint
ALTER TABLE "relay_thread_native_checkpoints" ADD CONSTRAINT "relay_thread_native_checkpoints_1E7AxPKTCiRo_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_native_checkpoints" ADD CONSTRAINT "relay_thread_native_checkpoints_YtdFzAUxKGoJ_fkey" FOREIGN KEY ("manifest_artifact_id") REFERENCES "relay_thread_artifacts"("artifact_id");