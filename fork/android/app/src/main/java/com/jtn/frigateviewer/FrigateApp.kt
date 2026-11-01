package com.jtn.frigateviewer

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import com.jtn.frigateviewer.data.AndroidMediaFiles
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.tunnel.AndroidDirectRoute
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TunnelLog
import com.jtn.frigateviewer.tunnel.WireGuardBackend
import kotlinx.coroutines.MainScope

/** Holds what outlives an activity, in its [container]: the tunnel, which the widget's requests use too while it is up. */
class FrigateApp : Application() {
    @Volatile private var built: AppContainer? = null

    /**
     * The process's one [AppContainer], built on first use by whichever of the
     * app, the widget or its setup comes first. Tests set their own before that.
     */
    var container: AppContainer
        get() = built ?: synchronized(this) { built ?: create().also { built = it } }

        @VisibleForTesting
        set(value) {
            built = value
        }

    private fun create(): AppContainer {
        val store = SettingsStore.create(this)
        return AppContainer(store, AndroidMediaFiles(this), remoteAccess = {
            RemoteAccess(
                MainScope(),
                store,
                WireGuardBackend(this),
                AndroidDirectRoute(this),
                packageName,
                log = tunnelLog(),
            ).also { it.start() }
        })
    }

    companion object {
        private const val LOG_TAG = "FrigateTunnel"

        /**
         * The tunnel's log. Debug builds also send it to the system log, so
         * `adb logcat -s FrigateTunnel` shows it; release builds keep it in the
         * app, since even redacted it tells anyone with adb the network history.
         */
        internal fun tunnelLog(debug: Boolean = BuildConfig.DEBUG): TunnelLog =
            if (debug) TunnelLog(echo = { Log.i(LOG_TAG, it) }) else TunnelLog()
    }
}

/** The app's [AppContainer], from any of its components. */
val Context.container: AppContainer get() = (applicationContext as FrigateApp).container
