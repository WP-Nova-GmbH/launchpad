---
status: accepted
---

# Job approvals are resolved by a supervisor model that escalates on uncertainty

Pipeline steps run in `approval-required` runtime mode, so the provider genuinely *requests*
approval for its actions — but no human is at the keyboard. A **supervisor model**, configured
per organization and typically stronger than the working model, answers those requests. When it
is not confident, it escalates to a human instead of guessing.

## Mechanics

- The existing approval plumbing carries this unchanged: `approval.requested` →
  `approval.resolved`. Only the responder differs.
- The supervisor returns a three-way verdict — **approve / deny / escalate** — not a confidence
  score. A verdict is a decision the model can actually make; a self-reported number needs a
  threshold nobody can calibrate.
- Requests are classified by `ProviderRuntimeToolKind` before any model call. `file-read`
  auto-approves without invoking the supervisor. `command` is where supervision earns its cost.
- **Escalate** pauses the job, which is already visible: the thread enters
  `waiting_for_approval`, that phase flows up the awareness feed, the relay marks the job
  paused, and a notification fires. A human resolves it through the normal steering path.
- **Deny** feeds back to the agent with its reasoning, exactly as a human denial does. It does
  not fail the step — a supervisor that kills the job on first denial makes pipelines brittle.
- Every verdict is recorded as an activity on the thread, with reasoning. Per
  [ADR-0007](./0007-the-org-layer-is-defaults-not-enforcement.md), visibility is the control, so
  "why did the agent do that" must stay answerable.

The supervisor model is selected from org config, following the existing pattern of
`textGenerationModelSelection` and `sourceControlWriterModelSelection` — a model configured for a
non-primary task.

## Consequences

- Supervision cost scales with `command` approvals per step, not with total tool calls.
- Stalls are unpredictable by construction: the same action may escalate on one run and not the
  next. That is acceptable because a paused job is visible and notified rather than silent, but
  it means "why did this job stall" needs the recorded verdict to answer.
- **Uncertainty-based escalation gives no protection when the supervisor is confidently wrong.**
  A model that is sure about a `git push --force` will not escalate it. Checkpoints make
  workspace mistakes cheap to reverse (`refs/t3/checkpoints/*`), but actions that leave the
  workspace — pushing to shared branches, opening or merging pull requests, deleting refs,
  spending money, external communication — have no such backstop. If that risk proves real, the
  cheap mitigation is a small category floor that always escalates regardless of the verdict,
  which composes with this decision rather than replacing it.
