package com.jtn.frigateviewer.ui

import android.app.Application
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.TunnelSettings
import com.jtn.frigateviewer.tunnel.FakeBackend
import com.jtn.frigateviewer.tunnel.FakeRoute
import com.jtn.frigateviewer.tunnel.Reach
import com.jtn.frigateviewer.tunnel.RemoteAccess
import com.jtn.frigateviewer.tunnel.tunnelFile
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.GraphicsMode

/** The Tunnel log: what the tunnel did, live, and the report to copy, over a fake tunnel. */
// Real text layout, so long entries wrap as on a phone.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@RunWith(RobolectricTestRunner::class)
class TunnelLogScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    /** The tunnel's state changes on the main thread, as in the app, so the screen follows it. */
    private val main = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val store by lazy { testSettingsStore(File(temp.root, "server.preferences_pb"), scope) }

    /** The tunnel file the screen shows the log of, private key included. */
    private val config = tunnelFile()

    @After
    fun tearDown() {
        main.cancel()
        scope.cancel()
    }

    /** Shows the log of a tunnel that is up, away from home, once it has connected. */
    private fun show(): RemoteAccess {
        runBlocking {
            store.save(ServerSettings(baseUrl = "http://192.168.1.20:5000/"))
            store.saveTunnel(TunnelSettings(config, "home", enabled = true))
        }
        val remote = RemoteAccess(main, store, FakeBackend(), FakeRoute(Reach.NOT_DIRECT), "com.jtn.frigateviewer", handshakeMs = 100)
            .also { it.start() }
        remote.foreground()
        val vm = AppViewModel(SavedStateHandle(), store, remoteAccess = remote)
        compose.setContent { TunnelLogScreen(vm, remote) }
        compose.awaitText("Away from home, connected through the tunnel.")
        return remote
    }

    @Test
    fun itShowsTheStatusTheTrafficAndEachEntry() {
        val remote = show()
        compose.awaitText("Sent 148 bytes, received 92 bytes", substring = true)
        assertTrue(remote.log.entries.isNotEmpty())
        // The list follows the newest entry, so the first may be scrolled out of view.
        val first = remote.log.entries.first().text
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(first, substring = true))
        // A slow runner can see a network change, so the same check may be logged twice.
        compose.onAllNodesWithText(first, substring = true).onFirst().assertExists()

        compose.runOnIdle { remote.log.add("Checked again after a network change") }

        compose.awaitText("Checked again after a network change", substring = true)
    }

    @Test
    fun aFullLogStillShowsAllOfTheNewestEntry() {
        val remote = show()
        compose.runOnIdle { repeat(FULL) { remote.log.add("Entry $it") } }
        compose.onNodeWithText("Entry ${FULL - 1}", substring = true).assertIsDisplayed()

        // Full, the log drops its oldest entry for each new one, so its size stays the same;
        // this one wraps over many lines where the one it replaces took one.
        val long = "Newest " + "and longer than a line ".repeat(LONG_REPEATS)
        compose.runOnIdle { remote.log.add(long) }

        // Its whole height, not only the part the list does not clip.
        val entry = compose.onNodeWithText(long, substring = true).fetchSemanticsNode()
        val window = compose.onRoot().fetchSemanticsNode().boundsInRoot
        assertTrue("The newest entry ends in view", entry.positionInRoot.y + entry.size.height <= window.bottom)
    }

    @Test
    fun clearLogEmptiesIt() {
        val remote = show()
        val first = remote.log.entries.first().text

        compose.onNodeWithContentDescription("Clear log").performClick()

        compose.awaitText("Nothing yet.", substring = true)
        compose.onNodeWithText(first, substring = true).assertDoesNotExist()
        assertTrue(remote.log.entries.isEmpty())
    }

    @Test
    fun copyReportPutsTheReportOnTheClipboardWithoutTheKey() {
        val remote = show()
        compose.runOnIdle { remote.log.add("Handshake sent") }
        val clipboard = ApplicationProvider.getApplicationContext<Context>()
            .getSystemService(ClipboardManager::class.java)

        compose.onNodeWithContentDescription("Copy report").performClick()

        compose.awaitMain { clipboard.hasPrimaryClip() }
        val report = clipboard.primaryClip!!.getItemAt(0).text.toString()
        assertTrue(report.startsWith("Frigate tunnel report"))
        assertTrue("Status: " in report)
        assertTrue("Handshake sent" in report)
        val privateKey = config.lines().first { it.trim().startsWith("PrivateKey") }.substringAfter("=").trim()
        assertFalse(privateKey in report)
        assertFalse("PrivateKey" in report)
    }

    @Test
    fun aQuickDoubleTapOnShareOpensOneShareSheet() {
        show()
        val app = shadowOf(ApplicationProvider.getApplicationContext<Application>())

        compose.onNodeWithContentDescription("Share report").performClick()
        compose.onNodeWithContentDescription("Share report").performClick()

        compose.awaitMain { app.peekNextStartedActivity() != null }
        assertEquals(Intent.ACTION_CHOOSER, app.nextStartedActivity.action)
        // Long enough for a second report to be built and sent.
        Thread.sleep(500)
        compose.waitForIdle()
        assertNull(app.nextStartedActivity)
    }

    @Test
    fun aQuickDoubleTapOnCopyCopiesOnce() {
        show()
        val clipboard = ApplicationProvider.getApplicationContext<Context>().getSystemService(ClipboardManager::class.java)
        var copies = 0
        clipboard.addPrimaryClipChangedListener { copies++ }

        compose.onNodeWithContentDescription("Copy report").performClick()
        compose.onNodeWithContentDescription("Copy report").performClick()

        compose.awaitMain { copies > 0 }
        Thread.sleep(500)
        compose.waitForIdle()
        assertEquals(1, copies)
    }

    private companion object {
        /** More entries than the log keeps. */
        const val FULL = 310
        const val LONG_REPEATS = 40
    }
}
