CREATE TABLE "relay_workflow_authorizations" (
	"owner_user_id" text,
	"application_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"attempt_id" text,
	"connection_id" text,
	"expected_epoch" integer,
	"state_hash" text,
	"pending_sealed" text,
	"expires_at" text,
	"status" text,
	"error" text,
	CONSTRAINT "relay_workflow_authorizations_pkey" PRIMARY KEY("owner_user_id","application_id")
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_connections" (
	"connection_id" text PRIMARY KEY,
	"owner_user_id" text NOT NULL,
	"application_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"workspace_name" text NOT NULL,
	"viewer_name" text NOT NULL,
	"status" text NOT NULL,
	"authorization_epoch" integer DEFAULT 1 NOT NULL,
	"activated_at" text NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"payload_sealed" text,
	"health" jsonb NOT NULL,
	"lease_id" text,
	"lease_until" text,
	"refresh_started_at" text
);
--> statement-breakpoint
CREATE TABLE "relay_workflow_repository_grants" (
	"grant_id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"generation" integer NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorization_state" ON "relay_workflow_authorizations" ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_connection_owner_workspace" ON "relay_workflow_connections" ("owner_user_id","application_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_active_repository_source" ON "relay_workflow_repository_grants" ("repository_id","connection_id") WHERE NOT "revoked";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_grant_generation" ON "relay_workflow_repository_grants" ("repository_id","connection_id","generation");--> statement-breakpoint
CREATE INDEX "workflow_grant_owner_org" ON "relay_workflow_repository_grants" ("owner_user_id","organization_id");
--> statement-breakpoint
CREATE FUNCTION relay_revoke_workflow_member_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.organization_id = NEW.organization_id AND OLD.user_id = NEW.user_id THEN RETURN NULL; END IF;
 UPDATE relay_workflow_repository_grants SET revoked=true, revoked_at=COALESCE(revoked_at,clock_timestamp()::text), revoked_reason=COALESCE(revoked_reason,'owner_removed')
 WHERE organization_id=OLD.organization_id AND owner_user_id=OLD.user_id AND NOT revoked;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER workflow_source_member_removal AFTER DELETE OR UPDATE ON relay_organization_members FOR EACH ROW EXECUTE FUNCTION relay_revoke_workflow_member_sources();
--> statement-breakpoint
CREATE FUNCTION relay_revoke_deleted_workflow_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='relay_repositories' THEN
  UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,clock_timestamp()::text),revoked_reason=COALESCE(revoked_reason,'repository_removed') WHERE repository_id=OLD.repository_id AND NOT revoked;
 ELSE
  UPDATE relay_workflow_repository_grants SET revoked=true,revoked_at=COALESCE(revoked_at,clock_timestamp()::text),revoked_reason=COALESCE(revoked_reason,'organization_removed') WHERE organization_id=OLD.organization_id AND NOT revoked;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER workflow_source_repository_removal AFTER DELETE ON relay_repositories FOR EACH ROW EXECUTE FUNCTION relay_revoke_deleted_workflow_sources();
--> statement-breakpoint
CREATE TRIGGER workflow_source_organization_removal AFTER DELETE ON relay_organizations FOR EACH ROW EXECUTE FUNCTION relay_revoke_deleted_workflow_sources();
