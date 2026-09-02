CREATE TABLE "runtime_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_run_id" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_runs" ADD CONSTRAINT "runtime_runs_thread_id_runtime_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."runtime_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_threads" ADD CONSTRAINT "runtime_threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_runs_thread_started_idx" ON "runtime_runs" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "runtime_threads_owner_updated_idx" ON "runtime_threads" USING btree ("owner_user_id","updated_at");