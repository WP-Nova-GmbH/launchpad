import type { HTMLAttributes } from "react";

import launchpadMark from "../../../../assets/prod/launchpad-mark.png";

export function LaunchpadMark(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="img"
      aria-label="Launchpad"
      {...props}
      style={{
        display: "inline-block",
        backgroundColor: "currentColor",
        maskImage: `url(${launchpadMark})`,
        maskSize: "contain",
        maskPosition: "center",
        maskRepeat: "no-repeat",
        ...props.style,
      }}
    />
  );
}
