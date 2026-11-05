-- Already booted restores retained their original base image pin. Only repair
-- the exact surviving destination backed by its verified saved snapshot.
UPDATE relay_thread_vm_allocations AS a
SET template_id = r.source_template_id
FROM relay_thread_vm_restores AS r
JOIN relay_thread_vm_saved_disks AS s ON s.operation_id = r.saved_disk_operation_id
JOIN relay_thread_vm_final_saves AS f ON f.operation_id = s.operation_id
JOIN relay_thread_vm_backups AS b ON b.operation_id = s.backup_operation_id
JOIN relay_thread_vm_allocations AS source ON source.allocation_id = f.allocation_id
WHERE a.allocation_id = r.allocation_id
  AND a.thread_id = r.thread_id AND s.thread_id = r.thread_id
  AND a.deleted_at IS NULL AND a.compute_ref = r.boot_receipt->>'sandboxID'
  AND a.template_id = source.template_id
  AND r.serving_requested AND r.phase IN ('booted', 'importing', 'completed')
  AND r.committed_at IS NOT NULL
  AND r.boot_receipt->>'operationID' = r.operation_id
  AND r.boot_receipt->>'generation' = (r.generation + 1)::text
  AND f.phase = 'completed' AND f.generation = r.generation
  AND f.native_checkpoint_operation_id = r.native_checkpoint_operation_id
  AND f.backup_operation_id = b.operation_id AND b.phase = 'verified'
  AND b.source_template_id = r.source_template_id
  AND b.source_build_id = r.source_build_id;
