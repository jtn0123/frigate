package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.ui.testSettingsStore
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What the tunnel costs while nothing is looking: how often it is read, and what keeps it up. */
@RunWith(RobolectricTestRunner::class)
class RemoteAccessBackgroundTest {
    @get:Rule val temp = TemporaryFolder()

    private val backend = FakeBackend()

    /** Reads of the tunnel's traffic, which the wait for the server's answer polls. */
    private val reads = AtomicInteger()
    private val counted = object : TunnelBackend by backend {
        override suspend fun stats(): TunnelStats = backend.stats().also { reads.incrementAndGet() }
    }

    /** Away from home with a tunnel to use, everything on virtual time. */
    private suspend fun TestScope.remote(idleMs: Long = 60_000, handshakeMs: Long = 15_000): RemoteAccess {
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), backgroundScope, StandardTestDispatcher(testScheduler))
        store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
        store.saveTunnel(TunnelSettings(tunnelFile(), "home", enabled = true))
        val clock = { testScheduler.currentTime }
        return RemoteAccess(
            backgroundScope,
            store,
            counted,
            FakeRoute(Reach.NOT_DIRECT),
            "com.jtn.frigateviewer",
            idleMs,
            handshakeMs,
            log = TunnelLog(clock = clock),
            clock = clock,
        ).also { it.start() }
    }

    @Test
    fun aWaitGivenUpOnReadsTheTunnelLessOftenUntilANewCheck() = runTest {
        backend.answers = false
        val remote = remote(handshakeMs = 2_000)
        remote.foreground()
        advanceUntil { remote.status is TunnelStatus.Failed }
        assertTrue("Read every half second while trying: ${reads.get()}", reads.get() >= 4)

        reads.set(0)
        elapse(60_000)
        assertEquals("Read every 5 s once given up", 12, reads.get())

        // A new check, as on a network change, is a new attempt: read closely again.
        reads.set(0)
        remote.check()
        elapse(1_000)
        assertEquals(3, reads.get())

        // Answered meanwhile, it is used at once.
        backend.answers = true
        elapse(500)
        assertEquals(TunnelStatus.Connected, remote.status)
    }

    @Test
    fun aHoldKeepsTheTunnelUpInTheBackgroundUntilItIsClosed() = runTest {
        val remote = remote(idleMs = 50)
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        // As while a clip saves after the app was left.
        val hold = remote.holds.hold()
        val other = remote.holds.hold()
        remote.background()
        elapse(60_000)
        assertEquals("Held, so not closed", 0, backend.downs.get())

        hold.close()
        hold.close()
        elapse(1_000)
        assertEquals("Closing one twice does not release the other", 0, backend.downs.get())
        other.close()
        runCurrent()
        assertEquals(1, backend.downs.get())
    }
}
