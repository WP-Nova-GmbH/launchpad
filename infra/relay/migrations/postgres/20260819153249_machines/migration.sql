CREATE TABLE "relay_machines" (
	"machine_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"role" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"compute_kind" varchar(32) NOT NULL,
	"compute_ref" varchar(191),
	"seed_hash" varchar(191) NOT NULL,
	"seed_expires_at" varchar(64) NOT NULL,
	"environment_id" varchar(191),
	"environment_public_key" text,
	"endpoint_http_base_url" text,
	"endpoint_ws_base_url" text,
	"endpoint_provider_kind" varchar(32),
	"created_by_user_id" varchar(191) NOT NULL,
	"enrolled_at" varchar(64),
	"deprovisioned_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_organization_machine_limits" (
	"organization_id" varchar(64) PRIMARY KEY,
	"max_machines" integer NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_machines_seed_hash" ON "relay_machines" ("seed_hash");--> statement-breakpoint
CREATE INDEX "idx_relay_machines_organization" ON "relay_machines" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_relay_machines_environment" ON "relay_machines" ("environment_id","deprovisioned_at");