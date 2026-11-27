import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DropdownOption<T extends string | number = string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
}

interface DropdownSelectProps<T extends string | number = string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly DropdownOption<T>[];
  placeholder?: string;
  variant?: "field" | "compact";
  align?: "left" | "right";
  className?: string;
  menuClassName?: string;
  ariaLabel?: string;
}

export function DropdownSelect<T extends string | number = string>({
  value,
  onChange,
  options,
  placeholder = "请选择...",
  variant = "field",
  align = "left",
  className,
  menuClassName,
  ariaLabel,
}: DropdownSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const selectedOption = options.find((opt) => opt.value === value);

  const triggerBase =
    variant === "field"
      ? "flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-background/80 px-3 py-2 text-xs text-foreground outline-none transition hover:border-border/90 hover:bg-background focus:border-primary"
      : "inline-flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground outline-none ring-1 ring-black/10 transition hover:bg-muted/80 dark:ring-white/10";

  return (
    <div ref={rootRef} className={cn("relative", variant === "field" ? "w-full" : "inline-block")}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          triggerBase,
          open && (variant === "field" ? "border-primary ring-2 ring-primary/15" : "ring-primary/50"),
          className
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {selectedOption?.icon && (
            <span className="flex shrink-0 items-center">{selectedOption.icon}</span>
          )}
          <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 opacity-60 transition-transform duration-200 [transition-timing-function:var(--ease-apple)]",
            open && "rotate-180 opacity-90"
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "motion-popover-down absolute top-[calc(100%+6px)] z-50 max-h-64 min-w-full overflow-y-auto rounded-[14px] border border-border bg-card/95 p-1.5 shadow-[0_12px_36px_rgb(0_0_0/0.16)] backdrop-blur-xl",
            align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            menuClassName
          )}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-xs transition",
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-foreground hover:bg-muted/80"
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {opt.icon && (
                    <span className="flex shrink-0 items-center">{opt.icon}</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{opt.label}</span>
                    {opt.description && (
                      <span className="block truncate text-[10px] opacity-60">
                        {opt.description}
                      </span>
                    )}
                  </span>
                </span>
                {active && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
