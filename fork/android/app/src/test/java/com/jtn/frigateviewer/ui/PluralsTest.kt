package com.jtn.frigateviewer.ui

import android.content.Context
import android.graphics.Bitmap
import android.view.View
import android.widget.FrameLayout
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.tunnel.TunnelStats
import com.jtn.frigateviewer.widget.CameraWidget
import com.jtn.frigateviewer.widget.WidgetChoice
import com.jtn.frigateviewer.widget.WidgetContent
import java.io.ByteArrayOutputStream
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Counted text reads right for one as well as for more: "1 camera", not "1 cameras". */
@RunWith(RobolectricTestRunner::class)
class PluralsTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val context: Context = ApplicationProvider.getApplicationContext()

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun alert(id: String) = """{"id": "$id", "camera": "cam1", "start_time": ${System.currentTimeMillis() / 1000 - 60},
        "end_time": null, "has_been_reviewed": false, "severity": "alert", "thumb_path": "/media/frigate/clips/review/$id.webp"}"""

    /** The Cameras tab with [cameras] cameras and [alerts] unreviewed alerts. */
    private fun showCameras(cameras: Int, alerts: Int) {
        val config = (1..cameras).joinToString(prefix = """{"cameras": {""", postfix = "}}") { """"cam$it": {}""" }
        val reviews = (1..alerts).joinToString(prefix = "[", postfix = "]") { alert("r$it") }
        compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json(config)
                "/api/review" -> json(reviews)
                else -> null
            }
        }
    }

    @Test
    fun theHeaderCountsOneCameraAndOneAlert() {
        showCameras(cameras = 1, alerts = 1)
        compose.awaitText("1 camera · 1 alert to review")
    }

    @Test
    fun theHeaderCountsMoreCamerasAndAlerts() {
        showCameras(cameras = 2, alerts = 3)
        compose.awaitText("2 cameras · 3 alerts to review")
    }

    @Test
    fun theHeaderLeavesOutAlertsWhenNoneAreLeft() {
        assertEquals("1 camera", camerasSubtitle(1, 0).english())
        assertEquals("12 cameras", camerasSubtitle(12, 0).english())
    }

    private val jpeg: ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(16, 9, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it)
    }.toByteArray()

    private fun badgeDescription(toReview: Int): CharSequence? {
        val content = WidgetContent.Ready(jpeg, toReview)
        return CameraWidget.render(context, 7, WidgetChoice("front", "Front door"), content, ServerSettings(), Instant.EPOCH)
            .apply(context, FrameLayout(context))
            .findViewById<View>(R.id.widget_badge)
            .contentDescription
    }

    @Test
    fun theWidgetBadgeSaysOneAlertOrMore() {
        assertEquals("1 alert to review", badgeDescription(1))
        assertEquals("2 alerts to review", badgeDescription(2))
    }

    @Test
    fun aRecordingSaysOneMinuteOrHourInTheSingular() {
        assertEquals("Last 1 minute", recordingLabel(1).english())
        assertEquals("Last 15 minutes", recordingLabel(15).english())
        assertEquals("Last 1 hour", recordingLabel(60).english())
        assertEquals("Last 6 hours", recordingLabel(360).english())
    }

    @Test
    fun theTunnelsTrafficCountsOneByte() {
        val stats = TunnelStats(sentBytes = 1, receivedBytes = 2, lastHandshakeMs = null)
        assertEquals("Sent 1 byte, received 2 bytes · server has not answered", trafficText(stats).english())
    }
}
