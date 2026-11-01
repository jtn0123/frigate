package com.jtn.frigateviewer.tunnel

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TunnelSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where the tunnel stands, for Settings. */
sealed interface TunnelStatus {
    /** No tunnel has been imported. */
    data object NotSetUp : TunnelStatus

    /** Imported but turned off. */
    data object Off : TunnelStatus

    /** Android has to allow the app's VPN connection first. */
    data object NeedsPermission : TunnelStatus

    data object Checking : TunnelStatus

    /** The server answers directly, so the tunnel is not needed. */
    data object Home : TunnelStatus

    data object NoNetwork : TunnelStatus

    data object Connecting : TunnelStatus

    data object Connected : TunnelStatus

    /** [noAnswer]: the tunnel runs but its server never answered, so the cause is outside the phone. */
    data class Failed(val message: String, val noAnswer: Boolean = false) : TunnelStatus
}

/**
 * Uses the imported WireGuard tunnel when the server cannot be reached
 * directly, as away from home, and closes it when it can. It is checked when
 * the app comes to the front and as networks change while it is there, and
 * closed [idleMs] after the app leaves, so the VPN key stays off the status bar
 * when nothing needs it.
 */
class RemoteAccess(
    internal val scope: CoroutineScope,
    internal val store: SettingsStore,
    private val backend: TunnelBackend,
    private val route: DirectRoute,
    internal val packageName: String,
    private val idleMs: Long = IDLE_MS,
    private val handshakeMs: Long = HANDSHAKE_MS,
    /** How often the wait for the server's answer is logged; less often once it has given up. */
    private val reportMs: Long = REPORT_MS,
    /** What it did and why, to show and share when it does not work. */
    val log: TunnelLog = TunnelLog(),
) {
    var status by mutableStateOf<TunnelStatus>(TunnelStatus.NotSetUp)
        private set

    /** The imported tunnel; null until there is one. */
    var tunnel by mutableStateOf<TunnelSettings?>(null)
        private set

    /** Counts each time the tunnel goes up or down, so open connections can be remade on the new route. */
    var routeChanges by mutableIntStateOf(0)
        private set

    /** The configuration the running tunnel was started with; null while it is down. */
    private var upWith: String? = null

    /** The running tunnel's server has answered, so traffic gets through. */
    private var answered = false
    private var foreground = false

    /** The running tunnel's traffic as last read; null while it is down. */
    var stats by mutableStateOf<TunnelStats?>(null)
        private set

    /** The last reason the tunnel could not be used, so a repeat is not logged again. */
    private var previousBlock: TunnelStatus? = null
    private var checkJob: Job? = null
    private var idleJob: Job? = null
    private var watching: AutoCloseable? = null
    private val changing = Mutex()

    /** Follows the saved tunnel and server address, checking again when either changes. */
    fun start() {
        // Stopped outside the app: forget it was up, so it is not shown connected, and decide again.
        backend.watchStops {
            scope.launch {
                checkJob?.cancel()
                changing.withLock {
                    if (upWith == null) return@withLock
                    log.add("The VPN was turned off outside the app")
                    if (answered) routeChanges++
                    upWith = null
                    answered = false
                    stats = null
                    status = TunnelStatus.Checking
                }
                check()
            }
        }
        scope.launch {
            store.tunnel.combine(store.settings.map { it.baseUrl }) { saved, url -> listOf(saved?.config, saved?.enabled, url) }
                .distinctUntilChanged()
                .collect { check() }
        }
    }

    fun foreground() {
        foreground = true
        idleJob?.cancel()
        if (watching == null) {
            watching = route.watch {
                log.add("Networks changed")
                check(settleMs = SETTLE_MS)
            }
        }
        check()
    }

    fun background() {
        foreground = false
        watching?.close()
        watching = null
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(idleMs)
            checkJob?.cancel()
            changing.withLock {
                close("the app has been in the background ${idleMs / MS_PER_S} s")
                // Not left saying it is connected, or still waiting, through a tunnel that is down.
                if (status is TunnelStatus.Connected || status is TunnelStatus.Connecting || status is TunnelStatus.Failed) {
                    status = TunnelStatus.Checking
                }
            }
        }
    }

    /** Decides again, after [settleMs] so a burst of network changes is checked once. */
    fun check(settleMs: Long = 0) {
        checkJob?.cancel()
        checkJob = scope.launch {
            if (settleMs > 0) delay(settleMs)
            changing.withLock { decide() }
        }
    }

    /** The running tunnel's traffic, refreshed for the Tunnel log screen; null while it is down. */
    suspend fun refreshStats(): TunnelStats? = (if (upWith != null) backend.stats() else null).also { stats = it }

    private suspend fun decide() {
        val saved = store.tunnel.first()
        val url = store.settings.first().baseUrl
        tunnel = saved
        val blocked = blocked(saved, url, backend::hasPermission)
        if (saved == null || blocked != null) {
            close(closeReason(blocked ?: TunnelStatus.NotSetUp))
            status = blocked ?: TunnelStatus.NotSetUp
            if (status != previousBlock && status == TunnelStatus.NeedsPermission) log.add("Waiting for Android's VPN permission")
            previousBlock = status
        } else if (foreground) {
            previousBlock = null
            if (status !is TunnelStatus.Connected && status !is TunnelStatus.Home) status = TunnelStatus.Checking
            val probe = route.check(url)
            log.add("Direct check: ${probe.detail}")
            status = when (probe.reach) {
                Reach.DIRECT -> {
                    close("the server answers directly")
                    TunnelStatus.Home
                }
                Reach.NO_NETWORK -> TunnelStatus.NoNetwork
                Reach.NOT_DIRECT -> connect(saved)
            }
        }
    }

    private suspend fun connect(saved: TunnelSettings): TunnelStatus {
        if (upWith != saved.config || !answered) status = TunnelStatus.Connecting
        if (upWith != saved.config) log.add("Starting the tunnel to ${maskedEndpoints(saved.config)}")
        try {
            setUp(saved.config)
        } catch (e: TunnelConfigException) {
            log.add("Tunnel file not usable: ${e.message}")
            return TunnelStatus.Failed(e.message.orEmpty())
        } catch (e: TunnelException) {
            log.add("Tunnel did not start: ${e.message} (${e.cause?.let { it::class.simpleName + ": " + it.message } ?: "no detail"})")
            return TunnelStatus.Failed(e.message.orEmpty())
        }
        return if (answered) TunnelStatus.Connected else awaitAnswer()
    }

    /**
     * Waits for the VPN server's first handshake: a running tunnel alone
     * carries nothing if the server never answers. After [handshakeMs] that is
     * shown as a failure, while WireGuard keeps trying until this is cancelled.
     * Progress goes to the log every few seconds, with the bytes sent and
     * received: sent with nothing back means the server is not answering.
     */
    private suspend fun awaitAnswer(): TunnelStatus {
        val started = System.currentTimeMillis()
        var reported = started
        var every = reportMs
        var gaveUp = false
        log.add("Tunnel up, waiting for the VPN server to answer")
        while (refreshStats()?.lastHandshakeMs == null) {
            val now = System.currentTimeMillis()
            val waited = (now - started) / MS_PER_S
            if (!gaveUp && now - started > handshakeMs) {
                gaveUp = true
                status = TunnelStatus.Failed(NO_ANSWER, noAnswer = true)
                // One line with the figures, not a progress line after it saying the same. The wait
                // then goes on as long as the app is open, so it is logged less often from here, or
                // its lines would push the start of the story out of the log.
                log.add("Gave up waiting after $waited s: ${stats.describe()}. WireGuard keeps trying")
                reported = now
                every = reportMs * QUIET_FACTOR
            } else if (now - reported >= every) {
                reported = now
                log.add("No answer yet after $waited s: ${stats.describe()}")
            }
            delay(POLL_MS)
        }
        log.add("VPN server answered after ${(System.currentTimeMillis() - started) / MS_PER_S} s: ${stats.describe()}")
        answered = true
        routeChanges++
        return TunnelStatus.Connected
    }

    /** Closes the tunnel if it is up, logging [reason]. */
    private suspend fun close(reason: String) {
        if (upWith != null) log.add("Closing the tunnel: $reason")
        setUp(null)
    }

    /**
     * Runs the tunnel with [config], replacing one started with another, or
     * closes it when null. Connections move to it once its server answers.
     */
    private suspend fun setUp(config: String?) {
        if (config == upWith) return
        if (config != null) backend.up(appOnlyTunnel(config, packageName)) else backend.down()
        val wasAnswered = answered
        upWith = config
        answered = false
        if (config == null) stats = null
        if (config == null && wasAnswered) routeChanges++
    }

    private companion object {
        const val IDLE_MS = 60_000L
        const val SETTLE_MS = 1_000L
        const val HANDSHAKE_MS = 15_000L
        const val POLL_MS = 500L
        const val REPORT_MS = 5_000L
        const val MS_PER_S = 1_000L

        /** How many times less often the wait is logged once it has given up. */
        const val QUIET_FACTOR = 12
    }
}

/**
 * Shown when the tunnel runs but its server never answers. WireGuard servers
 * drop handshakes from a key they do not know without a word, so silence
 * means a missing client as often as a wrong address.
 */
internal const val NO_ANSWER = "The VPN server did not answer. WireGuard servers ignore a phone they do not know, so " +
    "check that this phone's client is still on the server: not deleted, re-created or left unsaved since the file " +
    "was downloaded, and that the VPN server is on. Then check the file's Endpoint is your home's public address, " +
    "its UDP port is open to the internet, and this network does not block UDP. It keeps trying; turn off " +
    "\"Use away from home\" to stop."

/** Why the tunnel is closed when it cannot be used, in words for the log. */
private fun closeReason(status: TunnelStatus): String = when (status) {
    TunnelStatus.NotSetUp -> "the tunnel file was removed"
    TunnelStatus.Off -> "it is turned off, or the app is signed out"
    TunnelStatus.NeedsPermission -> "Android no longer allows the VPN connection"
    else -> "$status"
}

/** Why the tunnel cannot be used at all, or null when it can. */
private fun blocked(saved: TunnelSettings?, url: String, permitted: () -> Boolean): TunnelStatus? = when {
    saved == null -> TunnelStatus.NotSetUp
    !saved.enabled || url.isBlank() -> TunnelStatus.Off
    !permitted() -> TunnelStatus.NeedsPermission
    else -> null
}

private fun TunnelStats?.describe(): String =
    if (this == null) "no figures" else "sent $sentBytes bytes, received $receivedBytes bytes"
