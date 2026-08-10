CREATE TYPE "public"."announcement_status" AS ENUM('draft', 'pending_approval', 'approved', 'broadcast');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('resident', 'ai', 'secretary', 'system');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('open', 'in_progress', 'resolved', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."escalation_source_type" AS ENUM('complaint', 'query', 'suggestion');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('pending', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."sender_type" AS ENUM('resident', 'ai', 'secretary');--> statement-breakpoint
CREATE TYPE "public"."suggestion_category" AS ENUM('maintenance', 'security', 'amenities', 'finance');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"media_urls" text[] DEFAULT '{}' NOT NULL,
	"status" "announcement_status" DEFAULT 'draft' NOT NULL,
	"approved_by" varchar(200),
	"scheduled_at" timestamp with time zone,
	"broadcast_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" varchar(200),
	"action" varchar(100) NOT NULL,
	"entity" varchar(100) NOT NULL,
	"entity_id" varchar(100),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" varchar(32) NOT NULL,
	"resident_id" uuid NOT NULL,
	"flat_number" varchar(20) NOT NULL,
	"category" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"status" "complaint_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" uuid NOT NULL,
	"whatsapp_thread_id" varchar(100) NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "escalation_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "escalation_status" DEFAULT 'pending' NOT NULL,
	"notified_secretary_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(300) NOT NULL,
	"category" varchar(50) NOT NULL,
	"source_uri" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"sender_type" "sender_type" NOT NULL,
	"body" text NOT NULL,
	"media_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "residents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flat_number" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"phone_e164" varchar(20) NOT NULL,
	"vehicles" text[] DEFAULT '{}' NOT NULL,
	"emergency_contact" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resident_id" uuid NOT NULL,
	"category" "suggestion_category" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "complaints" ADD CONSTRAINT "complaints_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_resident_id_residents_id_fk" FOREIGN KEY ("resident_id") REFERENCES "public"."residents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_status_idx" ON "announcements" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_scheduled_at_idx" ON "announcements" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_type_idx" ON "audit_logs" USING btree ("actor_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "complaints_ticket_id_idx" ON "complaints" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "complaints_status_idx" ON "complaints" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "complaints_resident_id_idx" ON "complaints" USING btree ("resident_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_whatsapp_thread_id_idx" ON "conversations" USING btree ("whatsapp_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_resident_id_idx" ON "conversations" USING btree ("resident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_last_message_at_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "escalations_status_idx" ON "escalations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "escalations_source_idx" ON "escalations" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_category_idx" ON "knowledge_documents" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "residents_phone_e164_idx" ON "residents" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "residents_flat_number_idx" ON "residents" USING btree ("flat_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_resident_id_idx" ON "suggestions" USING btree ("resident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suggestions_category_idx" ON "suggestions" USING btree ("category");