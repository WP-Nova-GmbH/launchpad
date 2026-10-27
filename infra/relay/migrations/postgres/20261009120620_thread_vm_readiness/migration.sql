CREATE VIEW "relay_thread_vm_ready" AS (
  SELECT p.allocation_id, b.environment_id, b.generation, 'ready'::varchar(16) AS phase,
    coalesce(s.receipt_sha256, m.manifest_sha256) AS receipt_sha256
  FROM relay_thread_vm_provisions p
  JOIN relay_thread_vm_bindings b ON b.allocation_id=p.allocation_id
    AND b.generation=p.generation AND b.revoked_at IS NULL
  LEFT JOIN relay_thread_vm_setups s ON s.allocation_id=p.allocation_id
    AND s.environment_id=b.environment_id AND s.phase='ready' AND s.receipt_sha256 IS NOT NULL
  LEFT JOIN relay_thread_vm_move_destinations d ON d.allocation_id=p.allocation_id
    AND d.operation_id=p.operation_id
  LEFT JOIN relay_thread_moves m ON m.operation_id=d.operation_id AND m.thread_id=b.thread_id
    AND m.destination_environment_id=b.environment_id AND m.expected_generation+1=b.generation
    AND m.phase='completed'
  WHERE p.phase='created' AND (s.receipt_sha256 IS NOT NULL OR m.manifest_sha256 IS NOT NULL)
);