ALTER TABLE "intelligence_channel_mappings" RENAME TO "channel_threads";--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_channel_id_channels_id_fk";
--> statement-breakpoint
DROP INDEX "intelligence_channel_mappings_thread_idx";--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_user_id_channel_id_pk";--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id");--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_thread_idx" ON "channel_threads" USING btree ("thread_id");