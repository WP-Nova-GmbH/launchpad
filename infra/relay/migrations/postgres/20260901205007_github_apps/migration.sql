CREATE TABLE "relay_github_apps" (
	"app_id" varchar(64) PRIMARY KEY,
	"app_slug" text NOT NULL,
	"private_key_sealed" text NOT NULL,
	"created_by_user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
