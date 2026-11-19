import { Input } from "../ui/input";
import { WorkflowAlert } from "./WorkflowAlert";
import styles from "./workflowEditor.module.css";

export function WorkflowVmBaseBranch({
  id,
  baseBranch,
  unavailableSavedBranch,
  disabled,
  registerField,
  onChange,
}: {
  id: string;
  baseBranch: string | null;
  unavailableSavedBranch?: string | null | undefined;
  disabled: boolean;
  registerField: (field: string, node: HTMLElement | null) => void;
  onChange: (branch: string | null) => void;
}) {
  const useDefault = baseBranch === null;
  const missingName = baseBranch !== null && !baseBranch.trim();
  const rejectedBranch =
    unavailableSavedBranch !== undefined && baseBranch?.trim() === unavailableSavedBranch;
  const showUnavailable =
    unavailableSavedBranch !== undefined && useDefault === (unavailableSavedBranch === null);
  const modeName = `${id}-base-branch-mode`;
  const branchNameId = `${id}-branch-name`;
  const helpId = `${id}-base-branch-help`;
  const unavailableId = `${id}-base-branch-unavailable`;
  const optionClassName =
    "flex min-h-7.5 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm has-checked:bg-primary/8 has-[:disabled]:cursor-default has-[:disabled]:opacity-64";

  return (
    <fieldset disabled={disabled} className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="mb-1.5 text-xs font-medium">Base branch</legend>
      <div className="grid gap-1">
        <label className={optionClassName}>
          <input
            ref={(node) => registerField("baseBranch:default", node)}
            type="radio"
            name={modeName}
            value="default"
            checked={useDefault}
            aria-describedby={useDefault ? (showUnavailable ? unavailableId : helpId) : undefined}
            className="size-3.5 shrink-0 accent-primary"
            onChange={() => onChange(null)}
          />
          Repository default
        </label>
        <label className={optionClassName}>
          <input
            ref={(node) => registerField("baseBranch:specific", node)}
            type="radio"
            name={modeName}
            value="specific"
            checked={!useDefault}
            className="size-3.5 shrink-0 accent-primary"
            onChange={() => onChange("")}
          />
          Specific branch
        </label>
      </div>
      {showUnavailable ? (
        <div id={unavailableId}>
          <WorkflowAlert title="Saved branch unavailable" variant="warning">
            {unavailableSavedBranch === null ? (
              "GitHub could not resolve the repository default. Choose a specific branch with at least one commit, then save the workflow."
            ) : (
              <>
                Replace <code>{unavailableSavedBranch}</code> or select Repository default, then
                save the workflow.
              </>
            )}
          </WorkflowAlert>
        </div>
      ) : null}
      {useDefault ? (
        !showUnavailable ? (
          <p id={helpId} className="text-xs text-muted-foreground">
            {unavailableSavedBranch
              ? "Save the workflow to use GitHub’s default branch at run time."
              : "Uses GitHub’s default branch at run time."}
          </p>
        ) : null
      ) : (
        <div className={styles["workflow-settings-field"]}>
          <label htmlFor={branchNameId} className="font-medium">
            Branch name
          </label>
          <Input
            id={branchNameId}
            ref={(node) => registerField("baseBranch", node)}
            value={baseBranch}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-required="true"
            aria-invalid={missingName || rejectedBranch || undefined}
            aria-describedby={rejectedBranch ? unavailableId : helpId}
            onChange={(event) => onChange(event.target.value)}
          />
          {!rejectedBranch ? (
            <p
              id={helpId}
              className={missingName ? "text-error-foreground" : "text-muted-foreground"}
            >
              {missingName ? "Enter a branch name." : "Enter the exact branch name from GitHub."}
            </p>
          ) : null}
        </div>
      )}
    </fieldset>
  );
}
