/**
 * Halo Auto-Updater Service
 * Handles automatic updates via GitHub Releases
 */

// Node/Electron imports
import { app, BrowserWindow, ipcMain } from 'electron'

// Third-party imports
import electronUpdater from 'electron-updater'
import { is } from '@electron-toolkit/utils'

// Local imports
import { getMainWindow } from './window.service'

// Type imports
const { autoUpdater } = electronUpdater
type UpdateInfo = electronUpdater.UpdateInfo

// ============================================================================
// Constants
// ============================================================================

/** Delay before quitAndInstall to ensure windows close properly (ms) */
const QUIT_AND_INSTALL_DELAY_MS = 300

// ============================================================================
// Configuration
// ============================================================================

// Configure logging
autoUpdater.logger = console

// Auto download updates
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

// Disable code signing verification for ad-hoc signed apps (no Apple Developer certificate)
// This allows updates to work without purchasing an Apple Developer account
if (process.platform === 'darwin') {
  autoUpdater.forceDevUpdateConfig = true
}

/**
 * Initialize auto-updater
 */
export function initAutoUpdater(): void {

  // Skip updates in development
  if (is.dev) {
    console.log('[Updater] Skipping auto-update in development mode')
    return
  }

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
    sendUpdateStatus('checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[Updater] Update available:', info.version)

    // On macOS without code signing, skip auto-download and show manual download option
    if (process.platform === 'darwin') {
      console.log('[Updater] macOS: Skipping auto-download, showing manual download option')
      sendUpdateStatus('manual-download', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    } else {
      // Windows/Linux: Proceed with auto-download
      sendUpdateStatus('available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    }
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[Updater] No update available, current version is latest:', info.version)
    sendUpdateStatus('not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    sendUpdateStatus('downloading', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('[Updater] Update downloaded:', info.version)
    sendUpdateStatus('downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error.message)
    // On auto-download failure, show manual download option instead of error
    // User won't see "failed", just "version available for manual download"
    sendUpdateStatus('manual-download', {
      message: 'Version available for manual download'
    })
  })

  // Check for updates on startup (with delay to not block app launch)
  setTimeout(() => {
    checkForUpdates()
  }, 5000)
}

/**
 * Send update status to renderer
 */
function sendUpdateStatus(
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-download' | 'error',
  data?: Record<string, unknown>
): void {
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data })
  }
}

/**
 * Check for updates
 */
export async function checkForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    return
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error)
  }
}

/**
 * Quit and install update
 *
 * Important timing considerations for Windows NSIS:
 * 1. Add delay to ensure app fully closes before installer starts
 * 2. Use isSilent=false to show installer UI, isForceRunAfter=true to restart after install
 *
 * @see https://github.com/electron-userland/electron-builder/issues/1368
 */
export function quitAndInstall(): void {
  // Delay to ensure all windows close before installer launches
  setTimeout(() => {
    try {
      // isSilent=false: show installer UI for user feedback
      // isForceRunAfter=true: restart app after install completes
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      console.error('[Updater] quitAndInstall failed:', error)
    }
  }, QUIT_AND_INSTALL_DELAY_MS)
}

/**
 * Register IPC handlers for updater
 */
export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    await checkForUpdates()
  })

  ipcMain.handle('updater:install', () => {
    quitAndInstall()
  })

  ipcMain.handle('updater:get-version', () => {
    return app.getVersion()
  })
}
