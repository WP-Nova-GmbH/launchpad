CREATE TABLE "relay_repository_workflow_configurations" (
	"repository_id" varchar(64) PRIMARY KEY,
	"revision" integer NOT NULL,
	"entries" jsonb NOT NULL,
	CONSTRAINT "repo_workflow_configuration_revision" CHECK ("revision" > 0),
	CONSTRAINT "repo_workflow_configuration_entries" CHECK (jsonb_typeof("entries") = 'array')
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_run_configurations" (
	"job_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"repository_id" varchar(64) NOT NULL,
	"thread_id" varchar(191) NOT NULL,
	"source_revision" integer NOT NULL,
	"has_secrets" boolean NOT NULL,
	"sealed_payload" text NOT NULL,
	CONSTRAINT "workflow_run_configuration_revision" CHECK ("source_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "relay_repository_workflow_configurations" ADD CONSTRAINT "relay_repository_workflow_configurations_teAO9zi0NCSb_fkey" FOREIGN KEY ("repository_id") REFERENCES "relay_repositories"("repository_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "relay_workflow_run_configurations" ADD CONSTRAINT "workflow_run_configuration_job_tenant_fk" FOREIGN KEY ("job_id","organization_id","repository_id") REFERENCES "relay_workflow_jobs"("job_id","organization_id","repository_id") ON DELETE CASCADE;