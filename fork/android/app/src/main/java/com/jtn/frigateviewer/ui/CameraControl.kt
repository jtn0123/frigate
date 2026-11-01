package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.FeedCommands
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.profile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Changing cameras, for admins: turning detection, recording and snapshots
 * on or off, and moving PTZ cameras. Commands go over the live feed, as in
 * Frigate's web UI, so they need it open.
 */
class CameraControl(private val scope: CoroutineScope, private val onSessionLost: (UiText?) -> Unit) {
    var isAdmin by mutableStateOf(false)
        private set

    /** The open feed's sender; null while it is closed. */
    var commands by mutableStateOf<FeedCommands?>(null)
        internal set

    /** A one-time message, such as a command that could not be sent; cleared with [noticeShown]. */
    var notice by mutableStateOf<UiText?>(null)
        private set

    fun loadRole(api: FrigateApi): Job = scope.launch {
        isAdmin = (loadRemote(onSessionLost) { api.profile() } as? Remote.Ready)?.value?.isAdmin == true
    }

    /** Turns [switch] (such as `detect` or `recordings`) of [camera] on or off. */
    fun setSwitch(camera: String, switch: String, on: Boolean): Boolean = send("$camera/$switch/set", if (on) "ON" else "OFF")

    /** Sends a [com.jtn.frigateviewer.data.Ptz] command to [camera]. */
    fun ptz(camera: String, command: String): Boolean = send("$camera/ptz", command)

    private fun send(topic: String, payload: String): Boolean {
        val sent = commands?.send(topic, payload) == true
        if (!sent) notice = uiText(R.string.control_not_connected)
        return sent
    }

    fun noticeShown() {
        notice = null
    }

    fun reset() {
        isAdmin = false
        commands = null
        notice = null
    }
}
