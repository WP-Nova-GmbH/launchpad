CREATE TABLE "relay_thread_move_artifacts" (
	"operation_id" varchar(64) PRIMARY KEY,
	"manifest_artifact_id" varchar(64) NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_thread_move_artifacts_manifest" ON "relay_thread_move_artifacts" ("manifest_artifact_id");--> statement-breakpoint
ALTER TABLE "relay_thread_move_artifacts" ADD CONSTRAINT "relay_thread_move_artifacts_5vdFCX6BzZwg_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_thread_moves"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_move_artifacts" ADD CONSTRAINT "relay_thread_move_artifacts_3ab7SSvY6JO7_fkey" FOREIGN KEY ("manifest_artifact_id") REFERENCES "relay_thread_artifacts"("artifact_id");