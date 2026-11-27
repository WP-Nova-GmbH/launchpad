import type { RelayRepository, RelayRepositoryId } from "@t3tools/contracts/relay";
import { TrashIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

export function RemoveRepositoryButton({
  repository,
  disabled,
  onRemove,
}: {
  repository: RelayRepository;
  disabled: boolean;
  onRemove: (id: RelayRepositoryId) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const identity = repository.canonicalKeys[0] ?? repository.repositoryId;

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove repository ${identity}`}
        disabled={disabled}
        onClick={(event) => {
          returnFocus.current = event.currentTarget;
          setConfirming(true);
        }}
      >
        <TrashIcon />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup initialFocus={cancel} finalFocus={returnFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {repository.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Removing <strong className="wrap-anywhere">{identity}</strong> from this organization
              revokes access to its workflows and runs, including saved results. Its access grants,
              workflow variables, and secrets will be permanently deleted. Files on GitHub and in
              local checkouts are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose ref={cancel} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                returnFocus.current =
                  returnFocus.current?.ownerDocument.getElementById(
                    "organization-repositories-description",
                  ) ?? null;
                setConfirming(false);
                void onRemove(repository.repositoryId);
              }}
            >
              Remove repository
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
