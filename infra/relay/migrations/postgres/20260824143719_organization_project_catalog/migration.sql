CREATE TABLE "relay_organization_project_catalogs" (
	"environment_id" varchar(191) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"machine_id" varchar(64) NOT NULL,
	"revision" integer NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_organization_projects" (
	"environment_id" varchar(191),
	"project_id" varchar(191),
	"organization_id" varchar(64) NOT NULL,
	"machine_id" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"repository_canonical_key" text,
	"project_created_at" varchar(64) NOT NULL,
	"project_updated_at" varchar(64) NOT NULL,
	"catalog_updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_organization_projects_pkey" PRIMARY KEY("environment_id","project_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_org_project_catalogs_organization" ON "relay_organization_project_catalogs" ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_relay_org_projects_organization" ON "relay_organization_projects" ("organization_id","project_updated_at");--> statement-breakpoint
CREATE INDEX "idx_relay_org_projects_repository" ON "relay_organization_projects" ("repository_canonical_key");