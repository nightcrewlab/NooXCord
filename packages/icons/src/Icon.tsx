import { memo, type SVGProps } from "react";
import { icons, type IconName } from "./icons";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
  /** Accessible label. Omit for decorative icons (aria-hidden). */
  label?: string;
}

export const Icon = memo(function Icon({ name, size = 20, label, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      // Static, trusted markup from our own icon table.
      dangerouslySetInnerHTML={{ __html: icons[name] }}
      {...rest}
    />
  );
});
