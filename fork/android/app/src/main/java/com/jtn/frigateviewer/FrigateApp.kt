package com.jtn.frigateviewer

import android.app.Application
import android.util.Log
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.tunnel.AndroidDirectRoute
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.TunnelLog
import com.jtn.frigateviewer.tunnel.WireGuardBackend
import kotlinx.coroutines.MainScope

/** Holds what outlives an activity: the tunnel, which the widget's requests use too while it is up. */
class FrigateApp : Application() {
    val remoteAccess by lazy {
        RemoteAccess(
            MainScope(),
            SettingsStore.create(this),
            WireGuardBackend(this),
            AndroidDirectRoute(this),
            packageName,
            // Also in the system log, so `adb logcat -s FrigateTunnel` shows it.
            log = TunnelLog(echo = { Log.i(LOG_TAG, it) }),
        ).also { it.start() }
    }

    private companion object {
        const val LOG_TAG = "FrigateTunnel"
    }
}
