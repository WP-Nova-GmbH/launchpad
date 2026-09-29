CREATE TABLE "relay_repository_policy_acknowledgements" (
	"environment_id" varchar(191),
	"organization_id" varchar(64),
	"environment_public_key" text,
	"endpoint_http_base_url" text,
	"applied_revision" integer NOT NULL,
	CONSTRAINT "relay_repository_policy_acknowledgements_pkey" PRIMARY KEY("organization_id","environment_id","environment_public_key")
);
--> statement-breakpoint
CREATE TABLE "relay_repository_policy_revisions" (
	"organization_id" varchar(64) PRIMARY KEY,
	"revision" integer NOT NULL
);

--> statement-breakpoint
INSERT INTO relay_repository_policy_revisions (organization_id, revision)
 SELECT organization_id, 1 FROM relay_organizations ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO relay_repository_policy_acknowledgements (environment_id, organization_id, environment_public_key, endpoint_http_base_url, applied_revision)
 SELECT environment_id, organization_id, COALESCE(environment_public_key, ''), endpoint_http_base_url, 0 FROM relay_machines WHERE environment_id IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION relay_bump_repository_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org text;
BEGIN
 org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
 INSERT INTO relay_repository_policy_revisions(organization_id, revision) VALUES (org, 1)
 ON CONFLICT (organization_id) DO UPDATE SET revision = relay_repository_policy_revisions.revision + 1;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER repository_policy_members AFTER INSERT OR UPDATE OR DELETE ON relay_organization_members
 FOR EACH ROW EXECUTE FUNCTION relay_bump_repository_policy();
--> statement-breakpoint
CREATE TRIGGER repository_policy_repositories AFTER INSERT OR UPDATE OR DELETE ON relay_repositories
 FOR EACH ROW EXECUTE FUNCTION relay_bump_repository_policy();
--> statement-breakpoint
CREATE TRIGGER repository_policy_aliases AFTER INSERT OR UPDATE OR DELETE ON relay_repository_aliases
 FOR EACH ROW EXECUTE FUNCTION relay_bump_repository_policy();
--> statement-breakpoint
CREATE TRIGGER repository_policy_grants AFTER INSERT OR UPDATE OR DELETE ON relay_repository_access
 FOR EACH ROW EXECUTE FUNCTION relay_bump_repository_policy();
--> statement-breakpoint
CREATE FUNCTION relay_enroll_repository_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.environment_id IS NOT NULL THEN
  INSERT INTO relay_repository_policy_revisions(organization_id, revision) VALUES (NEW.organization_id, 1)
   ON CONFLICT (organization_id) DO UPDATE SET revision = relay_repository_policy_revisions.revision + 1;
  INSERT INTO relay_repository_policy_acknowledgements(environment_id, organization_id, environment_public_key, endpoint_http_base_url, applied_revision)
   VALUES(NEW.environment_id, NEW.organization_id, COALESCE(NEW.environment_public_key, ''), NEW.endpoint_http_base_url, 0)
   ON CONFLICT (organization_id, environment_id, environment_public_key) DO UPDATE SET applied_revision = 0, endpoint_http_base_url = EXCLUDED.endpoint_http_base_url;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER repository_policy_enrollment AFTER INSERT OR UPDATE OF organization_id, environment_id, environment_public_key ON relay_machines
 FOR EACH ROW EXECUTE FUNCTION relay_enroll_repository_policy();

--> statement-breakpoint
CREATE FUNCTION relay_refresh_repository_policy_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE relay_repository_policy_acknowledgements SET endpoint_http_base_url = NEW.endpoint_http_base_url
  WHERE organization_id = NEW.organization_id AND environment_id = NEW.environment_id AND environment_public_key = COALESCE(NEW.environment_public_key, '');
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER repository_policy_endpoint AFTER UPDATE OF endpoint_http_base_url ON relay_machines
 FOR EACH ROW EXECUTE FUNCTION relay_refresh_repository_policy_endpoint();
