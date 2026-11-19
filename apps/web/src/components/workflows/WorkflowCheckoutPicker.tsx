import type { RelayOrganizationProject } from "@t3tools/contracts/relay";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import { useMemo, useState, type Ref } from "react";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { WorkflowAlert } from "./WorkflowAlert";
import styles from "./workflowEditor.module.css";

function sameCheckout(left: RelayOrganizationProject, right: RelayOrganizationProject) {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

function checkoutNameKey(checkout: RelayOrganizationProject) {
  return JSON.stringify(
    [checkout.title, checkout.machineLabel].map((label) => label.replace(/\s+/g, " ")),
  );
}

function CheckoutIdentity({
  checkout,
  showIdentifier,
}: {
  checkout: RelayOrganizationProject;
  showIdentifier: boolean;
}) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5 text-left wrap-anywhere">
      <span className="font-medium">{checkout.title}</span>
      <span className="text-xs text-muted-foreground">{checkout.machineLabel}</span>
      {showIdentifier ? (
        <span className="text-xs text-muted-foreground">
          Environment {checkout.environmentId} / Checkout {checkout.projectId}
        </span>
      ) : null}
    </span>
  );
}

export function WorkflowCheckoutPicker({
  id,
  projects,
  selected,
  warning,
  disabled,
  triggerRef,
  onChoose,
}: {
  id: string;
  projects: ReadonlyArray<RelayOrganizationProject>;
  selected: RelayOrganizationProject | null;
  warning: string | null;
  disabled: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  onChoose: (checkout: RelayOrganizationProject) => void;
}) {
  const [query, setQuery] = useState("");
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      const key = checkoutNameKey(project);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [projects]);
  const nameIsShared = (project: RelayOrganizationProject) =>
    (nameCounts.get(checkoutNameKey(project)) ?? 0) > 1;
  const search = query.trim().toLocaleLowerCase();
  const options = search
    ? projects.filter(
        (project) =>
          project.title.toLocaleLowerCase().includes(search) ||
          project.machineLabel.toLocaleLowerCase().includes(search),
      )
    : projects;

  return (
    <div className={styles["workflow-settings-field"]}>
      <label id={`${id}-label`} htmlFor={id}>
        Checkout
      </label>
      {warning ? (
        <div id={`${id}-warning`}>
          <WorkflowAlert variant="warning" title={warning}>
            Choose another checkout. Your workflow edits are kept.
          </WorkflowAlert>
        </div>
      ) : null}
      <Combobox
        disabled={disabled}
        items={options}
        filter={null}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(project) => project.title}
        isItemEqualToValue={sameCheckout}
        value={selected}
        onValueChange={(project) => {
          if (project && (!selected || !sameCheckout(project, selected))) onChoose(project);
        }}
      >
        <ComboboxTrigger
          render={<Button variant="outline" size="sm-multiline" />}
          id={id}
          aria-labelledby={`${id}-label ${id}-selection`}
          aria-describedby={warning ? `${id}-warning` : undefined}
          ref={triggerRef}
          className="w-full min-w-0"
        >
          <FolderGit2Icon aria-hidden />
          <span id={`${id}-selection`} className="flex min-w-0 flex-1 text-left">
            {selected ? (
              <CheckoutIdentity checkout={selected} showIdentifier={nameIsShared(selected)} />
            ) : warning ? (
              "Choose a replacement"
            ) : (
              "Choose a checkout"
            )}
          </span>
          <ChevronDownIcon aria-hidden />
        </ComboboxTrigger>
        <ComboboxPopup aria-labelledby={`${id}-label`} className="w-(--anchor-width)">
          <ComboboxSearchInput
            aria-label="Search checkouts by name or machine"
            placeholder="Checkout or machine"
            autoComplete="off"
            spellCheck={false}
          />
          <ComboboxEmpty>No matching checkouts</ComboboxEmpty>
          <ComboboxList aria-label="Available checkouts">
            {(project: RelayOrganizationProject) => (
              <ComboboxItem
                key={JSON.stringify([project.environmentId, project.projectId])}
                value={project}
              >
                <CheckoutIdentity checkout={project} showIdentifier={nameIsShared(project)} />
                {selected && sameCheckout(project, selected) ? <CheckIcon aria-hidden /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
