/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Agent Module - Send Message
 *
 * Core message sending logic including:
 * - API credential resolution and routing
 * - V2 Session management
 * - SDK message streaming and processing
 * - Token-level streaming support
 * - Error handling and recovery
 */

import { BrowserWindow } from 'electron'
import { getConfig } from '../config.service'
import { getConversation, saveSessionId, addMessage, updateLastMessage } from '../conversation.service'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { notifyTaskComplete } from '../notification.service'
import {
  AI_BROWSER_SYSTEM_PROMPT,
  createAIBrowserMcpServer
} from '../ai-browser'
import { createHaloAppsMcpServer } from '../../apps/conversation-mcp'
import type {
  AgentRequest,
  SessionConfig,
} from './types'
import {
  getHeadlessElectronPath,
  getWorkingDir,
  getApiCredentials,
  getEnabledMcpServers,
  sendToRenderer,
  setMainWindow
} from './helpers'
import { buildSystemPromptWithAIBrowser } from './system-prompt'
import {
  getOrCreateV2Session,
  closeV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  v2Sessions
} from './session-manager'
import {
  formatCanvasContext,
  buildMessageContent,
} from './message-utils'
import { onAgentError, runPpidScanAndCleanup } from '../health'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from './sdk-config'
import { processStream } from './stream-processor'

// Unified fallback error suffix - guides user to check logs
const FALLBACK_ERROR_HINT = 'Check logs in Settings > System > Logs.'

// ============================================
// Message Queue (per-conversation)
// ============================================

/**
 * Queued message entry - user input submitted while agent is generating
 *
 * Inspired by Claude Code CLI's input queue mechanism: when the user sends
 * a message while the agent is busy, it is queued and automatically processed
 * after the current turn completes, rather than being rejected.
 */
interface QueuedMessage {
  message: string
  images?: AgentRequest['images']
  canvasContext?: AgentRequest['canvasContext']
}

/** Per-conversation message queues */
const messageQueues = new Map<string, QueuedMessage[]>()

/**
 * Queue a message for a conversation that is currently generating.
 * The message will be automatically sent after the current turn completes.
 */
export function queueMessage(
  conversationId: string,
  message: string,
  images?: AgentRequest['images'],
  canvasContext?: AgentRequest['canvasContext']
): void {
  const queue = messageQueues.get(conversationId) || []
  queue.push({ message, images, canvasContext })
  messageQueues.set(conversationId, queue)
  console.log(`[Agent][${conversationId}] Message queued (queue size: ${queue.length})`)
}

/**
 * Dequeue the next message for a conversation, if any.
 */
function dequeueMessage(conversationId: string): QueuedMessage | undefined {
  const queue = messageQueues.get(conversationId)
  if (!queue || queue.length === 0) return undefined
  const item = queue.shift()
  if (queue.length === 0) {
    messageQueues.delete(conversationId)
  }
  console.log(`[Agent][${conversationId}] Message dequeued (remaining: ${queue?.length ?? 0})`)
  return item
}

/**
 * Clear all queued messages for a conversation.
 * Called when the user stops generation or on error.
 */
export function clearMessageQueue(conversationId: string): void {
  const queue = messageQueues.get(conversationId)
  if (queue && queue.length > 0) {
    console.log(`[Agent][${conversationId}] Clearing ${queue.length} queued message(s)`)
  }
  messageQueues.delete(conversationId)
}

/**
 * Get the number of queued messages for a conversation.
 */
export function getQueueSize(conversationId: string): number {
  return messageQueues.get(conversationId)?.length ?? 0
}

// ============================================
// Send Message
// ============================================

/**
 * Send message to agent (supports multiple concurrent sessions)
 *
 * This is the main entry point for sending messages to the AI agent.
 * It handles:
 * - API credential resolution (Anthropic, OpenAI, OAuth providers)
 * - V2 Session creation/reuse
 * - Message streaming with token-level updates
 * - Tool calls and permissions
 * - Error handling and recovery
 */
export async function sendMessage(
  mainWindow: BrowserWindow | null,
  request: AgentRequest
): Promise<void> {
  setMainWindow(mainWindow)

  const {
    spaceId,
    conversationId,
    message,
    resumeSessionId,
    images,
    aiBrowserEnabled,
    thinkingEnabled,
    canvasContext
  } = request

  console.log(`[Agent] sendMessage: conv=${conversationId}${images && images.length > 0 ? `, images=${images.length}` : ''}${aiBrowserEnabled ? ', AI Browser enabled' : ''}${thinkingEnabled ? ', thinking=ON' : ''}${canvasContext?.isOpen ? `, canvas tabs=${canvasContext.tabCount}` : ''}`)

  const config = getConfig()
  const workDir = getWorkingDir(spaceId)

  // Create abort controller for this session
  const abortController = new AbortController()

  // Accumulate stderr for detailed error messages
  let stderrBuffer = ''

  // Create session state (registered as active AFTER session is ready, see below)
  const sessionState = createSessionState(spaceId, conversationId, abortController)

  // Add user message to conversation (with images if provided)
  addMessage(spaceId, conversationId, {
    role: 'user',
    content: message,
    images: images  // Include images in the saved message
  })

  // Add placeholder for assistant response
  addMessage(spaceId, conversationId, {
    role: 'assistant',
    content: '',
    toolCalls: []
  })

  try {
    // Get API credentials and resolve for SDK use (inside try/catch so errors reach frontend)
    const credentials = await getApiCredentials(config)
    console.log(`[Agent] sendMessage using: ${credentials.provider}, model: ${credentials.model}`)

    // Resolve credentials for SDK (handles OpenAI compat router for non-Anthropic providers)
    const resolvedCredentials = await resolveCredentialsForSdk(credentials)

    // Get conversation for session resumption
    const conversation = getConversation(spaceId, conversationId)
    const sessionId = resumeSessionId || conversation?.sessionId
    // Use headless Electron binary (outside .app bundle on macOS to prevent Dock icon)
    const electronPath = getHeadlessElectronPath()
    console.log(`[Agent] Using headless Electron as Node runtime: ${electronPath}`)

    // Get enabled MCP servers
    const enabledMcpServers = getEnabledMcpServers(config.mcpServers || {})

    // Build MCP servers config (including AI Browser if enabled)
    const mcpServers: Record<string, any> = enabledMcpServers ? { ...enabledMcpServers } : {}
    if (aiBrowserEnabled) {
      mcpServers['ai-browser'] = createAIBrowserMcpServer()
      console.log(`[Agent][${conversationId}] AI Browser MCP server added`)
    }

    // Always add halo-apps MCP for automation control
    mcpServers['halo-apps'] = createHaloAppsMcpServer(spaceId)
    console.log(`[Agent][${conversationId}] Halo Apps MCP server added`)
    console.log(`[mcpServers]${Object.keys(mcpServers)}`)
    // Build base SDK options using shared configuration
    const sdkOptions = buildBaseSdkOptions({
      credentials: resolvedCredentials,
      workDir,
      electronPath,
      spaceId,
      conversationId,
      abortController,
      stderrHandler: (data: string) => {
        console.error(`[Agent][${conversationId}] CLI stderr:`, data)
        stderrBuffer += data  // Accumulate for error reporting
      },
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : null,
      maxTurns: config.agent?.maxTurns
    })

    // Apply dynamic configurations (AI Browser system prompt, Thinking mode)
    // These are specific to sendMessage and not part of base options
    if (aiBrowserEnabled) {
      sdkOptions.systemPrompt = buildSystemPromptWithAIBrowser(
        { workDir, modelInfo: resolvedCredentials.displayModel },
        AI_BROWSER_SYSTEM_PROMPT
      )
    }
    if (thinkingEnabled) {
      sdkOptions.maxThinkingTokens = 10240
    }

    const t0 = Date.now()
    console.log(`[Agent][${conversationId}] Getting or creating V2 session...`)

    // Log MCP servers if configured (only enabled ones)
    const mcpServerNames = enabledMcpServers ? Object.keys(enabledMcpServers) : []
    if (mcpServerNames.length > 0) {
      console.log(`[Agent][${conversationId}] MCP servers configured: ${mcpServerNames.join(', ')}`)
    }

    // Session config for rebuild detection
    const sessionConfig: SessionConfig = {
      aiBrowserEnabled: !!aiBrowserEnabled
    }

    // Get or create persistent V2 session for this conversation
    // Pass config for rebuild detection when aiBrowserEnabled changes
    // Pass workDir for session migration support (from old ~/.claude to new config dir)
    const v2Session = await getOrCreateV2Session(spaceId, conversationId, sdkOptions, sessionId, sessionConfig, workDir)

    // Register as active AFTER session is ready, so getOrCreateV2Session's
    // in-flight check doesn't mistake the current request as a concurrent one
    // (which would incorrectly defer session rebuild when aiBrowserEnabled changes)
    registerActiveSession(conversationId, sessionState)

    // Dynamic runtime parameter adjustment (via SDK patch)
    // Note: Model switching is handled by session rebuild (model change triggers
    // credentialsGeneration bump in config.service). setModel is kept for SDK
    // compatibility but is not effective for actual model routing when all providers
    // route through the OpenAI compat router (model is baked into ANTHROPIC_API_KEY).
    try {
      // Set model in SDK (informational; actual model determined by session credentials)
      if (v2Session.setModel) {
        await v2Session.setModel(resolvedCredentials.sdkModel)
        console.log(`[Agent][${conversationId}] Model set: ${resolvedCredentials.sdkModel}`)
      }

      // Set thinking tokens dynamically
      if (v2Session.setMaxThinkingTokens) {
        await v2Session.setMaxThinkingTokens(thinkingEnabled ? 10240 : null)
        console.log(`[Agent][${conversationId}] Thinking mode: ${thinkingEnabled ? 'ON (10240 tokens)' : 'OFF'}`)
      }
    } catch (e) {
      console.error(`[Agent][${conversationId}] Failed to set dynamic params:`, e)
    }
    console.log(`[Agent][${conversationId}] ⏱️ V2 session ready: ${Date.now() - t0}ms`)

    // Process the stream (with queued message loop)
    // After each turn, check if the user queued additional messages while the agent
    // was generating. If so, process them as follow-up turns within the same session,
    // similar to how Claude Code CLI handles its input queue.
    let currentMessage = message
    let currentImages = images
    let currentCanvasContext = canvasContext
    let turnStartTime = t0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Prepare message content (canvas context prefix + multi-modal images)
      if (currentImages && currentImages.length > 0) {
        console.log(`[Agent][${conversationId}] Message includes ${currentImages.length} image(s)`)
      }
      const canvasPrefix = formatCanvasContext(currentCanvasContext)
      const messageWithContext = canvasPrefix + currentMessage
      const messageContent = buildMessageContent(messageWithContext, currentImages)

      await processStream({
        v2Session,
        sessionState,
        spaceId,
        conversationId,
        messageContent,
        displayModel: resolvedCredentials.displayModel,
        abortController,
        t0: turnStartTime,
        skipCompleteEvent: true, // We'll send complete after the loop
        callbacks: {
          onComplete: (streamResult) => {
            // Save session ID for future resumption
            if (streamResult.capturedSessionId) {
              saveSessionId(spaceId, conversationId, streamResult.capturedSessionId)
              console.log(`[Agent][${conversationId}] Session ID saved:`, streamResult.capturedSessionId)
            }

            // Persist content and/or error to conversation
            const { finalContent, thoughts, tokenUsage, hasErrorThought, errorThought } = streamResult
            if (finalContent || hasErrorThought) {
              if (finalContent) {
                console.log(`[Agent][${conversationId}] Saving content: ${finalContent.length} chars`)
              }
              if (hasErrorThought) {
                console.log(`[Agent][${conversationId}] Persisting error to message: ${errorThought?.content}`)
              }

              // Extract file changes summary for immediate display (without loading thoughts)
              let metadata: { fileChanges?: FileChangesSummary } | undefined
              if (thoughts.length > 0) {
                try {
                  const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts)
                  if (fileChangesSummary) {
                    metadata = { fileChanges: fileChangesSummary }
                    console.log(`[Agent][${conversationId}] File changes: ${fileChangesSummary.totalFiles} files, +${fileChangesSummary.totalAdded} -${fileChangesSummary.totalRemoved}`)
                  }
                } catch (error) {
                  console.error(`[Agent][${conversationId}] Failed to extract file changes:`, error)
                }
              }

              updateLastMessage(spaceId, conversationId, {
                content: finalContent,
                thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
                tokenUsage: tokenUsage || undefined,
                metadata,
                error: errorThought?.content
              })
            } else {
              console.log(`[Agent][${conversationId}] No content to save`)
            }
          }
        }
      })

      // Check for queued messages after this turn completes
      if (abortController.signal.aborted) break

      const queued = dequeueMessage(conversationId)
      if (!queued) break

      // Process queued message as a new turn
      console.log(`[Agent][${conversationId}] Processing queued message (remaining: ${getQueueSize(conversationId)})`)

      // Reset session state for the new turn
      sessionState.thoughts = []

      // Add the queued user message to conversation
      addMessage(spaceId, conversationId, {
        role: 'user',
        content: queued.message,
        images: queued.images
      })

      // Add placeholder for assistant response
      addMessage(spaceId, conversationId, {
        role: 'assistant',
        content: '',
        toolCalls: []
      })

      // Notify frontend about the queued message being processed
      // Frontend uses this to reload conversation data and reset streaming state
      sendToRenderer('agent:queue-processed', spaceId, conversationId, {
        type: 'queue-processed',
        message: queued.message,
        images: queued.images,
        remainingQueue: getQueueSize(conversationId)
      })

      currentMessage = queued.message
      currentImages = queued.images
      currentCanvasContext = queued.canvasContext
      turnStartTime = Date.now()
    }

    // Send final complete event after all turns are done
    sendToRenderer('agent:complete', spaceId, conversationId, {
      type: 'complete',
      duration: Date.now() - t0,
      tokenUsage: undefined
    })

    // System notification for task completion (if window not focused)
    notifyTaskComplete(conversation?.title || 'Conversation')

  } catch (error: unknown) {
    const err = error as Error

    // Don't report abort as error
    if (err.name === 'AbortError') {
      console.log(`[Agent][${conversationId}] Aborted by user`)
      return
    }

    console.error(`[Agent][${conversationId}] Error:`, error)

    // Extract detailed error message from stderr if available
    let errorMessage = err.message || `Unknown error. ${FALLBACK_ERROR_HINT}`

    // Windows: Check for Git Bash related errors
    if (process.platform === 'win32') {
      const isExitCode1 = errorMessage.includes('exited with code 1') ||
                          errorMessage.includes('process exited') ||
                          errorMessage.includes('spawn ENOENT')
      const isBashError = stderrBuffer?.includes('bash') ||
                          stderrBuffer?.includes('ENOENT') ||
                          errorMessage.includes('ENOENT')

      if (isExitCode1 || isBashError) {
        // Check if Git Bash is properly configured
        const { detectGitBash } = require('../git-bash.service')
        const gitBashStatus = detectGitBash()

        if (!gitBashStatus.found) {
          errorMessage = 'Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.'
        } else {
          // Git Bash found but still got error - could be path issue
          errorMessage = 'Command execution failed. This may be an environment configuration issue, please try restarting the app.\n\n' +
                        `Technical details: ${err.message}`
        }
      }
    }

    if (stderrBuffer && !errorMessage.includes('Command execution')) {
      // Try to extract the most useful error info from stderr
      const mcpErrorMatch = stderrBuffer.match(/Error: Invalid MCP configuration:[\s\S]*?(?=\n\s*at |$)/m)
      const genericErrorMatch = stderrBuffer.match(/Error: [\s\S]*?(?=\n\s*at |$)/m)
      if (mcpErrorMatch) {
        errorMessage = mcpErrorMatch[0].trim()
      } else if (genericErrorMatch) {
        errorMessage = genericErrorMatch[0].trim()
      }
    }

    sendToRenderer('agent:error', spaceId, conversationId, {
      type: 'error',
      error: errorMessage
    })

    // Persist error to the assistant placeholder message so it survives conversation reload
    updateLastMessage(spaceId, conversationId, {
      content: '',
      error: errorMessage
    })

    // Emit health event for monitoring
    onAgentError(conversationId, errorMessage)

    // Run PPID scan to clean up dead processes (async, don't wait)
    runPpidScanAndCleanup().catch(err => {
      console.error('[Agent] PPID scan after error failed:', err)
    })

    // Close V2 session on error (it may be in a bad state)
    closeV2Session(conversationId)
    // Clear any queued messages on error
    clearMessageQueue(conversationId)
  } finally {
    // Clean up active session state (but keep V2 session for reuse)
    unregisterActiveSession(conversationId)
    console.log(`[Agent][${conversationId}] Active session state cleaned up. V2 sessions: ${v2Sessions.size}`)
  }
}

