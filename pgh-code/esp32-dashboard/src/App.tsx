import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  Bell,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  Filter,
  Gauge,
  Moon,
  Play,
  RefreshCcw,
  Search,
  Server,
  Settings,
  Sun,
  Thermometer,
  Waves,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  BarChart,
  Bar,
} from "recharts";

// shadcn/ui components (assumed available in environment)
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

/************************************
 * ESP32 IoT Dashboard Frontend
 * Fancy, clean UI layered on top of existing Flask API
 *
 * Assumptions:
 * - Flask API is running at the same origin (e.g., http://localhost:5000)
 * - Endpoints available:
 *   GET / -> status
 *   GET /devices -> list of current devices
 *   GET /logs/<mac> -> last 20 logs for device
 *   GET /alerts/<mac> -> last 20 alerts for device
 *   POST /data -> ingest reading (JSON)
 *
 ************************************/

// --- CONFIG ---
const BASE_URL = import.meta?.env?.VITE_API_BASE_URL || ""; // same-origin by default
console.log("API BASE_URL = ", import.meta.env.VITE_API_BASE_URL);
const POLL_MS = 5000; // auto-refresh interval

// --- Helpers ---
const fmtTime = (t) => {
  if (!t) return "";
  const isoLike = t.includes("T") ? t : t.replace(" ", "T");
  const d = new Date(isoLike);
  if (isNaN(d)) return t;
  return d.toLocaleString();
};

const downloadText = (filename, text) => {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const toCSV = (rows) => {
  if (!rows?.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) =>
    v == null
      ? ""
      : String(v).includes(",")
      ? `"${String(v).replaceAll('"', '""')}"`
      : String(v);
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ].join("\n");
};

// --- API client ---
async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.headers.get("content-type")?.includes("application/json")
    ? res.json()
    : res.text();
}

// --- Theme Toggle ---
function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );

  useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [dark]);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setDark((d) => !d)}
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}

// --- Status Pill ---
function StatusPill({ ok, label }) {
  return (
    <Badge className={`text-xs ${ok ? "bg-emerald-600" : "bg-rose-600"}`}>
      {ok ? "Online" : "Offline"}
      {label ? ` · ${label}` : ""}
    </Badge>
  );
}

// --- Header ---
function Header({ statusOK }) {
  return (
    <div className="sticky top-0 z-20 backdrop-blur supports-[backdrop-filter]:bg-background/70 bg-background/90 border-b">
      <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-3">
        <Cpu className="h-6 w-6" />
        <div className="flex-1">
          <div className="font-semibold leading-tight">
            Hemant's ESP32 IoT Dashboard
          </div>
          <div className="text-xs text-muted-foreground">
            Made for Thesis 2 way communication testing
          </div>
        </div>
        <StatusPill ok={statusOK} />
        <ThemeToggle />
      </div>
    </div>
  );
}

// --- KPI Card ---
function KPI({ icon: Icon, title, value, desc }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {title}
          </CardTitle>
          <Icon className="h-5 w-5" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value}</div>
        <CardDescription className="text-xs">{desc}</CardDescription>
      </CardContent>
    </Card>
  );
}

// --- Devices Table ---
function DevicesTable({ devices, onSelect }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("last_seen_desc");

  const filtered = useMemo(() => {
    const f =
      devices?.filter((d) =>
        q ? d.mac?.toLowerCase().includes(q.toLowerCase()) : true
      ) || [];

    switch (sort) {
      case "temp_desc":
        f.sort(
          (a, b) =>
            (b.temperature ?? -Infinity) - (a.temperature ?? -Infinity)
        );
        break;
      case "temp_asc":
        f.sort(
          (a, b) =>
            (a.temperature ?? Infinity) - (b.temperature ?? Infinity)
        );
        break;
      case "last_seen_asc":
        f.sort((a, b) => new Date(a.last_seen) - new Date(b.last_seen));
        break;
      case "last_seen_desc":
      default:
        f.sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen));
    }

    return f;
  }, [devices, q, sort]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Devices</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8 w-56"
                placeholder="Filter by MAC…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="last_seen_desc">Newest seen</SelectItem>
                <SelectItem value="last_seen_asc">Oldest seen</SelectItem>
                <SelectItem value="temp_desc">Temp ↓</SelectItem>
                <SelectItem value="temp_asc">Temp ↑</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2">MAC</th>
                <th className="text-right py-2">Temperature (°C)</th>
                <th className="text-right py-2">Humidity (%)</th>
                <th className="text-right py-2">Last Seen</th>
                <th className="text-right py-2">Status</th>
                <th className="text-right py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const last = d.last_seen
                  ? new Date(d.last_seen.replace(" ", "T"))
                  : null;
                const online = last
                  ? Date.now() - last.getTime() < 60 * 1000 * 2
                  : false; // seen within 2min

                return (
                  <tr key={d.mac} className="border-b hover:bg-muted/40">
                    <td className="py-2 font-mono">{d.mac}</td>
                    <td className="py-2 text-right">
                      {d.temperature ?? "—"}
                    </td>
                    <td className="py-2 text-right">
                      {d.humidity ?? "—"}
                    </td>
                    <td className="py-2 text-right">
                      {fmtTime(d.last_seen)}
                    </td>
                    <td className="py-2 text-right">
                      <StatusPill ok={online} />
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onSelect(d.mac)}
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                );
              })}

              {!filtered.length && (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-6 text-muted-foreground"
                  >
                    No devices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
// --- Mini Chart ---
function DeviceMiniChart({ logs }) {
  const data = (logs || [])
    .slice()
    .reverse()
    .map((r) => ({
      time: r.timestamp,
      temperature: r.temperature,
      humidity: r.humidity,
    }));

  return (
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="time"
            tickFormatter={(v) =>
              new Date(v.replace(" ", "T")).toLocaleTimeString()
            }
            minTickGap={28}
          />
          <YAxis yAxisId="left" />
          <YAxis yAxisId="right" orientation="right" />
          <Tooltip labelFormatter={(v) => fmtTime(v)} />
          <Legend />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="temperature"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="humidity"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// --- Alerts Panel ---
function AlertsPanel({ mac, alerts }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4" /> Alerts{" "}
            {mac ? (
              <span className="font-mono text-xs rounded bg-muted px-2 py-0.5">
                {mac}
              </span>
            ) : null}
          </CardTitle>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {(alerts || []).map((a, i) => (
          <div
            key={i}
            className="flex items-center gap-3 border rounded-lg p-3"
          >
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <div className="text-sm">
              <div className="font-medium">Temperature exceeded 30°C</div>
              <div className="text-xs text-muted-foreground">
                {fmtTime(a.timestamp)} · {a.temperature}°C · {a.humidity}% RH
              </div>
            </div>
          </div>
        ))}

        {!alerts?.length && (
          <div className="text-sm text-muted-foreground">No alerts yet.</div>
        )}
      </CardContent>
    </Card>
  );
}
// --- Logs Explorer ---
function LogsExplorer({ mac, logs }) {
  const [view, setView] = useState("table");

  const download = () =>
    downloadText(`${mac || "logs"}.csv`, toCSV(logs));

  const chartData = (logs || []).slice().reverse();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4" /> Logs{" "}
            {mac ? (
              <span className="font-mono text-xs rounded bg-muted px-2 py-0.5">
                {mac}
              </span>
            ) : null}
          </CardTitle>

          <div className="ml-auto flex items-center gap-2">
            <Select value={view} onValueChange={setView}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="View" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="table">Table</SelectItem>
                <SelectItem value="chart">Chart</SelectItem>
                <SelectItem value="bars">Bars</SelectItem>
              </SelectContent>
            </Select>

            <Button size="sm" onClick={download}>
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {view === "table" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-2">Timestamp</th>
                  <th className="text-right py-2">Temperature (°C)</th>
                  <th className="text-right py-2">Humidity (%)</th>
                </tr>
              </thead>
              <tbody>
                {(logs || []).map((r, i) => (
                  <tr key={i} className="border-b hover:bg-muted/40">
                    <td className="py-2">{fmtTime(r.timestamp)}</td>
                    <td className="py-2 text-right">{r.temperature}</td>
                    <td className="py-2 text-right">{r.humidity}</td>
                  </tr>
                ))}

                {!logs?.length && (
                  <tr>
                    <td
                      colSpan={3}
                      className="text-center py-6 text-muted-foreground"
                    >
                      No logs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {view === "chart" && (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(v) =>
                    new Date(v.replace(" ", "T")).toLocaleTimeString()
                  }
                  minTickGap={28}
                />
                <YAxis />
                <Tooltip labelFormatter={(v) => fmtTime(v)} />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="temperature"
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="humidity"
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {view === "bars" && (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(v) =>
                    new Date(v.replace(" ", "T")).toLocaleTimeString()
                  }
                  minTickGap={28}
                />
                <YAxis />
                <Tooltip labelFormatter={(v) => fmtTime(v)} />
                <Legend />
                <Bar dataKey="temperature" />
                <Bar dataKey="humidity" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
// --- API Tester ---
function APITester() {
  const [path, setPath] = useState("/devices");
  const [method, setMethod] = useState("GET");
  const [body, setBody] = useState(
    `{
  "mac": "AA:BB:CC:DD:EE:FF",
  "temperature": 31.2,
  "humidity": 40.5
}`
  );
  const [res, setRes] = useState("");

  const send = async () => {
    try {
      const r = await api(path, {
        method,
        body: method === "POST" ? body : undefined,
      });
      setRes(JSON.stringify(r, null, 2));
    } catch (e) {
      setRes(String(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Server className="h-4 w-4" /> API Tester
        </CardTitle>
        <CardDescription>
          Safely hit your existing Flask endpoints without changing anything.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-center">
          {/* Path */}
          <div className="md:col-span-4 flex items-center gap-2">
            <Label className="w-14">Path</Label>
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/devices"
            />
          </div>

          {/* Method */}
          <div className="md:col-span-1 flex items-center gap-2">
            <Label className="w-16">Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Send Button */}
          <div className="md:col-span-1 flex justify-end">
            <Button onClick={send}>
              <RefreshCcw className="h-4 w-4 mr-1" /> Send
            </Button>
          </div>
        </div>

        {/* POST body */}
        {method === "POST" && (
          <div>
            <Label>Body (JSON)</Label>
            <textarea
              className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs h-40"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        )}

        {/* Response */}
        <div>
          <Label>Response</Label>
          <pre className="mt-1 w-full rounded-md border bg-muted/40 p-3 text-xs overflow-auto max-h-64">
            {res}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
// --- Root App ---
export default function App() {
  const [statusOK, setStatusOK] = useState(false);
  const [devices, setDevices] = useState([]);
  const [selectedMAC, setSelectedMAC] = useState("");
  const [logs, setLogs] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pghStatus, setPghStatus] = useState<any>(null);
  const [pghMetrics, setPghMetrics] = useState<string>("");
  const [pghDemoLogs, setPghDemoLogs] = useState<any[]>([]);
  const [chainActions, setChainActions] = useState<any[]>([]);
  const [chainSnapshots, setChainSnapshots] = useState<any[]>([]);
  const [chainBindings, setChainBindings] = useState<any[]>([]);
  const [espSummary, setEspSummary] = useState<any[]>([]);
  const [simList, setSimList] = useState<any[]>([]);
  const [simRuns, setSimRuns] = useState<any[]>([]);
  const pollRef = useRef(null);

  // Ping API root
  const refreshStatus = async () => {
    try {
      await api("/");
      setStatusOK(true);
    } catch (e) {
      setStatusOK(false);
    }
  };

  const refreshDevices = async () => {
    try {
      const d = await api("/devices");
      setDevices(Array.isArray(d) ? d : []);

      // Pick first device automatically if none selected
      if (!selectedMAC && d?.[0]?.mac) setSelectedMAC(d[0].mac);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshLogs = async () => {
    if (!selectedMAC) return;
    try {
      const r = await api(`/logs/${encodeURIComponent(selectedMAC)}`);
      setLogs(Array.isArray(r) ? r : []);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshAlerts = async () => {
    if (!selectedMAC) return;
    try {
      const a = await api(`/alerts/${encodeURIComponent(selectedMAC)}`);
      setAlerts(Array.isArray(a) ? a : []);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshPgh = async () => {
    try {
      const s = await api("/pgh/status");
      setPghStatus(s);
    } catch (e) {
      console.error("pgh status", e);
    }
    try {
      const m = await api("/pgh/metrics");
      setPghMetrics(typeof m === "string" ? m : JSON.stringify(m, null, 2));
    } catch (e) {
      console.error("pgh metrics", e);
    }
    try {
      const logs = await api("/pgh/demo-logs");
      setPghDemoLogs(Array.isArray(logs) ? logs : []);
    } catch (e) {
      console.error("pgh demo logs", e);
    }
  };

  const refreshChain = async () => {
    try {
      const actions = await api("/chain/actions?limit=30");
      setChainActions(Array.isArray(actions) ? actions : []);
    } catch (e) {
      console.error("chain actions", e);
    }
    try {
      const summary = await api("/chain/esp-summary");
      setEspSummary(Array.isArray(summary) ? summary : []);
    } catch (e) {
      console.error("esp summary", e);
    }
    try {
      const snaps = await api("/chain/status-snapshots?limit=10");
      setChainSnapshots(Array.isArray(snaps) ? snaps : []);
    } catch (e) {
      console.error("chain snapshots", e);
    }
    try {
      const bindings = await api("/chain/bindings");
      setChainBindings(Array.isArray(bindings) ? bindings : []);
    } catch (e) {
      console.error("chain bindings", e);
    }
  };

  const refreshSimulations = async () => {
    try {
      const list = await api("/simulations/list");
      setSimList(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error("sim list", e);
    }
    try {
      const runs = await api("/simulations/runs?limit=10");
      setSimRuns(Array.isArray(runs) ? runs : []);
    } catch (e) {
      console.error("sim runs", e);
    }
  };

  const doRefreshAll = async () => {
    await Promise.all([refreshStatus(), refreshDevices()]);
    await Promise.all([refreshLogs(), refreshAlerts(), refreshPgh(), refreshChain(), refreshSimulations()]);
  };

  useEffect(() => {
    doRefreshAll();
  }, [selectedMAC]);

  useEffect(() => {
    if (!autoRefresh) return;
    pollRef.current = setInterval(doRefreshAll, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [autoRefresh, selectedMAC]);

  const anyHot = devices?.some((d) => (d.temperature ?? 0) > 30);
  const total = devices?.length || 0;
  const hottest =
    devices?.reduce(
      (m, d) =>
        (d.temperature ?? -Infinity) > (m.temperature ?? -Infinity) ? d : m,
      {}
    ) || {};

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header statusOK={statusOK} />

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {/* Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <KPI icon={Activity} title="Devices" value={total} desc="Registered devices" />
          <KPI
            icon={Thermometer}
            title="Hottest"
            value={hottest?.temperature ?? "—"}
            desc={hottest?.mac ? `@ ${hottest.mac}` : "No readings"}
          />
          <KPI
            icon={Waves}
            title="Humidity (last sel)"
            value={logs?.[0]?.humidity ?? "—"}
            desc="Latest log of selected device"
          />
          <KPI
            icon={Bell}
            title="Active Alerts"
            value={anyHot ? "Yes" : "No"}
            desc="Temp > 30°C"
          />
        </div>

        {anyHot && (
          <div className="border rounded-lg p-3 flex items-center gap-3 bg-amber-50 dark:bg-amber-950/30">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <div className="text-sm">
              Some devices have exceeded the temperature threshold (30°C).
              Check the Alerts tab or device details.
            </div>
          </div>
        )}

        <Tabs defaultValue="devices" className="w-full">
          <TabsList className="grid w-full grid-cols-7">
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="alerts">Alerts</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
            <TabsTrigger value="pgh">PGH / Chain</TabsTrigger>
            <TabsTrigger value="sims">Simulations</TabsTrigger>
          </TabsList>

          {/* Devices */}
          <TabsContent value="devices" className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Switch
                  id="auto"
                  checked={autoRefresh}
                  onCheckedChange={setAutoRefresh}
                />
                <Label htmlFor="auto">Auto-refresh</Label>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={doRefreshAll}>
                  <RefreshCcw className="h-4 w-4 mr-1" /> Refresh
                </Button>
              </div>
            </div>

            <DevicesTable devices={devices} onSelect={setSelectedMAC} />
          </TabsContent>

          {/* Details */}
          <TabsContent value="details" className="space-y-4">
            <div className="flex items-center gap-2">
              <Label className="text-sm">Selected MAC</Label>
              <Select value={selectedMAC} onValueChange={setSelectedMAC}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="Pick a device" />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((d) => (
                    <SelectItem key={d.mac} value={d.mac}>
                      {d.mac}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="secondary"
                onClick={() => {
                  refreshLogs();
                  refreshAlerts();
                }}
              >
                <RefreshCcw className="h-4 w-4 mr-1" /> Refresh
              </Button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Gauge className="h-4 w-4" /> Readings
                  </CardTitle>
                  <CardDescription>
                    Last 20 logs for the selected device.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DeviceMiniChart logs={logs} />
                </CardContent>
              </Card>

              <AlertsPanel mac={selectedMAC} alerts={alerts} />
            </div>
          </TabsContent>

          {/* Logs */}
          <TabsContent value="logs">
            <LogsExplorer mac={selectedMAC} logs={logs} />
          </TabsContent>

          {/* Alerts */}
          <TabsContent value="alerts">
            <AlertsPanel mac={selectedMAC} alerts={alerts} />
          </TabsContent>

          {/* API Tester */}
          <TabsContent value="api">
            <APITester />
          </TabsContent>

          {/* PGH / Blockchain */}
          <TabsContent value="pgh" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Server className="h-4 w-4" /> PGH Status
                  </CardTitle>
                  <CardDescription>Snapshot from the gateway (/status)</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {pghStatus ? (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <div className="text-muted-foreground">Requests</div>
                          <div className="font-semibold">
                            reg {pghStatus.requests?.registerDevice?.ok ?? 0} ·
                            deploy {pghStatus.requests?.deployContract?.ok ?? 0} ·
                            eval {pghStatus.requests?.evaluate?.ok ?? 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Decisions</div>
                          <div className="font-semibold">
                            allow {pghStatus.accessDecisions?.allow ?? 0} / deny {pghStatus.accessDecisions?.deny ?? 0}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Threats</div>
                          <div className="font-semibold">{pghStatus.threats?.total ?? 0}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground">Last ACC</div>
                          <div className="font-mono text-xs break-all">
                            {pghStatus.lastDeployedContract?.contractAddress || "—"}
                          </div>
                        </div>
                      </div>
                      <Separator />
                      <div className="text-xs space-y-2">
                        <div className="font-semibold">Recent events</div>
                        <div className="space-y-1 max-h-60 overflow-auto">
                          {(pghStatus.recentEvents || []).map((ev, idx) => (
                            <div key={idx} className="rounded border px-2 py-1">
                              <div className="font-mono text-[11px]">{fmtTime(ev.timestamp)}</div>
                              <div className="text-[12px]">{ev.event}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <Skeleton className="h-24 w-full" />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Gauge className="h-4 w-4" /> Metrics
                  </CardTitle>
                  <CardDescription>Prometheus export from PGH</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto bg-muted/50 p-2 rounded border">
                    {pghMetrics || "Loading..."}
                  </pre>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Database className="h-4 w-4" /> Demo Logs (PGH)
                </CardTitle>
                <CardDescription>Latest gateway demo telemetry entries</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {(pghDemoLogs || []).map((log, idx) => (
                    <div key={idx} className="border rounded p-2 text-xs bg-muted/30">
                      <div className="font-mono text-[11px]">{fmtTime(log.timestamp)}</div>
                      <div className="font-semibold">{log.event || log.file}</div>
                      <div className="text-[11px] break-all">
                        {log.data ? JSON.stringify(log.data) : JSON.stringify(log)}
                      </div>
                    </div>
                  ))}
                  {(!pghDemoLogs || pghDemoLogs.length === 0) && (
                    <div className="text-sm text-muted-foreground">No logs yet.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Cpu className="h-4 w-4" /> ESP32 Blockchain Summary
                </CardTitle>
                <CardDescription>MAC, subject address, last chain action, and token balance</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-80 overflow-auto">
                  {(espSummary || []).map((row, idx) => (
                    <div key={idx} className="border rounded p-2 text-xs bg-muted/30">
                      <div className="font-semibold">{row.mac || "—"}</div>
                      <div className="text-[11px] break-all">subject {row.subject_address || "—"}</div>
                      <div className="text-[11px]">tokens {row.token_balance ?? "—"}</div>
                      <div className="text-[11px]">
                        last action {row.last_chain_action || "—"} · {row.last_chain_decision || "—"}
                      </div>
                      <div className="text-[11px]">
                        last chain {row.last_chain_timestamp ? fmtTime(row.last_chain_timestamp) : "—"}
                      </div>
                      <div className="text-[11px] break-all">
                        tx {row.last_chain_tx || "—"}
                      </div>
                    </div>
                  ))}
                  {(!espSummary || espSummary.length === 0) && (
                    <div className="text-xs text-muted-foreground">No ESP32 chain summary yet.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Database className="h-4 w-4" /> Chain Actions (ESP API)
                </CardTitle>
                <CardDescription>Recent on-chain actions logged by the ESP API</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-80 overflow-auto">
                  {(chainActions || []).map((row, idx) => (
                    <div key={idx} className="border rounded p-2 text-xs bg-muted/30">
                      <div className="font-mono text-[11px]">{fmtTime(row.timestamp)}</div>
                      <div className="font-semibold">
                        {row.action || "action"} · {row.decision || "n/a"}
                      </div>
                      <div className="text-[11px] break-all">
                        mac {row.mac || "—"} · subject {row.subject_address || "—"}
                      </div>
                      <div className="text-[11px] break-all">
                        obj {row.object_address || "—"} · resource {row.resource || "—"}
                      </div>
                      <div className="text-[11px] break-all">
                        tx {row.tx_hash || "—"}
                      </div>
                      <div className="text-[11px]">
                        latency {row.duration_ms ?? "—"} ms · req {row.request_bytes ?? "—"} B · resp {row.response_bytes ?? "—"} B
                      </div>
                      <div className="text-[11px]">
                        gas {row.gas_used ?? "—"} · cost {row.gas_cost_wei ?? "—"}
                      </div>
                    </div>
                  ))}
                  {(!chainActions || chainActions.length === 0) && (
                    <div className="text-xs text-muted-foreground">No chain actions yet.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Server className="h-4 w-4" /> Contract Bindings
                  </CardTitle>
                  <CardDescription>object + subject + accType to ACC address</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {(chainBindings || []).map((row, idx) => (
                      <div key={idx} className="border rounded p-2 text-xs bg-muted/30">
                        <div className="font-mono text-[11px]">{fmtTime(row.updated_at)}</div>
                        <div className="text-[11px] break-all">
                          obj {row.object_address || "—"}
                        </div>
                        <div className="text-[11px] break-all">
                          subj {row.subject_address || "—"}
                        </div>
                        <div className="text-[11px] break-all">
                          acc {row.acc_address || "—"}
                        </div>
                      </div>
                    ))}
                    {(!chainBindings || chainBindings.length === 0) && (
                      <div className="text-xs text-muted-foreground">No bindings yet.</div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Gauge className="h-4 w-4" /> Token Snapshot
                  </CardTitle>
                  <CardDescription>Latest PGH status stored by the ESP API</CardDescription>
                </CardHeader>
                <CardContent>
                  {chainSnapshots?.[0]?.status_json ? (
                    <pre className="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto bg-muted/50 p-2 rounded border">
                      {JSON.stringify(chainSnapshots[0].status_json, null, 2)}
                    </pre>
                  ) : (
                    <div className="text-xs text-muted-foreground">No token snapshots yet.</div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Simulations */}
          <TabsContent value="sims" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Play className="h-4 w-4" /> Run Simulations
                  </CardTitle>
                  <CardDescription>Launch script-based simulations from the UI</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {(simList || []).map((s, idx) => (
                      <div key={idx} className="flex items-center justify-between border rounded p-2 text-xs">
                        <div>
                          <div className="font-semibold">{s.key}</div>
                          <div className="text-[11px] text-muted-foreground break-all">{s.command}</div>
                        </div>
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await api("/simulations/run", {
                                method: "POST",
                                body: JSON.stringify({ script: s.key }),
                              });
                              refreshSimulations();
                            } catch (e) {
                              console.error("run sim", e);
                            }
                          }}
                        >
                          Run
                        </Button>
                      </div>
                    ))}
                    {(!simList || simList.length === 0) && (
                      <div className="text-xs text-muted-foreground">No simulations available.</div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="h-4 w-4" /> Recent Runs
                  </CardTitle>
                  <CardDescription>Latest script runs launched from the UI</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-80 overflow-auto">
                    {(simRuns || []).map((r, idx) => (
                      <div key={idx} className="border rounded p-2 text-xs bg-muted/30">
                        <div className="font-semibold">{r.script_key}</div>
                        <div className="text-[11px]">status {r.status} · exit {r.exit_code ?? "—"}</div>
                        <div className="text-[11px]">started {fmtTime(r.started_at)}</div>
                        {r.finished_at && <div className="text-[11px]">finished {fmtTime(r.finished_at)}</div>}
                        {r.result_hint && <div className="text-[11px] break-all">results {r.result_hint}</div>}
                      </div>
                    ))}
                    {(!simRuns || simRuns.length === 0) && (
                      <div className="text-xs text-muted-foreground">No runs yet.</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        <Separator />

        <div className="text-xs text-muted-foreground flex items-center gap-2 pb-8">
          <CheckCircle2 className="h-4 w-4" />
          <span>
            The dashboard provides real time data from the IoT devices connected to the main Gateway server(the Raspberry Pi) which generates real time temperature data.
          </span>
        </div>
      </main>
    </div>
  );
}

// If you want to mount automatically when this file is used standalone
const mountEl = document.getElementById("root");
if (mountEl) {
  const root = createRoot(mountEl);
  root.render(<App />);
}
