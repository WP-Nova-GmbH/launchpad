CREATE TABLE "relay_organization_invitations" (
	"invitation_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"email" text NOT NULL,
	"role" varchar(16) NOT NULL,
	"invited_by_user_id" varchar(191) NOT NULL,
	"token_hash" varchar(191) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"accepted_at" varchar(64),
	"accepted_by_user_id" varchar(191),
	"revoked_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_organization_members" (
	"organization_id" varchar(64),
	"user_id" varchar(191),
	"role" varchar(16) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_organization_members_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "relay_organizations" (
	"organization_id" varchar(64) PRIMARY KEY,
	"name" text NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_repositories" (
	"repository_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_repository_access" (
	"repository_id" varchar(64),
	"user_id" varchar(191),
	"organization_id" varchar(64) NOT NULL,
	"role" varchar(16) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_repository_access_pkey" PRIMARY KEY("repository_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "relay_repository_aliases" (
	"canonical_key" text PRIMARY KEY,
	"repository_id" varchar(64) NOT NULL,
	"organization_id" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_organization_invitations_token" ON "relay_organization_invitations" ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_relay_organization_invitations_organization" ON "relay_organization_invitations" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_relay_organization_invitations_email" ON "relay_organization_invitations" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_organization_members_user" ON "relay_organization_members" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_relay_organization_members_role" ON "relay_organization_members" ("organization_id","role");--> statement-breakpoint
CREATE INDEX "idx_relay_repositories_organization" ON "relay_repositories" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_relay_repository_access_user" ON "relay_repository_access" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_relay_repository_aliases_repository" ON "relay_repository_aliases" ("repository_id");