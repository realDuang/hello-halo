/**
 * Agent IPC Handlers
 */

import { ipcMain } from 'electron'
import { sendMessage, stopGeneration, getSessionState, ensureSessionWarm, testMcpConnections, resolveQuestion, queueMessage } from '../services/agent'
import { getMainWindow } from '../services/window.service'

export function registerAgentHandlers(): void {

  // Send message to agent (with optional images for multi-modal, optional thinking mode)
  ipcMain.handle(
    'agent:send-message',
    async (
      _event,
      request: {
        spaceId: string
        conversationId: string
        message: string
        resumeSessionId?: string
        images?: Array<{
          id: string
          type: 'image'
          mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
          data: string
          name?: string
          size?: number
        }>
        thinkingEnabled?: boolean  // Enable extended thinking mode
      }
    ) => {
      try {
        await sendMessage(getMainWindow(), request)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Queue a message while agent is generating
  ipcMain.handle(
    'agent:queue-message',
    async (
      _event,
      data: {
        conversationId: string
        message: string
        images?: Array<{
          id: string
          type: 'image'
          mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
          data: string
          name?: string
          size?: number
        }>
        canvasContext?: {
          isOpen: boolean
          tabCount: number
          activeTab: { type: string; title: string; url?: string; path?: string } | null
          tabs: Array<{ type: string; title: string; url?: string; path?: string; isActive: boolean }>
        }
      }
    ) => {
      try {
        queueMessage(data.conversationId, data.message, data.images, data.canvasContext)
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Stop generation for a specific conversation (or all if not specified)
  ipcMain.handle('agent:stop', async (_event, conversationId?: string) => {
    try {
      stopGeneration(conversationId)
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Approve/reject tool execution - no-op (all permissions auto-allowed)
  ipcMain.handle('agent:approve-tool', async () => ({ success: true }))
  ipcMain.handle('agent:reject-tool', async () => ({ success: true }))

  // Get current session state for recovery after refresh
  ipcMain.handle('agent:get-session-state', async (_event, conversationId: string) => {
    try {
      const state = getSessionState(conversationId)
      return { success: true, data: state }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Warm up V2 session - call when switching conversations to prepare for faster message sending
  ipcMain.handle('agent:ensure-session-warm', async (_event, spaceId: string, conversationId: string) => {
    try {
      // Async initialization, non-blocking IPC call
      ensureSessionWarm(spaceId, conversationId).catch((error: unknown) => {
        console.error('[IPC] ensureSessionWarm error:', error)
      })
      return { success: true }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Answer a pending AskUserQuestion
  ipcMain.handle(
    'agent:answer-question',
    async (
      _event,
      data: {
        conversationId: string
        id: string
        answers: Record<string, string>
      }
    ) => {
      try {
        const resolved = resolveQuestion(data.id, data.answers)
        if (!resolved) {
          return { success: false, error: 'No pending question found for this ID' }
        }
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Test MCP server connections
  ipcMain.handle('agent:test-mcp', async () => {
    try {
      const result = await testMcpConnections(getMainWindow())
      return result
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, servers: [], error: err.message }
    }
  })
}
