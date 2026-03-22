#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import express from "express";
import { z } from "zod";
import "dotenv/config";

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Global emergency lock flag
let isEmergencyLocked = false;

// Configuration schema for downstream servers
const ConfigSchema = z.object({
  downstreamServers: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()).optional(),
    })
  ),
});

// Rules schema for security policies
const RulesSchema = z.object({
  blocked_tools: z.array(z.string()),
  max_cost_per_task_usd: z.number(),
  require_approval_for: z.array(z.string()),
  semantic_check_required: z.array(z.string()),
});

type Config = z.infer<typeof ConfigSchema>;
type Rules = z.infer<typeof RulesSchema>;

interface DownstreamConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
}

interface AuditLogEntry {
  timestamp: string;
  tool: string;
  fullToolName: string;
  action: "ALLOWED" | "VETOED";
  reason?: string;
  arguments?: Record<string, unknown>;
  sessionCost?: number;
}

interface BudgetState {
  totalSpent: number;
  lastUpdated: string;
}

// Semantic evaluation result
type SemanticEvaluation = "SAFE" | "SUSPICIOUS" | "UNKNOWN";

// Helper to fix Windows paths from URL
function fixWindowsPath(urlPath: string): string {
  return urlPath.replace(/^\/([A-Z]:)/, "$1");
}

// Ensure logs directory exists
function ensureLogsDir(): string {
  const logsDir = new URL("../logs/", import.meta.url);
  const logsDirPath = fixWindowsPath(logsDir.pathname);
  if (!existsSync(logsDirPath)) {
    mkdirSync(logsDirPath, { recursive: true });
  }
  return logsDirPath;
}

// Budget Tracker class with persistence
class BudgetTracker {
  private totalSpent: number = 0;
  private readonly maxCost: number;
  private readonly estimatedCostPerCall: number = 0.01; // Mock: $0.01 per tool call
  private readonly statePath: string;

  constructor(maxCostUsd: number) {
    this.maxCost = maxCostUsd;
    const logsDir = ensureLogsDir();
    this.statePath = `${logsDir}/budget_state.json`;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const data = readFileSync(this.statePath, "utf-8");
        const state: BudgetState = JSON.parse(data);
        this.totalSpent = state.totalSpent;
        auditLog("BUDGET_STATE_LOADED", {
          totalSpent: this.totalSpent,
          maxCost: this.maxCost,
          remaining: this.getRemainingBudget(),
        });
      }
    } catch {
      this.totalSpent = 0;
    }
  }

  private saveState(): void {
    try {
      const state: BudgetState = {
        totalSpent: this.totalSpent,
        lastUpdated: new Date().toISOString(),
      };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("Failed to save budget state:", error);
    }
  }

  canProceed(): boolean {
    return this.totalSpent < this.maxCost;
  }

  recordCall(): void {
    this.totalSpent += this.estimatedCostPerCall;
    this.saveState();
  }

  getTotalSpent(): number {
    return this.totalSpent;
  }

  getRemainingBudget(): number {
    return Math.max(0, this.maxCost - this.totalSpent);
  }

  getMaxCost(): number {
    return this.maxCost;
  }
}

// Session Logger for Audit Trail
class SessionLogger {
  private readonly logPath: string;
  private logs: AuditLogEntry[] = [];

  constructor() {
    const logsDir = ensureLogsDir();
    this.logPath = `${logsDir}/audit_log.json`;
    this.loadLogs();
  }

  private loadLogs(): void {
    try {
      if (existsSync(this.logPath)) {
        const data = readFileSync(this.logPath, "utf-8");
        this.logs = JSON.parse(data);
      }
    } catch {
      this.logs = [];
    }
  }

  log(entry: AuditLogEntry): void {
    this.logs.push(entry);
    this.saveLogs();
  }

  private saveLogs(): void {
    try {
      writeFileSync(this.logPath, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error("Failed to save audit log:", error);
    }
  }

  getLogs(): AuditLogEntry[] {
    return this.logs;
  }

  getLogPath(): string {
    return this.logPath;
  }
}

// Approval Gateway for Human-in-the-Loop (HITL)
class ApprovalGateway {
  // Request approval from human operator
  async requestApproval(
    toolName: string,
    args: Record<string, unknown> | undefined
  ): Promise<{ approved: boolean; reason: string }> {
    return new Promise((resolve) => {
      // Create readline interface using stderr for prompts (stdout is for MCP protocol)
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false,
      });

      // Format args for display
      const argsDisplay = args ? JSON.stringify(args, null, 2) : "{}";

      // Print high-visibility alert to stderr
      console.error("\n" + "=".repeat(60));
      console.error("🚨 APPROVAL REQUIRED 🚨");
      console.error("=".repeat(60));
      console.error(`Tool: ${toolName}`);
      console.error(`Arguments:\n${argsDisplay}`);
      console.error("=".repeat(60));
      console.error("Allow this action? (y/n): ");

      rl.once("line", (answer) => {
        rl.close();
        const normalizedAnswer = answer.trim().toLowerCase();

        if (normalizedAnswer === "y" || normalizedAnswer === "yes") {
          resolve({ approved: true, reason: "APPROVED_BY_HUMAN" });
        } else {
          resolve({ approved: false, reason: "DENIED_BY_HUMAN" });
        }
      });

      // Handle timeout - auto-deny after 60 seconds
      const timeout = setTimeout(() => {
        rl.close();
        console.error("\n⏰ Approval timeout - auto-denying request");
        resolve({ approved: false, reason: "DENIED_BY_TIMEOUT" });
      }, 60000);

      rl.once("close", () => {
        clearTimeout(timeout);
      });
    });
  }
}

// Semantic Observer - evaluates intent of tool calls
class SemanticObserver {
  private readonly sensitivePatterns = [".env", "config", "root", "secret", "credential", "password"];

  // Evaluate the intent of a tool call
  evaluateIntent(
    toolName: string,
    args: Record<string, unknown> | undefined,
    _reasoning?: string
  ): SemanticEvaluation {
    // For write_file, check if the path contains sensitive patterns
    if (toolName.toLowerCase() === "write_file") {
      const path = this.extractPath(args);
      if (path && this.containsSensitivePattern(path)) {
        return "SUSPICIOUS";
      }
    }

    // For git_push, check if pushing to protected branches
    if (toolName.toLowerCase() === "git_push") {
      const branch = args?.branch as string | undefined;
      if (branch && (branch === "main" || branch === "master" || branch === "production")) {
        return "SUSPICIOUS";
      }
    }

    return "SAFE";
  }

  private extractPath(args: Record<string, unknown> | undefined): string | null {
    if (!args) return null;

    // Common path argument names
    const pathKeys = ["path", "file_path", "filepath", "file", "filename", "target"];
    for (const key of pathKeys) {
      if (typeof args[key] === "string") {
        return args[key] as string;
      }
    }
    return null;
  }

  private containsSensitivePattern(path: string): boolean {
    const normalizedPath = path.toLowerCase();
    return this.sensitivePatterns.some((pattern) => normalizedPath.includes(pattern));
  }
}

// Sanitizer - detects potential prompt injection in arguments
class Sanitizer {
  private readonly dangerousPatterns = [
    "ignore",
    "override",
    "system prompt",
    "bypass",
    "disregard",
    "forget",
    "ignore previous",
    "ignore all",
    "new instructions",
    "act as",
    "pretend",
    "jailbreak",
  ];

  // Check all arguments for dangerous patterns
  checkForInjection(args: Record<string, unknown> | undefined): { detected: boolean; pattern?: string } {
    if (!args) return { detected: false };

    const argsString = JSON.stringify(args).toLowerCase();

    for (const pattern of this.dangerousPatterns) {
      if (argsString.includes(pattern.toLowerCase())) {
        return { detected: true, pattern };
      }
    }

    return { detected: false };
  }
}

// Circuit Breaker - prevents recursive loops by rate limiting
class CircuitBreaker {
  private callHistory: Map<string, number[]> = new Map();
  private readonly maxCalls: number = 5;
  private readonly windowMs: number = 10000; // 10 seconds

  // Check if a tool call should be allowed based on rate limit
  checkRateLimit(toolName: string): { allowed: boolean; callCount: number } {
    const now = Date.now();
    const calls = this.callHistory.get(toolName) || [];

    // Remove calls outside the time window
    const recentCalls = calls.filter((timestamp) => now - timestamp < this.windowMs);

    if (recentCalls.length >= this.maxCalls) {
      return { allowed: false, callCount: recentCalls.length };
    }

    // Record this call
    recentCalls.push(now);
    this.callHistory.set(toolName, recentCalls);

    return { allowed: true, callCount: recentCalls.length };
  }

  // Reset rate limit for a tool (for testing)
  reset(toolName?: string): void {
    if (toolName) {
      this.callHistory.delete(toolName);
    } else {
      this.callHistory.clear();
    }
  }
}

// Audit logging utility (console)
function auditLog(action: string, details: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  console.error(`[AUDIT ${timestamp}] ${action}:`, JSON.stringify(details, null, 2));
}

// Load configuration
function loadConfig(): Config {
  const configPath = new URL("../config.json", import.meta.url);
  const configData = readFileSync(configPath, "utf-8");
  return ConfigSchema.parse(JSON.parse(configData));
}

// Load security rules
function loadRules(): Rules {
  const rulesPath = new URL("../rules.json", import.meta.url);
  const rulesData = readFileSync(rulesPath, "utf-8");
  return RulesSchema.parse(JSON.parse(rulesData));
}

// Check if a tool is blocked by security policy
function isToolBlocked(toolName: string, blockedTools: string[]): boolean {
  const normalizedToolName = toolName.toLowerCase();
  return blockedTools.some(
    (blocked) => normalizedToolName === blocked.toLowerCase()
  );
}

// Check if a tool requires approval
function requiresApproval(toolName: string, approvalList: string[]): boolean {
  const normalizedToolName = toolName.toLowerCase();
  return approvalList.some(
    (item) => normalizedToolName === item.toLowerCase()
  );
}

// Check if a tool requires semantic analysis
function requiresSemanticCheck(toolName: string, semanticList: string[]): boolean {
  const normalizedToolName = toolName.toLowerCase();
  return semanticList.some(
    (item) => normalizedToolName === item.toLowerCase()
  );
}

// Connect to a downstream MCP server
async function connectToDownstream(
  serverConfig: Config["downstreamServers"][0]
): Promise<DownstreamConnection> {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
  });

  const client = new Client(
    { name: "veto-proxy", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    name: serverConfig.name,
    client,
    transport,
  };
}

// Start the Dashboard Express server
function startDashboardServer(budgetTracker: BudgetTracker, sessionLogger: SessionLogger, rules: Rules): void {
  const app = express();
  const PORT = 3000;
  const ADMIN_KEY = process.env.VITO_ADMIN_KEY || "";

  // Middleware to check admin key for API endpoints
  const requireAdminKey = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    // If no admin key is configured, allow access (for development)
    if (!ADMIN_KEY) {
      next();
      return;
    }

    const providedKey = req.headers["x-veto-key"] as string;
    if (providedKey !== ADMIN_KEY) {
      res.status(401).json({ error: "Unauthorized: Invalid or missing X-Veto-Key header" });
      return;
    }
    next();
  };

  // Serve static dashboard
  const dashboardPath = join(__dirname, "dashboard", "index.html");

  app.get("/", (_req, res) => {
    if (existsSync(dashboardPath)) {
      res.sendFile(dashboardPath);
    } else {
      res.send(`
        <html>
          <body style="background:#0f0f0f;color:#fff;font-family:sans-serif;padding:40px;">
            <h1>🛡️ Veto Command Center</h1>
            <p>Dashboard file not found at: ${dashboardPath}</p>
          </body>
        </html>
      `);
    }
  });

  // API endpoint: Check if auth is required
  app.get("/api/auth-required", (_req, res) => {
    res.json({ required: !!ADMIN_KEY });
  });

  // API endpoint: Get stats (protected)
  app.get("/api/stats", requireAdminKey, (_req, res) => {
    const logsDir = ensureLogsDir();
    const budgetStatePath = `${logsDir}/budget_state.json`;

    let budgetState = { totalSpent: 0, lastUpdated: "" };
    try {
      if (existsSync(budgetStatePath)) {
        budgetState = JSON.parse(readFileSync(budgetStatePath, "utf-8"));
      }
    } catch {
      // Use defaults
    }

    let auditLogs: AuditLogEntry[] = [];
    try {
      const logPath = sessionLogger.getLogPath();
      if (existsSync(logPath)) {
        auditLogs = JSON.parse(readFileSync(logPath, "utf-8"));
      }
    } catch {
      // Use defaults
    }

    res.json({
      isEmergencyLocked,
      budget: {
        totalSpent: budgetState.totalSpent,
        maxCost: rules.max_cost_per_task_usd,
        remaining: Math.max(0, rules.max_cost_per_task_usd - budgetState.totalSpent),
        lastUpdated: budgetState.lastUpdated,
      },
      auditLogs,
    });
  });

  // API endpoint: Kill switch (protected)
  app.post("/api/killswitch", requireAdminKey, (_req, res) => {
    isEmergencyLocked = true;
    auditLog("EMERGENCY_KILLSWITCH_ACTIVATED", {
      timestamp: new Date().toISOString(),
      message: "All agent actions suspended via Dashboard",
    });
    res.json({ success: true, message: "Kill switch activated" });
  });

  app.listen(PORT, () => {
    auditLog("DASHBOARD_SERVER_STARTED", {
      port: PORT,
      url: `http://localhost:${PORT}`,
    });
  });
}

async function main(): Promise<void> {
  // Load configuration and rules
  const config = loadConfig();
  const rules = loadRules();
  const budgetTracker = new BudgetTracker(rules.max_cost_per_task_usd);
  const sessionLogger = new SessionLogger();
  const semanticObserver = new SemanticObserver();
  const approvalGateway = new ApprovalGateway();
  const sanitizer = new Sanitizer();
  const circuitBreaker = new CircuitBreaker();

  auditLog("CONFIG_LOADED", { serverCount: config.downstreamServers.length });
  auditLog("RULES_LOADED", {
    blockedTools: rules.blocked_tools,
    maxCostUsd: rules.max_cost_per_task_usd,
    requireApprovalFor: rules.require_approval_for,
    semanticCheckRequired: rules.semantic_check_required,
  });
  auditLog("BUDGET_STATUS", {
    totalSpent: budgetTracker.getTotalSpent(),
    maxCost: budgetTracker.getMaxCost(),
    remaining: budgetTracker.getRemainingBudget(),
  });

  // Start Dashboard server
  startDashboardServer(budgetTracker, sessionLogger, rules);

  // Connect to downstream servers
  const downstreamConnections: DownstreamConnection[] = [];
  for (const serverConfig of config.downstreamServers) {
    try {
      const connection = await connectToDownstream(serverConfig);
      downstreamConnections.push(connection);
      auditLog("DOWNSTREAM_CONNECTED", { name: serverConfig.name });
    } catch (error) {
      auditLog("DOWNSTREAM_CONNECT_FAILED", {
        name: serverConfig.name,
        error: String(error),
      });
    }
  }

  // Create the proxy server
  const server = new Server(
    { name: "veto-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Handle listTools - aggregate from all downstream servers
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    auditLog("LIST_TOOLS_REQUEST", { request });

    const allTools: Array<{ name: string; description?: string; inputSchema: unknown }> = [];

    for (const connection of downstreamConnections) {
      try {
        const result = await connection.client.listTools();
        auditLog("LIST_TOOLS_RESPONSE", {
          downstream: connection.name,
          toolCount: result.tools.length,
        });

        // Prefix tool names with server name to avoid collisions
        for (const tool of result.tools) {
          allTools.push({
            name: `${connection.name}__${tool.name}`,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      } catch (error) {
        auditLog("LIST_TOOLS_ERROR", {
          downstream: connection.name,
          error: String(error),
        });
      }
    }

    return { tools: allTools };
  });

  // Handle callTool - route to appropriate downstream server with Veto checks
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const timestamp = new Date().toISOString();

    auditLog("CALL_TOOL_REQUEST", {
      tool: request.params.name,
      arguments: request.params.arguments,
    });

    // Parse tool name to find target server
    const [serverName, ...toolParts] = request.params.name.split("__");
    const toolName = toolParts.join("__");
    const toolArgs = request.params.arguments as Record<string, unknown> | undefined;

    // === EMERGENCY KILL SWITCH CHECK (ABSOLUTE FIRST) ===
    if (isEmergencyLocked) {
      const reason = "emergency_killswitch";
      auditLog("EMERGENCY_VETO", {
        tool: toolName,
        message: "All actions suspended via Dashboard",
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason,
        arguments: toolArgs,
      });

      return {
        content: [
          {
            type: "text",
            text: "🚨 EMERGENCY VETO: All actions suspended via Dashboard.",
          },
        ],
        isError: true,
      };
    }

    // === STRICT BUDGET CHECK (FIRST - blocks everything if exhausted) ===
    if (!budgetTracker.canProceed()) {
      const reason = "budget_exhausted";
      auditLog("BUDGET_EXHAUSTED", {
        tool: toolName,
        totalSpent: budgetTracker.getTotalSpent(),
        maxCost: budgetTracker.getMaxCost(),
        message: "Agent deactivated to prevent overbilling",
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason,
        sessionCost: budgetTracker.getTotalSpent(),
      });

      return {
        content: [
          {
            type: "text",
            text: `❌ BUDGET EXHAUSTED ($${budgetTracker.getMaxCost().toFixed(2)}). Agent deactivated to prevent overbilling.`,
          },
        ],
        isError: true,
      };
    }

    // === VETO CHECK 1: Prompt Injection Detection (Sanitizer) ===
    const injectionCheck = sanitizer.checkForInjection(toolArgs);
    if (injectionCheck.detected) {
      const reason = "prompt_injection_detected";
      auditLog("PROMPT_INJECTION_DETECTED", {
        tool: toolName,
        pattern: injectionCheck.pattern,
        arguments: toolArgs,
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason,
        arguments: toolArgs,
      });

      return {
        content: [
          {
            type: "text",
            text: "🚨 SECURITY ALERT: Potential Prompt Injection Detected.",
          },
        ],
        isError: true,
      };
    }

    // === VETO CHECK 2: Circuit Breaker (Rate Limiting) ===
    const rateCheck = circuitBreaker.checkRateLimit(toolName);
    if (!rateCheck.allowed) {
      const reason = "circuit_breaker_triggered";
      auditLog("CIRCUIT_BREAKER_TRIGGERED", {
        tool: toolName,
        callCount: rateCheck.callCount,
        maxCalls: 5,
        windowMs: 10000,
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason,
      });

      return {
        content: [
          {
            type: "text",
            text: "⚡ CIRCUIT BREAKER: Rate limit exceeded to prevent recursive loops.",
          },
        ],
        isError: true,
      };
    }

    // === VETO CHECK 3: Blocked Tools ===
    if (isToolBlocked(toolName, rules.blocked_tools)) {
      const reason = "blocked_by_policy";
      auditLog("TOOL_VETOED", {
        tool: toolName,
        reason,
        fullToolName: request.params.name,
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason,
        arguments: toolArgs,
      });

      return {
        content: [
          {
            type: "text",
            text: "VETOED: This action is restricted by your security policy.",
          },
        ],
        isError: true,
      };
    }

    // === VETO CHECK 4: Semantic Analysis ===
    if (requiresSemanticCheck(toolName, rules.semantic_check_required)) {
      const reasoning = request.params._meta?.reasoning as string | undefined;
      const evaluation = semanticObserver.evaluateIntent(toolName, toolArgs, reasoning);

      auditLog("SEMANTIC_ANALYSIS", {
        tool: toolName,
        evaluation,
        arguments: toolArgs,
      });

      if (evaluation === "SUSPICIOUS") {
        const reason = "semantic_analysis_flagged";
        auditLog("TOOL_VETOED", {
          tool: toolName,
          reason,
          evaluation,
          fullToolName: request.params.name,
        });

        sessionLogger.log({
          timestamp,
          tool: toolName,
          fullToolName: request.params.name,
          action: "VETOED",
          reason,
          arguments: toolArgs,
        });

        return {
          content: [
            {
              type: "text",
              text: "VETOED: Semantic analysis flagged this action as high-risk. Manual override required.",
            },
          ],
          isError: true,
        };
      }
    }

    // === VETO CHECK 5: Human Approval Required ===
    if (requiresApproval(toolName, rules.require_approval_for)) {
      auditLog("APPROVAL_REQUESTED", {
        tool: toolName,
        fullToolName: request.params.name,
        arguments: toolArgs,
      });

      const approval = await approvalGateway.requestApproval(toolName, toolArgs);

      auditLog("APPROVAL_RESULT", {
        tool: toolName,
        approved: approval.approved,
        reason: approval.reason,
      });

      if (!approval.approved) {
        sessionLogger.log({
          timestamp,
          tool: toolName,
          fullToolName: request.params.name,
          action: "VETOED",
          reason: approval.reason,
          arguments: toolArgs,
        });

        return {
          content: [
            {
              type: "text",
              text: `VETOED: Human operator denied this action. Reason: ${approval.reason}`,
            },
          ],
          isError: true,
        };
      }

      // Log human approval
      auditLog("TOOL_APPROVED_BY_HUMAN", {
        tool: toolName,
        fullToolName: request.params.name,
      });
    }

    // Find the downstream connection
    const connection = downstreamConnections.find((c) => c.name === serverName);
    if (!connection) {
      auditLog("CALL_TOOL_ERROR", { error: "Server not found", serverName });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason: "server_not_found",
      });

      return {
        content: [{ type: "text", text: `Error: Server '${serverName}' not found` }],
        isError: true,
      };
    }

    try {
      // Record the call for budget tracking
      budgetTracker.recordCall();

      const result = await connection.client.callTool({
        name: toolName,
        arguments: request.params.arguments,
      });

      auditLog("CALL_TOOL_RESPONSE", {
        downstream: connection.name,
        tool: toolName,
        success: !result.isError,
        totalSpent: budgetTracker.getTotalSpent(),
        remainingBudget: budgetTracker.getRemainingBudget(),
      });

      // Log successful call
      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "ALLOWED",
        arguments: toolArgs,
        sessionCost: budgetTracker.getTotalSpent(),
      });

      return result;
    } catch (error) {
      auditLog("CALL_TOOL_ERROR", {
        downstream: connection.name,
        tool: toolName,
        error: String(error),
      });

      sessionLogger.log({
        timestamp,
        tool: toolName,
        fullToolName: request.params.name,
        action: "VETOED",
        reason: `error: ${String(error)}`,
      });

      return {
        content: [{ type: "text", text: `Error calling tool: ${String(error)}` }],
        isError: true,
      };
    }
  });

  // Start the proxy server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  auditLog("PROXY_SERVER_STARTED", { message: "Veto MCP Proxy is running" });

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    auditLog("SHUTDOWN", {
      reason: "SIGINT",
      finalTotalSpent: budgetTracker.getTotalSpent(),
      totalLogEntries: sessionLogger.getLogs().length,
    });
    for (const connection of downstreamConnections) {
      await connection.transport.close();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
