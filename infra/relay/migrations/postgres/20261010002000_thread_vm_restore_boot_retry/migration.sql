ALTER TABLE relay_thread_vm_restores
  ADD COLUMN boot_recovery_started_at timestamptz,
  ADD COLUMN boot_attempt integer NOT NULL DEFAULT 0 CHECK (boot_attempt >= 0),
  ADD COLUMN retired_boot_receipts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(retired_boot_receipts) = 'array');--> statement-breakpoint

ALTER TABLE relay_thread_vm_restores DROP CONSTRAINT relay_thread_vm_restores_boot_prepared;--> statement-breakpoint
ALTER TABLE relay_thread_vm_restores ADD CONSTRAINT relay_thread_vm_restores_boot_prepared CHECK (
  phase NOT IN ('boot_prepared','committed','booted','importing','completed') OR
  (boot_prepare_started_at IS NOT NULL AND boot_receipt IS NOT NULL) OR
  (phase='committed' AND boot_receipt IS NULL AND boot_attempt > 0
    AND jsonb_array_length(retired_boot_receipts)=boot_attempt
    AND retired_boot_receipts->-1->>'physicallyStopped'='true')
);--> statement-breakpoint
