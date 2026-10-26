import type { DesktopSshEnvironmentTarget, EnvironmentMachineKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

/**
 * How this client reaches a machine, printed first in every environment row so
 * Launchpad Connect, SSH, WSL, and plain remote links are told apart without a legend.
 */
export function environmentTransportLabel(environment: EnvironmentPresentation): string {
  const { entry } = environment;
  if (entry.target._tag === "PrimaryConnectionTarget") return "This machine";
  if (environment.relayManaged) return "Launchpad Connect";
  if (isDesktopLocalConnectionTarget(entry.target)) return "WSL";
  if (
    entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
  ) {
    return `SSH ${formatDesktopSshTarget(entry.profile.value.target)}`;
  }
  return environment.displayUrl ?? "Remote link";
}

/**
 * One machine in a grouped settings list: icon, name, a single subtitle line,
 * and controls on the right. Every environment list on the Connections page
 * uses this so the lists share one rhythm.
 */
export function EnvironmentRow({
  kind,
  label,
  subtitle,
  below,
  dimmed = false,
  className,
  children,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly label: string;
  readonly subtitle: ReactNode;
  /** Extra content under the subtitle, such as update progress. */
  readonly below?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4",
        dimmed && "opacity-60",
        className,
      )}
    >
      <span className="col-start-1 row-start-1 inline-flex size-5 items-center justify-center">
        <EnvironmentMachineIcon aria-hidden kind={kind} className="size-4 text-muted-foreground" />
      </span>
      <p className="col-start-2 row-start-1 min-w-0 truncate text-sm font-medium text-foreground">
        {label}
      </p>
      <div className="col-start-2 row-start-2 min-w-0">
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="col-start-3 row-start-1 flex min-h-7 shrink-0 items-center gap-1 sm:min-h-6">
        {children}
      </div>
    </div>
  );
}
