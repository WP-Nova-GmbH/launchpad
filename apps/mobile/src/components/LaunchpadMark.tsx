import { Image, type ColorValue } from "react-native";
import { withUniwind } from "uniwind";

const ThemedImage = withUniwind(Image, {
  tintColor: { fromClassName: "colorClassName", styleProperty: "accentColor" },
});

export function LaunchpadMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedImage
      source={require("../../../../assets/prod/launchpad-mark.png")}
      accessibilityLabel="Launchpad"
      tintColor={props.color}
      colorClassName={props.colorClassName}
      style={{ width: props.height, height: props.height }}
    />
  );
}
