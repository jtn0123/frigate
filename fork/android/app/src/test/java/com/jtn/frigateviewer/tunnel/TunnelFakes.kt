package com.jtn.frigateviewer.tunnel

import com.wireguard.config.Config
import com.wireguard.crypto.KeyPair
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.withContext
import org.junit.Assert.fail

/** A tunnel file like UniFi's, with keys made for the test and documentation addresses. */
internal fun tunnelFile(
    extraInterface: String = "IncludedApplications = com.example.other",
    peer: String = "Endpoint = vpn.example.com:51820",
): String = """
    [Interface]
    PrivateKey = ${KeyPair().privateKey.toBase64()}
    Address = 192.168.2.2/32
    DNS = 192.168.2.1
    $extraInterface

    [Peer]
    PublicKey = ${KeyPair().publicKey.toBase64()}
    AllowedIPs = 0.0.0.0/0
    $peer
""".trimIndent()

/**
 * Records what the tunnel was asked to do. Volatile and atomic: tests change
 * and read these while RemoteAccess uses them on its own threads.
 */
internal class FakeBackend : TunnelBackend {
    @Volatile var permitted = true

    /** How often Android was asked for the VPN permission, which on a phone turns another app's VPN off. */
    val permissionAsks = AtomicInteger()

    @Volatile var failure: String? = null

    /** How long starting takes, without giving way to cancellation, as WireGuard's library does. */
    @Volatile var upMs = 0L

    /** What the failure was caused by, as the library would say it. */
    @Volatile var cause: Throwable? = null
    val ups = CopyOnWriteArrayList<Config>()

    /** Counted from the app's closes and from stops outside the app, which can come at once. */
    val downs = AtomicInteger()

    /** Whether the VPN server answers the tunnel's handshake. */
    @Volatile var answers = true

    override fun hasPermission(): Boolean {
        permissionAsks.incrementAndGet()
        return permitted
    }

    override suspend fun up(config: Config) {
        failure?.let { throw TunnelException(it, cause) }
        // Delayed on the caller's dispatcher, so tests on virtual time skip it.
        withContext(NonCancellable) {
            delay(upMs)
            ups += config
        }
        // As on return from the library's own thread: a caller cancelled meanwhile sees it here.
        currentCoroutineContext().ensureActive()
    }

    override suspend fun down() {
        downs.incrementAndGet()
    }

    @Volatile private var onStopped: () -> Unit = {}

    override fun watchStops(onStopped: () -> Unit) {
        this.onStopped = onStopped
    }

    /** The VPN goes down without the app asking, as when Android revokes it. */
    fun stopOutside() {
        downs.incrementAndGet()
        onStopped()
    }

    override suspend fun stats(): TunnelStats {
        val up = ups.size > downs.get()
        val answered = up && answers
        return TunnelStats(
            sentBytes = if (up) 148 else 0,
            receivedBytes = if (answered) 92 else 0,
            lastHandshakeMs = if (answered) 1L else null,
        )
    }
}

// Volatile: tests change these while RemoteAccess reads them on its own threads.
internal class FakeRoute(@Volatile var reach: Reach, @Volatile var otherVpn: Boolean = false) : DirectRoute {
    @Volatile var onChange: (() -> Unit)? = null

    /** Whether the app's tunnel was up for each check. */
    val checkedWithTunnel = CopyOnWriteArrayList<Boolean>()

    override suspend fun check(baseUrl: String, ownTunnelUp: Boolean): Probe {
        checkedWithTunnel += ownTunnelUp
        return Probe(reach, "test route: $reach${if (otherVpn) " through another VPN" else ""}", otherVpn)
    }

    override fun otherVpnOn(ownTunnelUp: Boolean) = otherVpn

    override fun watch(onChange: () -> Unit): AutoCloseable {
        this.onChange = onChange
        return AutoCloseable { this.onChange = null }
    }
}

/** Waits in real time, for tests whose work runs on real threads, such as the store's. */
internal fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
    val end = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        if (System.currentTimeMillis() > end) fail("Timed out waiting")
        Thread.sleep(10)
    }
}

/** Runs virtual time on [ms] and everything due by then. */
internal fun TestScope.elapse(ms: Long) {
    advanceTimeBy(ms)
    runCurrent()
}

/**
 * Runs virtual time on a step at a time until [condition] holds, failing
 * after [withinMs]. With everything on the test's dispatcher, the outcome
 * is the same on every run and machine.
 */
internal fun TestScope.advanceUntil(withinMs: Long = 120_000, condition: () -> Boolean) {
    runCurrent()
    val end = currentTime + withinMs
    while (!condition()) {
        if (currentTime >= end) fail("Not reached within $withinMs ms of virtual time")
        elapse(STEP_MS)
    }
}

private const val STEP_MS = 10L
