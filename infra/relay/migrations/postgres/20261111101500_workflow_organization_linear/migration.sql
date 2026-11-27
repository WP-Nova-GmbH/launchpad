-- Organization installations require fresh consent. Keep definitions, event history and admitted
-- job identities, but remove the credentials and grants that could authorize a legacy first Start.
UPDATE relay_repository_workflows
SET automation_enabled = false,
    source_application_id = NULL, source_workspace_id = NULL, trigger_team_id = NULL,
    trigger_event = NULL, trigger_grant_id = NULL, effective_after = NULL, target_capability = NULL,
    routing_generation = routing_generation + 1,
    revision = revision + 1,
    record = jsonb_set(jsonb_set(record, '{automation,enabled}', 'false'::jsonb), '{revision}', to_jsonb(revision + 1))
WHERE automation_enabled OR record#>>'{automation,trigger,grantId}' IS NOT NULL;--> statement-breakpoint
DELETE FROM relay_workflow_repository_grants;--> statement-breakpoint
DELETE FROM relay_workflow_authorizations;--> statement-breakpoint
DELETE FROM relay_workflow_connections;--> statement-breakpoint
DROP TRIGGER workflow_source_member_removal ON relay_organization_members;--> statement-breakpoint
DROP FUNCTION relay_revoke_workflow_member_sources();--> statement-breakpoint
ALTER TABLE "relay_workflow_authorizations" RENAME COLUMN "owner_user_id" TO "organization_id";--> statement-breakpoint
ALTER TABLE "relay_workflow_connections" RENAME COLUMN "owner_user_id" TO "organization_id";--> statement-breakpoint
DROP INDEX "workflow_connection_owner_workspace";--> statement-breakpoint
DROP INDEX "workflow_grant_owner_org";--> statement-breakpoint
ALTER TABLE "relay_workflow_authorizations" ADD COLUMN "initiating_user_id" text;--> statement-breakpoint
ALTER TABLE "relay_workflow_authorizations" ADD COLUMN "exchange_lease_until" text;--> statement-breakpoint
ALTER TABLE "relay_workflow_repository_grants" DROP COLUMN "owner_user_id";--> statement-breakpoint
ALTER TABLE "relay_workflow_connections" ADD CONSTRAINT "workflow_connection_id_organization" UNIQUE("connection_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorization_application" ON "relay_workflow_authorizations" ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorization_organization" ON "relay_workflow_authorizations" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_connection_organization" ON "relay_workflow_connections" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_connection_application" ON "relay_workflow_connections" ("application_id");--> statement-breakpoint
CREATE INDEX "workflow_grant_organization" ON "relay_workflow_repository_grants" ("organization_id");--> statement-breakpoint
ALTER TABLE "relay_workflow_repository_grants" ADD CONSTRAINT "workflow_grant_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "relay_workflow_connections"("connection_id","organization_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_revoke_deleted_workflow_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='relay_repositories' THEN
  UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,clock_timestamp()::text),revoked_reason=COALESCE(revoked_reason,'repository_removed') WHERE repository_id=OLD.repository_id AND NOT revoked;
 ELSE
  UPDATE relay_workflow_authorizations SET version=version+1,status='cancelled',state_hash=NULL,pending_sealed=NULL,error=NULL WHERE organization_id=OLD.organization_id AND status IN ('pending','exchanging');
  UPDATE relay_workflow_connections SET status='disconnected',authorization_epoch=authorization_epoch+1,credential_version=credential_version+1,payload_sealed=NULL,delivery_evidence=NULL,lease_id=NULL,lease_until=NULL,refresh_started_at=NULL WHERE organization_id=OLD.organization_id;
  UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,clock_timestamp()::text),revoked_reason=COALESCE(revoked_reason,'organization_removed') WHERE organization_id=OLD.organization_id AND NOT revoked;
 END IF;
 RETURN NULL;
END $$;
