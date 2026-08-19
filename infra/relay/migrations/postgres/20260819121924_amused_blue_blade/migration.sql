CREATE TABLE "relay_github_installations" (
	"organization_id" varchar(64) PRIMARY KEY,
	"installation_id" varchar(64) NOT NULL,
	"account_login" text NOT NULL,
	"account_type" varchar(32) NOT NULL,
	"connected_by_user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_github_installations_installation" ON "relay_github_installations" ("installation_id");