CREATE TABLE "relay_jobs" (
	"job_id" varchar(64) PRIMARY KEY,
	"environment_id" varchar(191) NOT NULL,
	"owner_user_id" varchar(191) NOT NULL,
	"repository_canonical_key" text NOT NULL,
	"base_branch" text NOT NULL,
	"instruction" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"thread_id" varchar(191),
	"detail" text,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_jobs_owner" ON "relay_jobs" ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_relay_jobs_environment" ON "relay_jobs" ("environment_id","created_at");