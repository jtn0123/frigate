package com.jtn.frigateviewer.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ServerSettings
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Live video in the floating window: only the picture, and a ratio Android accepts. */
@RunWith(RobolectricTestRunner::class)
class PipTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): Pair<AppViewModel, PipController> {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"driveway": {"friendly_name": "Driveway"}}}""")
                "/api/review" -> json("[]")
                else -> json("{}")
            }
        }
        val store = testSettingsStore(File(temp.root, "server.preferences_pb"), scope)
        runBlocking { store.save(ServerSettings(baseUrl = serverRule.server.url("/").toString())) }
        val vm = AppViewModel(SavedStateHandle(), store)
        val pip = PipController(compose.activity)
        compose.setContent { CompositionLocalProvider(LocalPip provides pip) { App(vm) } }
        compose.awaitMain { vm.cameras is Remote.Ready }
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        compose.waitForIdle()
        return vm to pip
    }

    @Test
    fun theFloatingWindowShowsOnlyTheVideo() {
        val (_, pip) = show()
        compose.onNodeWithContentDescription("Back").assertExists()
        compose.onNodeWithContentDescription("Fullscreen").assertExists()

        compose.runOnIdle { pip.inPip = true }

        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fullscreen").assertDoesNotExist()
        compose.onNodeWithContentDescription("Unmute").assertDoesNotExist()
    }

    @Test
    fun tappingTheVideoShowsItLargerUntilClosed() {
        show()
        val video = SemanticsMatcher("opens larger") {
            SemanticsActions.OnClick in it.config &&
                it.config[SemanticsActions.OnClick].label == "Show larger"
        }
        compose.onNode(video).performClick()

        // Alone and zoomable: the header and the camera's activity are gone, the stream plays on.
        compose.onNodeWithContentDescription("Back").assertDoesNotExist()
        compose.onNodeWithText("Activity · last 24 hours").assertDoesNotExist()
        compose.onNode(video).assertDoesNotExist()
        compose.onNodeWithContentDescription("Unmute").assertExists()

        compose.onNodeWithContentDescription("Close").performClick()
        compose.onNodeWithContentDescription("Back").assertExists()
        compose.onNode(video).assertExists()
    }

    @Test
    fun ratiosAreKeptWithinWhatAndroidAllows() {
        assertEquals(16f / 9f, rational(16f / 9f).toFloat(), 0.001f)
        assertEquals(2.39f, rational(4f).toFloat(), 0.001f)
        assertEquals(1 / 2.39f, rational(0.2f).toFloat(), 0.001f)
    }
}
