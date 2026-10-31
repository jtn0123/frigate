package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Where the live video is: [LiveVideo] reports each change. */
enum class LiveState { CONNECTING, PLAYING, FAILED }

/**
 * When the live video reconnects and when it gives up. Each attempt gets a
 * new player, keyed on [attempt] and [restarts]. Only failures since video
 * last played count, so blips during a long viewing session do not use up
 * the retries.
 */
class LiveRetry(private val maxRetries: Int = MAX_RETRIES) {
    var state by mutableStateOf(LiveState.CONNECTING)
        private set

    /** Bumped for each reconnect after a failure. */
    var attempt by mutableIntStateOf(0)
        private set

    /** Bumped when the app returns to the foreground, for a fresh connection. */
    var restarts by mutableIntStateOf(0)
        private set

    /** A reconnect is due after [RETRY_DELAY_MS]; see [retry]. */
    var pendingRetry by mutableStateOf(false)
        private set

    private var failures = 0

    fun played() {
        state = LiveState.PLAYING
        failures = 0
    }

    fun failed() {
        if (failures < maxRetries) {
            failures++
            state = LiveState.CONNECTING
            pendingRetry = true
        } else {
            state = LiveState.FAILED
        }
    }

    /** Starts the pending reconnect, once the network has had a moment. */
    fun retry() {
        if (!pendingRetry) return
        pendingRetry = false
        attempt++
    }

    /** Back from the background: start again with every retry available. */
    fun resumed() {
        failures = 0
        pendingRetry = false
        state = LiveState.CONNECTING
        restarts++
    }

    companion object {
        const val MAX_RETRIES = 2
        const val RETRY_DELAY_MS = 1_500L
    }
}
