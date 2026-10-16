// button.tsx
import * as React from "react";
import { motion } from "framer-motion";

export function Button({
  children,
  className = "",
  variant = "default",
  loading = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "success" | "danger" | "ghost" | "secondary";
  loading?: boolean;
}) {
  const variantStyles = {
    default: "bg-primary text-white hover:bg-primary/90",
    success: "bg-green-600 text-white hover:bg-green-700",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "bg-transparent hover:bg-muted",
    secondary: "bg-muted text-foreground hover:bg-muted/80",
  }[variant];

  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      whileHover={{ scale: 1.03 }}
      disabled={loading || props.disabled}
      className={`inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium shadow-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 ${variantStyles} ${className}`}
      {...props}
    >
      {loading && <SpinnerIcon />}
      {children}
    </motion.button>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin h-4 w-4 mr-2 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}
