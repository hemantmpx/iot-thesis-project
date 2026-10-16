import * as React from "react"

export function Switch({ id, checked, onCheckedChange }: { id?: string, checked?: boolean, onCheckedChange?: (c: boolean) => void }) {
  return (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className="h-4 w-4 rounded border cursor-pointer"
    />
  )
}
