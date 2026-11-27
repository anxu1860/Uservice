import {
  siAlmalinux,
  siAlpinelinux,
  siApple,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siNixos,
  siOpensuse,
  siRedhat,
  siRockylinux,
  siUbuntu,
  type SimpleIcon,
} from "simple-icons";
import { cn } from "@/lib/utils";

interface OsDescriptor {
  pattern: RegExp;
  icon: SimpleIcon;
  color: string;
  label: string;
}

const OS_TABLE: OsDescriptor[] = [
  { pattern: /ubuntu/i, icon: siUbuntu, color: "#E95420", label: "Ubuntu" },
  { pattern: /debian/i, icon: siDebian, color: "#A81D33", label: "Debian" },
  { pattern: /centos/i, icon: siCentos, color: "#932279", label: "CentOS" },
  { pattern: /rocky/i, icon: siRockylinux, color: "#10B981", label: "Rocky Linux" },
  { pattern: /alma/i, icon: siAlmalinux, color: "#0069DA", label: "AlmaLinux" },
  { pattern: /red\s*hat|\brhel\b/i, icon: siRedhat, color: "#EE0000", label: "Red Hat" },
  { pattern: /fedora/i, icon: siFedora, color: "#51A2DA", label: "Fedora" },
  { pattern: /alpine/i, icon: siAlpinelinux, color: "#0D597F", label: "Alpine" },
  { pattern: /arch/i, icon: siArchlinux, color: "#1793D1", label: "Arch Linux" },
  { pattern: /suse|sles/i, icon: siOpensuse, color: "#73BA25", label: "openSUSE" },
  { pattern: /kali/i, icon: siKalilinux, color: "#557C94", label: "Kali Linux" },
  { pattern: /mint/i, icon: siLinuxmint, color: "#87CF3E", label: "Linux Mint" },
  { pattern: /gentoo/i, icon: siGentoo, color: "#54487A", label: "Gentoo" },
  { pattern: /nixos|\bnix\b/i, icon: siNixos, color: "#5277C3", label: "NixOS" },
  { pattern: /freebsd/i, icon: siFreebsd, color: "#AB2B28", label: "FreeBSD" },
  { pattern: /darwin|mac\s*os/i, icon: siApple, color: "currentColor", label: "macOS" },
];

export function detectOsDescriptor(os?: string): {
  icon: SimpleIcon;
  color: string;
  label: string;
} {
  if (os) {
    for (const entry of OS_TABLE) {
      if (entry.pattern.test(os)) {
        return entry;
      }
    }
  }
  return {
    icon: siLinux,
    color: os ? "#EAB308" : "currentColor",
    label: os || "Linux",
  };
}

interface OsIconProps {
  os?: string;
  className?: string;
}

/** Renders the brand SVG icon for the detected Linux/Unix operating system. */
export function OsIcon({ os, className }: OsIconProps) {
  const { icon, color, label } = detectOsDescriptor(os);
  return (
    <svg
      viewBox="0 0 24 24"
      fill={color}
      className={cn("h-3.5 w-3.5 shrink-0", className)}
      aria-label={label}
    >
      <path d={icon.path} />
    </svg>
  );
}
