-- CreateEnum
CREATE TYPE "payroll_event_type" AS ENUM ('BANK_ACCOUNT_CHANGE', 'ADDRESS_CHANGE', 'SALARY_CHANGE');

-- CreateEnum
CREATE TYPE "payroll_event_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED_TEMPORARY', 'FAILED_PERMANENT');

-- CreateTable
CREATE TABLE "payroll_events" (
    "id" UUID NOT NULL,
    "event_type" "payroll_event_type" NOT NULL,
    "employee_id" UUID NOT NULL,
    "effective_date" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "payroll_event_status" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(255) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "started_processing_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payroll_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_event_history" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "previous_status" "payroll_event_status",
    "new_status" "payroll_event_status" NOT NULL,
    "details" JSONB,
    "actor" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_event_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applied_operations" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "operation_key" VARCHAR(255) NOT NULL,
    "result" JSONB,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applied_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_payroll_events_employee_created" ON "payroll_events"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_payroll_events_status" ON "payroll_events"("status");

-- CreateIndex
CREATE INDEX "ix_payroll_events_status_next_attempt" ON "payroll_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payroll_events_idempotency_key" ON "payroll_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "ix_payroll_event_history_event_created" ON "payroll_event_history"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_applied_operations_event" ON "applied_operations"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_applied_operations_event_operation" ON "applied_operations"("event_id", "operation_key");

-- AddForeignKey
ALTER TABLE "payroll_event_history" ADD CONSTRAINT "payroll_event_history_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "payroll_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applied_operations" ADD CONSTRAINT "applied_operations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "payroll_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

