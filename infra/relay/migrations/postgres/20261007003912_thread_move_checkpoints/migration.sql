CREATE TABLE "relay_thread_move_checkpoints" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"manifest_artifact_id" varchar(64) NOT NULL,
	"native_checkpoint_operation_id" varchar(64),
	"artifact_count" integer NOT NULL,
	"retained" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_thread_move_checkpoints_count" CHECK ("artifact_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_move_checkpoints_thread" ON "relay_thread_move_checkpoints" ("thread_id","verified_at");--> statement-breakpoint
ALTER TABLE "relay_thread_move_checkpoints" ADD CONSTRAINT "relay_thread_move_checkpoints_WZQbMOvOd9xQ_fkey" FOREIGN KEY ("operation_id") REFERENCES "relay_thread_moves"("operation_id");--> statement-breakpoint
ALTER TABLE "relay_thread_move_checkpoints" ADD CONSTRAINT "relay_thread_move_checkpoints_KZpmyhmaL3Yu_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_move_checkpoints" ADD CONSTRAINT "relay_thread_move_checkpoints_XHzpkODtQiu5_fkey" FOREIGN KEY ("manifest_artifact_id") REFERENCES "relay_thread_artifacts"("artifact_id");