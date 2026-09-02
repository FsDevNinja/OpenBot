CREATE TABLE "cloud_agent_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"instruction" text NOT NULL,
	"remote_run_id" text,
	"status" text NOT NULL,
	"result" text,
	"duration_ms" integer,
	"git" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cloud_agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"requesting_agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"originating_run_id" text NOT NULL,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"repository_url" text NOT NULL,
	"starting_ref" text,
	"initial_instruction" text NOT NULL,
	"status" text NOT NULL,
	"remote_agent_id" text NOT NULL,
	"remote_url" text,
	"result" text,
	"branch" text,
	"pull_request_url" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cloud_agent_task_runs" ADD CONSTRAINT "cloud_agent_task_runs_task_id_cloud_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."cloud_agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_agent_tasks" ADD CONSTRAINT "cloud_agent_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_agent_task_runs_sequence_idx" ON "cloud_agent_task_runs" USING btree ("task_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_agent_task_runs_remote_idx" ON "cloud_agent_task_runs" USING btree ("remote_run_id");--> statement-breakpoint
CREATE INDEX "cloud_agent_task_runs_task_created_idx" ON "cloud_agent_task_runs" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_agent_tasks_owner_created_idx" ON "cloud_agent_tasks" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "cloud_agent_tasks_active_idx" ON "cloud_agent_tasks" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_agent_tasks_remote_agent_idx" ON "cloud_agent_tasks" USING btree ("provider","remote_agent_id");