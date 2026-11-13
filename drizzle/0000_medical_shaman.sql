CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"balance_after_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_operation_id_unique" UNIQUE("operation_id")
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_method" text NOT NULL,
	"status" text NOT NULL,
	"provider_charge_id" text,
	"failure_reason" text,
	"reconcile_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "operations_amount_check" CHECK ("operations"."amount_cents" > 0),
	CONSTRAINT "operations_status_check" CHECK ("operations"."status" IN ('PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"currency" char(3) DEFAULT 'PEN' NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_check" CHECK ("wallets"."balance_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"status" text NOT NULL,
	"result" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_result_check" CHECK ("webhook_events"."result" IN ('applied', 'ignored', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_wallets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wallets"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_user_id_wallets_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."wallets"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operations_pending_idx" ON "operations" USING btree ("status","updated_at") WHERE "operations"."status" IN ('PROCESSING', 'UNKNOWN');