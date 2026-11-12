CREATE TABLE "relay_thread_current_queues" (
	"thread_id" varchar(191) PRIMARY KEY,
	"cursor" integer NOT NULL,
	"queue_json" jsonb NOT NULL,
	CONSTRAINT "relay_thread_current_queues_cursor" CHECK ("cursor" >= 0)
);
