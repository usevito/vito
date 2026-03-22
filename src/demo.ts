#!/usr/bin/env node
/**
 * Veto MCP - Interactive Demo
 *
 * Demonstrates the core security features:
 * 1. Safe tool calls succeeding
 * 2. Blocked tools being vetoed
 * 3. Budget exhaustion
 * 4. Emergency kill switch
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Demo state
let passed = 0;
let failed = 0;

// Colors for terminal output
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function fixWindowsPath(urlPath: string): string {
  return urlPath.replace(/^\/([A-Z]:)/, "$1");
}

function getLogsDir(): string {
  const logsDir = new URL("../logs/", import.meta.url);
  return fixWindowsPath(logsDir.pathname);
}

function resetState(budgetSpent = 0): void {
  const logsDir = getLogsDir();
  const budgetPath = `${logsDir}/budget_state.json`;
  writeFileSync(budgetPath, JSON.stringify({ totalSpent: budgetSpent, lastUpdated: new Date().toISOString() }, null, 2));
  const auditPath = `${logsDir}/audit_log.json`;
  writeFileSync(auditPath, JSON.stringify([], null, 2));
}

function printBanner(): void {
  console.log();
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║                                                              ║${RESET}`);
  console.log(`${CYAN}${BOLD}║   🛡️  VITO - LIVE DEMO                                       ║${RESET}`);
  console.log(`${CYAN}${BOLD}║   Security Proxy for MCP Servers                             ║${RESET}`);
  console.log(`${CYAN}${BOLD}║                                                              ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
}

function printScenario(num: number, title: string): void {
  console.log();
  console.log(`${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${YELLOW}${BOLD}  SCENARIO ${num}: ${title}${RESET}`);
  console.log(`${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
}

function printStep(tool: string, expected: string): void {
  console.log();
  console.log(`${DIM}  Tool:     ${RESET}${tool}`);
  console.log(`${DIM}  Expected: ${RESET}${expected}`);
}

function printResult(actual: string, success: boolean): void {
  console.log(`${DIM}  Actual:   ${RESET}${actual}`);
  if (success) {
    console.log(`${GREEN}${BOLD}  Result:   ✅ PASS${RESET}`);
    passed++;
  } else {
    console.log(`${RED}${BOLD}  Result:   ❌ FAIL${RESET}`);
    failed++;
  }
}

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/api/auth-required`);
      if (response.ok) return true;
    } catch {
      // Not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function runDemo(): Promise<void> {
  printBanner();

  console.log(`${DIM}  Initializing demo environment...${RESET}`);

  // Reset to clean state
  resetState(0);

  // Start proxy
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
  });

  const client = new Client(
    { name: "demo-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  await waitForServer(3000);
  await new Promise((r) => setTimeout(r, 500));

  console.log(`${GREEN}  Veto MCP proxy started successfully${RESET}`);
  console.log(`${DIM}  Dashboard: http://localhost:3000${RESET}`);

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 1: Safe tool call succeeds
  // ═══════════════════════════════════════════════════════════════
  printScenario(1, "SAFE TOOL CALL");
  printStep("test-server__echo", "Call succeeds, returns echoed text");

  const echoResult = await client.callTool({
    name: "test-server__echo",
    arguments: { text: "Hello from Veto!" },
  });
  const echoContent = (echoResult.content as Array<{ text: string }>)[0]?.text || "";
  const echoSuccess = echoContent.includes("Hello from Veto!") && !echoResult.isError;
  printResult(echoSuccess ? "Tool executed successfully" : echoContent, echoSuccess);

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 2: Another safe call (read_file)
  // ═══════════════════════════════════════════════════════════════
  printScenario(2, "FILE READ OPERATION");
  printStep("test-server__read_file", "Read succeeds, returns file contents");

  const readResult = await client.callTool({
    name: "test-server__read_file",
    arguments: { path: "/etc/config.json" },
  });
  const readContent = (readResult.content as Array<{ text: string }>)[0]?.text || "";
  const readSuccess = readContent.includes("Contents of") && !readResult.isError;
  printResult(readSuccess ? "File read successful" : readContent, readSuccess);

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 3: Blocked tool is vetoed
  // ═══════════════════════════════════════════════════════════════
  printScenario(3, "DANGEROUS TOOL BLOCKED");
  printStep("test-server__delete_file", "Call is VETOED by security policy");

  const deleteResult = await client.callTool({
    name: "test-server__delete_file",
    arguments: { path: "/etc/passwd" },
  });
  const deleteContent = (deleteResult.content as Array<{ text: string }>)[0]?.text || "";
  const deleteBlocked = deleteContent.includes("VETOED") && deleteResult.isError === true;
  printResult(deleteBlocked ? "VETOED: Blocked by security policy" : deleteContent, deleteBlocked);

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 4: Budget exhaustion
  // ═══════════════════════════════════════════════════════════════
  printScenario(4, "BUDGET EXHAUSTION");
  console.log(`${DIM}  Making rapid calls to exhaust $0.50 budget...${RESET}`);

  // Close and restart with near-exhausted budget
  await transport.close();
  resetState(0.49); // $0.01 remaining

  const transport2 = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
  });
  const client2 = new Client(
    { name: "demo-client-2", version: "1.0.0" },
    { capabilities: {} }
  );
  await client2.connect(transport2);
  await waitForServer(3000);
  await new Promise((r) => setTimeout(r, 500));

  // Use remaining budget
  await client2.callTool({
    name: "test-server__echo",
    arguments: { text: "spending-last-cent" },
  });

  printStep("test-server__echo", "Call is BLOCKED due to budget exhaustion");

  const budgetResult = await client2.callTool({
    name: "test-server__echo",
    arguments: { text: "this-should-fail" },
  });
  const budgetContent = (budgetResult.content as Array<{ text: string }>)[0]?.text || "";
  const budgetBlocked = budgetContent.includes("BUDGET EXHAUSTED");
  printResult(budgetBlocked ? "BUDGET EXHAUSTED: Agent deactivated" : budgetContent, budgetBlocked);

  // ═══════════════════════════════════════════════════════════════
  // SCENARIO 5: Kill switch
  // ═══════════════════════════════════════════════════════════════
  printScenario(5, "EMERGENCY KILL SWITCH");

  // Reset budget so we can test kill switch specifically
  await transport2.close();
  resetState(0);

  const transport3 = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
  });
  const client3 = new Client(
    { name: "demo-client-3", version: "1.0.0" },
    { capabilities: {} }
  );
  await client3.connect(transport3);
  await waitForServer(3000);
  await new Promise((r) => setTimeout(r, 500));

  console.log(`${DIM}  Activating emergency kill switch via dashboard API...${RESET}`);

  await fetch("http://localhost:3000/api/killswitch", { method: "POST" });
  await new Promise((r) => setTimeout(r, 100));

  printStep("test-server__echo", "ALL calls blocked by emergency kill switch");

  const killResult = await client3.callTool({
    name: "test-server__echo",
    arguments: { text: "emergency-test" },
  });
  const killContent = (killResult.content as Array<{ text: string }>)[0]?.text || "";
  const killBlocked = killContent.includes("EMERGENCY VETO");
  printResult(killBlocked ? "EMERGENCY VETO: All actions suspended" : killContent, killBlocked);

  // Cleanup
  await transport3.close();

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log();
  console.log(`${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}${BOLD}║                       DEMO SUMMARY                           ║${RESET}`);
  console.log(`${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`  ${BOLD}Total Scenarios:${RESET}  ${passed + failed}`);
  console.log(`  ${GREEN}${BOLD}Passed:${RESET}           ${passed}`);
  console.log(`  ${failed > 0 ? RED : DIM}${BOLD}Failed:${RESET}           ${failed}`);
  console.log();
  console.log(`  ${DIM}Audit Log:${RESET}        ${getLogsDir()}/audit_log.json`);
  console.log(`  ${DIM}Budget State:${RESET}     ${getLogsDir()}/budget_state.json`);
  console.log();

  if (failed === 0) {
    console.log(`  ${GREEN}${BOLD}✅ ALL SCENARIOS PASSED - DEMO COMPLETE${RESET}`);
  } else {
    console.log(`  ${RED}${BOLD}❌ SOME SCENARIOS FAILED${RESET}`);
  }

  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

runDemo().catch((error) => {
  console.error(`${RED}Demo error: ${error}${RESET}`);
  process.exit(1);
});
