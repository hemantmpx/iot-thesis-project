// select.tsx
import * as React from "react";

// Context to hold selected value and change handler
const SelectContext = React.createContext<any>(null);

export function Select({
  value,
  onValueChange,
  children,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <SelectContext.Provider value={{ value, onValueChange }}>
      {children}
    </SelectContext.Provider>
  );
}

export function SelectTrigger({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <button className={`border rounded px-2 py-1 ${className}`}>{children}</button>;
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  const ctx = React.useContext(SelectContext);
  return <span>{ctx?.value || placeholder}</span>;
}

export function SelectContent({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 border rounded shadow bg-background">{children}</div>;
}

export function SelectItem({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(SelectContext);
  const isSelected = ctx?.value === value;

  const handleClick = () => {
    if (ctx?.onValueChange) ctx.onValueChange(value);
  };

  return (
    <div
      className={`px-3 py-1.5 cursor-pointer hover:bg-muted ${
        isSelected ? "font-semibold text-primary" : ""
      }`}
      onClick={handleClick}
    >
      {children}
    </div>
  );
}
