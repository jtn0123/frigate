package com.jtn.frigateviewer.tunnel

import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.ui.testSettingsStore
import java.io.File
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Android reports network changes on a thread of its own; the tunnel's state is only touched on its scope. */
@RunWith(RobolectricTestRunner::class)
class NetworkChangeTest {
    @get:Rule val temp = TemporaryFolder()

    private val backend = FakeBackend()
    private val route = FakeRoute(Reach.NOT_DIRECT)

    @Test
    fun aNetworkChangeOnAndroidsThreadIsHandedToTheScope() = runTest {
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), backgroundScope, StandardTestDispatcher(testScheduler))
        store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
        store.saveTunnel(TunnelSettings(tunnelFile(), "home", enabled = true))
        val clock = { testScheduler.currentTime }
        val log = TunnelLog(clock = clock)
        val remote = RemoteAccess(backgroundScope, store, backend, route, "com.jtn.frigateviewer", log = log, clock = clock)
            .also { it.start() }
        remote.foreground()
        advanceUntil { remote.status == TunnelStatus.Connected }
        val checks = route.checkedWithTunnel.size

        // ConnectivityManager calls back on a thread of its own.
        Thread { route.onChange!!() }.apply {
            start()
            join()
        }

        assertFalse("Nothing ran on Android's thread", remote.log.entries.any { it.text == "Networks changed" })
        assertEquals(checks, route.checkedWithTunnel.size)
        runCurrent()
        assertTrue(remote.log.entries.any { it.text == "Networks changed" })
        advanceUntil { route.checkedWithTunnel.size > checks }

        // The check it started is the one the background close cancels, so the close is not held up.
        remote.background()
        advanceUntil { backend.downs.get() == 1 }
    }
}
