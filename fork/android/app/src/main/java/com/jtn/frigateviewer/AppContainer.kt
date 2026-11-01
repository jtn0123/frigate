package com.jtn.frigateviewer

import android.app.Activity
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.ui.authenticate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * What the app, its widget and the widget's setup share, built once per
 * process by [FrigateApp]: the settings store, the tunnel, the media files,
 * the unlock prompt, and how a saved sign-in becomes a session.
 */
class AppContainer(
    val settingsStore: SettingsStore,
    val mediaFiles: MediaFiles?,
    remoteAccess: () -> RemoteAccess?,
    /** Asks for a fingerprint, face or the screen lock; tests, which have no prompt, answer themselves. */
    val unlock: Activity.(onResult: (success: Boolean, reason: String?) -> Unit) -> Unit = Activity::authenticate,
) {
    /** The tunnel, started on first use; null where there is none, as in tests. */
    val remoteAccess: RemoteAccess? by lazy(remoteAccess)

    /**
     * A session for the saved [settings], or null when they cannot resume one.
     * What the server changes, a renewed token or a certificate trusted on first
     * use, is saved from [scope] in one transaction with [SettingsStore.update],
     * so it never puts back an older value another entry point saved meanwhile.
     */
    fun resumeSession(settings: ServerSettings, scope: CoroutineScope): Session? = if (settings.canResume) {
        Session.saving(settings) { change -> scope.launch { settingsStore.update(change) } }
    } else {
        null
    }
}
