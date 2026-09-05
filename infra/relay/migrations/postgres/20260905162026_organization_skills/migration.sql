CREATE TABLE "relay_organization_skills" (
	"organization_id" varchar(64),
	"name" varchar(64),
	"description" text NOT NULL,
	"files_json" text NOT NULL,
	"version" varchar(64) NOT NULL,
	"created_by_user_id" varchar(191) NOT NULL,
	"updated_by_user_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_organization_skills_pkey" PRIMARY KEY("organization_id","name")
);
