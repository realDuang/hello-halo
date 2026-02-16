/**
 * AI Browser Tools - Export all tools
 *
 * This module exports all 26 AI Browser tools organized by category.
 *
 * WARNING: This entire directory is DEAD CODE. The actual tool handlers
 * run from sdk-mcp-server.ts via the SDK MCP server. These definitions
 * are never executed at runtime. See sdk-mcp-server.ts header for
 * refactor plan.
 */

import type { AIBrowserTool } from '../types'
import { navigationTools } from './navigation'
import { inputTools } from './input'
import { snapshotTools } from './snapshot'
import { networkTools } from './network'
import { consoleTools } from './console'
import { emulationTools } from './emulation'
import { performanceTools } from './performance'

/**
 * All AI Browser tools (26 total)
 *
 * The authoritative implementation lives in sdk-mcp-server.ts.
 * These tool definitions serve as schema references and as a
 * fallback execution path via executeAIBrowserTool().
 */
export const allTools: AIBrowserTool[] = [
  ...navigationTools,    // 8 tools: list_pages, select_page, new_page, close_page, navigate, wait_for, resize, handle_dialog
  ...inputTools,         // 7 tools: click, hover, fill, fill_form, drag, press_key, upload_file
  ...snapshotTools,      // 3 tools: snapshot, screenshot, evaluate
  ...networkTools,       // 2 tools: network_requests, network_request
  ...consoleTools,       // 2 tools: console, console_message
  ...emulationTools,     // 1 tool:  emulate
  ...performanceTools    // 3 tools: perf_start, perf_stop, perf_insight
]

/**
 * Get all tool names for SDK registration
 */
export function getToolNames(): string[] {
  return allTools.map(t => t.name)
}

/**
 * Find a tool by name
 */
export function findTool(name: string): AIBrowserTool | undefined {
  return allTools.find(t => t.name === name)
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): AIBrowserTool[] {
  return allTools.filter(t => t.category === category)
}

/**
 * Get tool definitions for SDK (name, description, inputSchema)
 */
export function getToolDefinitions(): Array<{
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}> {
  return allTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: tool.inputSchema.properties as Record<string, unknown>,
      required: tool.inputSchema.required
    }
  }))
}

// Re-export individual tool groups
export { navigationTools } from './navigation'
export { inputTools } from './input'
export { snapshotTools } from './snapshot'
export { networkTools } from './network'
export { consoleTools } from './console'
export { emulationTools } from './emulation'
export { performanceTools } from './performance'
