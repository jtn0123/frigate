package com.jtn.frigateviewer.ui

import android.content.pm.ActivityInfo
import android.hardware.Sensor
import android.hardware.SensorManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.MockResponse
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSensor

/** Leaving fullscreen, Back in it, a camera's settings in it, and trying failed live video again. */
@RunWith(RobolectricTestRunner::class)
class FullscreenControlsTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** Every player the screens made, in order. */
    private val players = mutableListOf<ExoPlayer>()

    private var landscape by mutableStateOf(true)

    /** Two streams, so the camera has settings for anyone to open. */
    private val config = """
        {"cameras": {"driveway": {"friendly_name": "Driveway", "detect": {"width": 1280, "height": 720},
            "live": {"streams": {"Main": "driveway", "Sub": "driveway_sub"}}}}}
    """.trimIndent()

    private val review = """[{"id": "one", "camera": "driveway", "start_time": 1700000100.0, "end_time": 1700000110.0,
        "has_been_reviewed": false, "severity": "alert", "thumb_path": "/t/one.webp",
        "data": {"objects": ["person"], "zones": [], "audio": []}}]"""

    /** The live stream is refused while set, so the video gives up on it. */
    @Volatile private var liveFails = false

    @Before
    fun setUp() {
        // A phone has one, so the screen can wait for it to be turned before handing rotation back.
        val sensors = compose.activity.getSystemService(SensorManager::class.java)
        shadowOf(sensors).addSensor(ShadowSensor.newInstance(Sensor.TYPE_ACCELEROMETER))
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): AppViewModel = compose.showApp(
        serverRule.server,
        temp.root,
        scope,
        content = { vm ->
            CompositionLocalProvider(LocalPlayerFactory provides { builder -> builder.build().also(players::add) }) {
                Phone(landscape) { App(vm) }
            }
        },
    ) { request ->
        when (request.url.encodedPath) {
            "/api/config" -> json(config)
            "/api/review" -> json(review)
            "/live/mse/api/ws" -> if (liveFails) {
                MockResponse.Builder().code(404).build()
            } else {
                MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {}).build()
            }
            else -> null
        }
    }

    private fun back() = compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

    private fun requested() = compose.runOnIdle { compose.activity.requestedOrientation }

    @Test
    fun exitFullscreenWhileHeldSidewaysTurnsTheScreenUpright() {
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }

        compose.onNodeWithContentDescription("Exit fullscreen").performClick()

        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, requested())
    }

    @Test
    fun backInFullscreenLeavesItBeforeTheCamera() {
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()

        back()
        compose.runOnIdle { assertEquals(listOf(Overlay.CameraDetail("driveway")), vm.nav.overlays) }
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, requested())

        // The screen turns upright; Back now leaves the camera.
        compose.runOnIdle { landscape = false }
        compose.onNodeWithContentDescription("Fullscreen").assertExists()
        back()
        compose.runOnIdle { assertTrue(vm.nav.overlays.isEmpty()) }
    }

    @Test
    fun aScreenThatStaysSidewaysDoesNotTrapBack() {
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }

        back()
        back()

        compose.runOnIdle { assertTrue(vm.nav.overlays.isEmpty()) }
    }

    @Test
    fun backInAFullscreenRecordingLeavesItBeforeTheRecording() {
        val vm = show()
        compose.runOnIdle { vm.openEvent(vm.reviewById("one")!!) }
        compose.onNodeWithContentDescription("Exit fullscreen").assertExists()

        back()

        compose.runOnIdle { assertEquals(Overlay.Event("one"), vm.nav.overlays.last()) }
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, requested())
    }

    @Test
    fun settingsOpenInFullscreenAndStayOpenWhenThePhoneTurns() {
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }

        compose.onNodeWithContentDescription("Camera settings").performClick()
        compose.awaitText("Driveway settings")

        compose.runOnIdle { landscape = false }
        compose.onNodeWithText("Driveway settings").assertExists()
        compose.runOnIdle { landscape = true }
        compose.onNodeWithText("Driveway settings").assertExists()
    }

    @Test
    fun tappingTheStatusOfFailedLiveVideoTriesItAgain() {
        liveFails = true
        landscape = false
        val vm = show()
        compose.runOnIdle { vm.nav.openCamera("driveway") }
        val retryable = hasText("SNAPSHOT") and hasClickAction() and hasClickLabel("Retry live video")
        compose.awaitMain(timeoutMs = 20_000) { compose.onAllNodes(retryable).fetchSemanticsNodes().isNotEmpty() }
        val failedPlayers = compose.runOnIdle { players.size }
        val bounds = compose.onNode(retryable).fetchSemanticsNode().boundsInRoot
        assertTrue("The target is at least 48dp tall", bounds.height / compose.density.density >= 48f)

        liveFails = false
        compose.onNode(retryable).performClick()

        compose.awaitMain { players.size > failedPlayers }
        compose.onNodeWithText("CONNECTING").assertExists()
    }

    private fun hasClickLabel(label: String) = SemanticsMatcher("click label $label") {
        it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == label
    }
}
