CREATE TABLE "relay_organization_provider_accounts" (
	"organization_id" varchar(64),
	"provider" varchar(32),
	"kind" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"payload_sealed" text NOT NULL,
	"version" varchar(64) NOT NULL,
	"created_by_user_id" varchar(191) NOT NULL,
	"updated_by_user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_organization_provider_accounts_pkey" PRIMARY KEY("organization_id","provider")
);
