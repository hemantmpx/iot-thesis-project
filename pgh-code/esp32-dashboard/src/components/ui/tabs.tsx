import * as React from "react"

const TabsContext = React.createContext<any>(null)

export function Tabs({ defaultValue, children }: { defaultValue: string, children: React.ReactNode }) {
  const [value, setValue] = React.useState(defaultValue)
  return (
    <TabsContext.Provider value={{ value, setValue }}>
      {children}
    </TabsContext.Provider>
  )
}

export function TabsList({ children }: { children: React.ReactNode }) {
  return <div className="flex border-b mb-2">{children}</div>
}

export function TabsTrigger({ value, children }: { value: string, children: React.ReactNode }) {
  const ctx = React.useContext(TabsContext)
  return (
    <button
      onClick={() => ctx.setValue(value)}
      className={`px-3 py-1.5 text-sm font-medium ${
        ctx.value === value ? "border-b-2 border-foreground" : "hover:bg-muted"
      }`}
    >
      {children}
    </button>
  )
}

export function TabsContent({ value, children }: { value: string, children: React.ReactNode }) {
  const ctx = React.useContext(TabsContext)
  if (ctx.value !== value) return null
  return <div className="mt-2">{children}</div>
}
