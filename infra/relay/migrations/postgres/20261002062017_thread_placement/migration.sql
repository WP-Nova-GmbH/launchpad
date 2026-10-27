CREATE TABLE "relay_thread_execution_admissions" (
	"thread_id" varchar(191),
	"work_id" varchar(191),
	"environment_id" varchar(191) NOT NULL,
	"generation" integer NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "relay_thread_execution_admissions_pkey" PRIMARY KEY("thread_id","work_id"),
	CONSTRAINT "relay_thread_execution_admissions_generation" CHECK ("generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "relay_thread_moves" (
	"operation_id" varchar(64) PRIMARY KEY,
	"thread_id" varchar(191) NOT NULL,
	"actor_user_id" varchar(191) NOT NULL,
	"source_environment_id" varchar(191) NOT NULL,
	"expected_generation" integer NOT NULL,
	"destination_environment_id" varchar(191) NOT NULL,
	"destination_project_id" varchar(191) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"source_cursor" integer,
	"manifest_sha256" varchar(64),
	CONSTRAINT "relay_thread_moves_phase" CHECK ("phase" IN ('preparing','frozen','ready','committed','completed','aborting','aborted')),
	CONSTRAINT "relay_thread_moves_generation" CHECK ("expected_generation" > 0),
	CONSTRAINT "relay_thread_moves_manifest" CHECK ("phase" NOT IN ('frozen','ready','committed','completed') OR ("source_cursor" IS NOT NULL AND "source_cursor" >= 0 AND "manifest_sha256" IS NOT NULL AND "manifest_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "relay_thread_placements" (
	"thread_id" varchar(191) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"owner_user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"project_id" varchar(191) NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"operation_id" varchar(64),
	CONSTRAINT "relay_thread_placements_generation" CHECK ("generation" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_relay_thread_moves_thread" ON "relay_thread_moves" ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_relay_thread_placements_owner" ON "relay_thread_placements" ("owner_user_id");--> statement-breakpoint
ALTER TABLE "relay_thread_execution_admissions" ADD CONSTRAINT "relay_thread_execution_admissions_mT8qwAnw4wVE_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");--> statement-breakpoint
ALTER TABLE "relay_thread_moves" ADD CONSTRAINT "relay_thread_moves_ovHeJZSbaIL9_fkey" FOREIGN KEY ("thread_id") REFERENCES "relay_thread_placements"("thread_id");