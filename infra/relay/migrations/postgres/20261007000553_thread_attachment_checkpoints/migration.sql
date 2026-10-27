CREATE TABLE "relay_thread_attachment_checkpoints" (
	"native_checkpoint_operation_id" varchar(64) PRIMARY KEY,
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"manifest_artifact_id" varchar(64) NOT NULL UNIQUE,
	"manifest_sha256" varchar(64) NOT NULL,
	"attachment_manifest_sha256" varchar(64) NOT NULL,
	"artifact_count" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_attachment_checkpoints_artifact_count" CHECK ("artifact_count" > 0),
	CONSTRAINT "relay_thread_attachment_checkpoints_sha256" CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$' AND "attachment_manifest_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "relay_thread_attachment_checkpoints" ADD CONSTRAINT "relay_thread_attachment_checkpoints_CAT6G96oSwd6_fkey" FOREIGN KEY ("native_checkpoint_operation_id") REFERENCES "relay_thread_native_checkpoints"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_attachment_checkpoints" ADD CONSTRAINT "relay_thread_attachment_checkpoints_8JQyv1MOmGrF_fkey" FOREIGN KEY ("manifest_artifact_id") REFERENCES "relay_thread_artifacts"("artifact_id");