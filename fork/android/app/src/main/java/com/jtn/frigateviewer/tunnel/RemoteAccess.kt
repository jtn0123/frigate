package com.jtn.frigateviewer.tunnel

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TunnelSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

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

    /** The server answers through another app's VPN, such as UniFi Teleport, so the tunnel is not needed. */
    data object OtherVpn : TunnelStatus

    /**
     * Another app's VPN is on but does not reach the server. Android runs one
     * VPN at a time, so starting the tunnel would turn that one off: it waits
     * for the user to choose.
     */
    data object OtherVpnInTheWay : TunnelStatus

    /** The tunnel was turned off outside the app, as in Android's VPN settings, so it is not started again unasked. */
    data object StoppedOutside : TunnelStatus

    data object NoNetwork : TunnelStatus

    data object Connecting : TunnelStatus

    data object Connected : TunnelStatus

    /** [noAnswer]: the tunnel runs but its server never answered, so the cause is outside the phone. */
    data class Failed(val message: String, val noAnswer: Boolean = false) : TunnelStatus
}

/** The way the app's connections reach the server. */
internal enum class Path { NONE, DIRECT, OTHER_VPN, TUNNEL }

private fun Path?.works() = this != null && this != Path.NONE

/**
 * Counts the changes of [Path] that open connections must follow: to a way
 * that works, and away from the tunnel, whose connections end with it. A way
 * that stops working is not counted, since reloading over it would only
 * replace what is shown with an error.
 */
internal class PathChanges {
    var count by mutableIntStateOf(0)
        private set

    /** The current way; null until the first check, or when it is not known. */
    var path: Path? = null
        private set

    fun moveTo(next: Path?) {
        val old = path
        path = next
        val changed = old != null && old != next
        if (changed && (old == Path.TUNNEL || next.works())) count++
    }
}

/**
 * Uses the imported WireGuard tunnel when the server cannot be reached
 * otherwise, as away from home, and closes it when it can: directly, or
 * through another app's VPN such as UniFi Teleport, which the tunnel would
 * turn off. It is checked when the app comes to the front and as networks
 * change while it is there, and closed [idleMs] after the app leaves, so the
 * VPN key stays off the status bar when nothing needs it.
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

    private val paths = PathChanges()

    /** Counts each time the way to the server changes, so open connections can be remade on the new one. */
    val routeChanges: Int get() = paths.count

    /** Whether Android allowed the VPN when last asked; null until the tunnel was needed, the only time it is asked. */
    var permitted: Boolean? = null
        private set

    /** Whether another app's VPN carries the app's connections now. */
    val otherVpnOn: Boolean get() = route.otherVpnOn(ownTunnelUp = upWith != null)

    /** The configuration the running tunnel was started with; null while it is down. */
    private var upWith: String? = null

    /** The running tunnel's server has answered, so traffic gets through. */
    private var answered = false
    private var foreground = false

    /** When the running tunnel began waiting for its server's first answer; kept across checks. */
    private var waitingSince: Long? = null

    /** The wait has been shown as a failure. */
    private var gaveUp = false

    /** The user chose the tunnel over another VPN that does not reach the server. */
    internal var overOtherVpn = false

    /** The tunnel was turned off outside the app, and that is not explained by another VPN taking over yet. */
    internal var stoppedOutside = false

    /** The running tunnel's traffic as last read; null while it is down. */
    var stats by mutableStateOf<TunnelStats?>(null)
        private set

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
                    // Asked as if the tunnel were down, which it is: a VPN on now is another app's.
                    val takenOver = route.otherVpnOn(ownTunnelUp = false)
                    log.add(if (takenOver) "Another VPN took over from the tunnel" else "The VPN was turned off outside the app")
                    upWith = null
                    answered = false
                    waitingSince = null
                    gaveUp = false
                    stats = null
                    overOtherVpn = false
                    stoppedOutside = true
                    paths.moveTo(Path.NONE)
                    status = TunnelStatus.Checking
                }
                // A moment for a VPN taking over to come up, so it is seen rather than turned off.
                check(settleMs = SETTLE_MS)
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
                paths.moveTo(null)
                // A new visit: a tunnel turned off outside the app may be used again.
                stoppedOutside = false
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
        val blocked = if (saved == null) TunnelStatus.NotSetUp else blocked(saved, url)
        if (saved == null || blocked != null) {
            val now = blocked ?: TunnelStatus.NotSetUp
            close(closeReason(now))
            paths.moveTo(null)
            status = now
            return
        }
        if (!foreground) return
        // A check while the tunnel runs, or the way is known, keeps what is shown until it is decided.
        if (upWith == null && status !in SETTLED) status = TunnelStatus.Checking
        val probe = route.check(url, ownTunnelUp = upWith != null)
        log.add("Direct check: ${probe.detail}")
        // A VPN that took over from the tunnel explains why it was stopped.
        if (probe.otherVpn) stoppedOutside = false
        val needed = probe.reach == Reach.NOT_DIRECT && !stoppedOutside
        val mayTurnOffOther = !probe.otherVpn || overOtherVpn
        status = if (needed && mayTurnOffOther) connect(saved) else withoutTunnel(probe)
    }

    /**
     * The tunnel is not started: the server answers directly or through
     * another app's VPN; or that VPN does not reach it, but the tunnel would
     * turn it off, so it waits for the user to choose; or it was turned off
     * outside the app; or there is no network.
     */
    private suspend fun withoutTunnel(probe: Probe): TunnelStatus {
        val next = when {
            probe.reach == Reach.NO_NETWORK -> TunnelStatus.NoNetwork
            probe.reach == Reach.DIRECT -> if (probe.otherVpn) TunnelStatus.OtherVpn else TunnelStatus.Home
            probe.otherVpn -> TunnelStatus.OtherVpnInTheWay
            else -> TunnelStatus.StoppedOutside
        }
        when (next) {
            TunnelStatus.Home, TunnelStatus.OtherVpn -> {
                overOtherVpn = false
                stoppedOutside = false
                close(if (probe.otherVpn) "another VPN reaches the server" else "the server answers directly")
            }
            TunnelStatus.OtherVpnInTheWay -> close("another VPN is on")
            else -> {
                // Nothing could answer without a network, so the wait starts again with one.
                waitingSince = null
                gaveUp = false
            }
        }
        if (status != next) WITHOUT_TUNNEL[next]?.let(log::add)
        paths.moveTo(PATHS[next] ?: Path.NONE)
        return next
    }

    private suspend fun connect(saved: TunnelSettings): TunnelStatus {
        // Asked only now: asking hands the VPN to this app, which turns another app's VPN off.
        val allowed = backend.hasPermission().also { permitted = it }
        if (!allowed) {
            close(closeReason(TunnelStatus.NeedsPermission))
            if (status != TunnelStatus.NeedsPermission) log.add("Waiting for Android's VPN permission")
            paths.moveTo(Path.NONE)
            return TunnelStatus.NeedsPermission
        }
        val fresh = upWith != saved.config
        // A wait already shown as failed stays so while it goes on, rather than starting over.
        if (fresh || (!answered && !gaveUp)) status = TunnelStatus.Connecting
        if (fresh || !answered) paths.moveTo(Path.NONE)
        if (fresh) log.add("Starting the tunnel to ${maskedEndpoints(saved.config)}")
        val failure = setUp(saved.config)
        return when {
            failure != null -> TunnelStatus.Failed(failure)
            !answered -> awaitAnswer()
            else -> {
                paths.moveTo(Path.TUNNEL)
                TunnelStatus.Connected
            }
        }
    }

    /**
     * Waits for the VPN server's first handshake: a running tunnel alone
     * carries nothing if the server never answers. After [handshakeMs] that is
     * shown as a failure, while WireGuard keeps trying until this is cancelled.
     * Progress goes to the log every few seconds, with the bytes sent and
     * received: sent with nothing back means the server is not answering. A
     * check on a network change picks the same wait up where it was.
     */
    private suspend fun awaitAnswer(): TunnelStatus {
        val started = waitingSince ?: System.currentTimeMillis().also {
            waitingSince = it
            log.add("Tunnel up, waiting for the VPN server to answer")
        }
        var reported = System.currentTimeMillis()
        var every = if (gaveUp) reportMs * QUIET_FACTOR else reportMs
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
        waitingSince = null
        gaveUp = false
        paths.moveTo(Path.TUNNEL)
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
     * Returns why it did not start, logged, or null.
     */
    private suspend fun setUp(config: String?): String? {
        if (config == upWith) return null
        val appOnly = try {
            config?.let { appOnlyTunnel(it, packageName) }
        } catch (e: TunnelConfigException) {
            log.add("Tunnel file not usable: ${e.message}")
            return e.message.orEmpty()
        }
        // Not cancelled half way by a newer check: a tunnel that came up or went down is
        // recorded as such, or it would be left running unseen, or thought up when it is not.
        val failure = withContext(NonCancellable) {
            try {
                if (appOnly != null) backend.up(appOnly) else backend.down()
            } catch (e: TunnelException) {
                return@withContext e
            }
            upWith = config
            answered = false
            waitingSince = null
            gaveUp = false
            if (config == null) stats = null
            null
        }
        failure?.let { e ->
            log.add("Tunnel did not start: ${e.message} (${e.cause?.let { it::class.simpleName + ": " + it.message } ?: "no detail"})")
        }
        return failure?.let { it.message.orEmpty() }
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

        /** What is logged on coming to each status without the tunnel. */
        val WITHOUT_TUNNEL = mapOf(
            TunnelStatus.OtherVpn to "Reached through another VPN, so the app's tunnel stays off",
            TunnelStatus.OtherVpnInTheWay to "Another VPN is on and does not reach the server. The tunnel would turn it off, " +
                "so it waits to be chosen in Settings",
            TunnelStatus.StoppedOutside to "The tunnel stays off until it is started in Settings",
        )

        /** The way to the server with each status without the tunnel; none for the rest. */
        val PATHS = mapOf(TunnelStatus.Home to Path.DIRECT, TunnelStatus.OtherVpn to Path.OTHER_VPN)

        /** What stays shown while a check runs, rather than "Checking". */
        val SETTLED = setOf(
            TunnelStatus.Home,
            TunnelStatus.OtherVpn,
            TunnelStatus.OtherVpnInTheWay,
            TunnelStatus.StoppedOutside,
            TunnelStatus.NeedsPermission,
            TunnelStatus.Connected,
        )
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

/**
 * Why the tunnel cannot be used at all, or null when it can. Android's VPN
 * permission is not asked here: asking turns another app's VPN off.
 */
private fun blocked(saved: TunnelSettings, url: String): TunnelStatus? = if (!saved.enabled || url.isBlank()) TunnelStatus.Off else null

private fun TunnelStats?.describe(): String =
    if (this == null) "no figures" else "sent $sentBytes bytes, received $receivedBytes bytes"
