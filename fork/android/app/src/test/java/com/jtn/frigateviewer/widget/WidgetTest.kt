package com.jtn.frigateviewer.widget

import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.R
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.FrigateApi
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.buildHttpClient
import com.jtn.frigateviewer.ui.json
import java.io.ByteArrayOutputStream
import java.time.Instant
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class WidgetTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val choice = WidgetChoice("front", "Front door")
    private val jpeg: ByteArray = ByteArrayOutputStream().also {
        Bitmap.createBitmap(16, 9, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it)
    }.toByteArray()

    private val paths = mutableListOf<String>()

    private fun api(code: Int = 200): FrigateApi {
        serverRule.server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths += request.url.encodedPath + "?" + request.url.encodedQuery
                return when {
                    code != 200 -> json("{}", code)
                    request.url.encodedPath == "/api/front/latest.jpg" ->
                        MockResponse.Builder().body(Buffer().write(jpeg)).build()
                    request.url.encodedPath == "/api/review" -> json(
                        """[${review("a", reviewed = false)}, ${review("b", reviewed = true)}, ${review("c", reviewed = false)}]""",
                    )
                    else -> json("{}")
                }
            }
        }
        return FrigateApi(buildHttpClient(null, null), serverRule.server.url("/").toString())
    }

    private fun review(id: String, reviewed: Boolean) =
        """{"id": "$id", "camera": "front", "start_time": 1, "severity": "alert", "has_been_reviewed": $reviewed, "thumb_path": "t.webp"}"""

    @Test
    fun loadsTheFrameAndCountsAlertsLeftToReview() {
        val content = runBlocking { api().widgetContents(listOf(choice), ServerSettings()).single() } as WidgetContent.Ready
        assertArrayEquals(jpeg, content.frame)
        assertEquals(2, content.toReview)
        assertTrue(paths.any { it.startsWith("/api/review?") && "severity=alert" in it })
    }

    @Test
    fun theAppLockKeepsThePictureOffTheHomeScreen() {
        val content = runBlocking { api().widgetContents(listOf(choice), ServerSettings(appLock = true)).single() } as WidgetContent.Ready
        assertNull(content.frame)
        assertTrue(paths.none { "latest.jpg" in it })
    }

    @Test
    fun noCountWhenReviewsAreNotTracked() {
        val content = runBlocking {
            api().widgetContents(listOf(choice), ServerSettings(trackReviews = false)).single()
        } as WidgetContent.Ready
        assertNull(content.toReview)
        assertTrue(paths.none { it.startsWith("/api/review") })
    }

    @Test
    fun anExpiredSessionAndAServerErrorAreTold() {
        assertEquals(WidgetContent.SignedOut, runBlocking { api(code = 401).widgetContents(listOf(choice), ServerSettings()).single() })
        assertTrue(runBlocking { api(code = 500).widgetContents(listOf(choice), ServerSettings()).single() } is WidgetContent.Failed)
    }

    private fun shown(choice: WidgetChoice?, content: WidgetContent?, settings: ServerSettings = ServerSettings()): View =
        CameraWidget.render(context, 7, choice, content, settings, Instant.ofEpochSecond(0)).apply(context, FrameLayout(context))

    private fun View.text(id: Int) = findViewById<TextView>(id)

    @Test
    fun showsTheCameraAndItsBadge() {
        val view = shown(choice, WidgetContent.Ready(jpeg, 3))
        assertEquals("Front door", view.text(R.id.widget_label).text)
        assertEquals("3", view.text(R.id.widget_badge).text)
        assertEquals(View.VISIBLE, view.text(R.id.widget_badge).visibility)
        assertEquals(View.GONE, view.text(R.id.widget_message).visibility)
        assertTrue(view.text(R.id.widget_status).text.startsWith("Updated"))
    }

    @Test
    fun capsTheBadgeAndHidesItAtZero() {
        assertEquals("99+", shown(choice, WidgetContent.Ready(jpeg, 150)).text(R.id.widget_badge).text)
        assertEquals(View.GONE, shown(choice, WidgetContent.Ready(jpeg, 0)).text(R.id.widget_badge).visibility)
    }

    @Test
    fun explainsAMissingPicture() {
        val locked = shown(choice, WidgetContent.Ready(null, 1), ServerSettings(appLock = true))
        assertEquals("Picture hidden while the app is locked", locked.text(R.id.widget_message).text)
        assertEquals("Choose a camera", shown(null, null).text(R.id.widget_message).text)
        assertEquals("Sign in to Frigate", shown(choice, WidgetContent.SignedOut).text(R.id.widget_message).text)
        val offline = shown(choice, WidgetContent.Failed("Server not found"))
        assertEquals("Offline · Server not found", offline.text(R.id.widget_status).text)
    }

    @Test
    fun awayFromHomeItSaysToOpenTheApp() {
        // The widget cannot bring the tunnel up itself; the app does when opened.
        val failed = WidgetContent.Failed("Server not found")
        assertEquals(failed, failed.awayIf(tunnelOn = false))
        val away = failed.awayIf(tunnelOn = true)
        assertEquals("Away from home · Open Frigate to connect", shown(choice, away).text(R.id.widget_status).text)
        assertEquals(WidgetContent.SignedOut, WidgetContent.SignedOut.awayIf(tunnelOn = true))
    }

    @Test
    fun remembersEachWidgetsCameraUntilItIsRemoved() {
        val choices = WidgetChoices(context)
        choices[1] = choice
        choices[2] = WidgetChoice("yard", "Yard")
        assertEquals(choice, WidgetChoices(context)[1])
        choices.forget(intArrayOf(1))
        assertNull(choices[1])
        assertEquals("Yard", choices[2]?.label)
    }

    @Test
    fun aFailureIsAFullUpdateUntilTheWidgetHasHadOne() {
        val choices = WidgetChoices(context)
        val failed = WidgetContent.Failed("Server not found")
        assertFalse(choices.shownSinceBoot(3))
        assertFalse("Never shown: a partial update would be ignored", CameraWidget.isPartial(failed, choices.shownSinceBoot(3)))

        choices.markShown(3)
        assertTrue("Shown: the last picture is kept", CameraWidget.isPartial(failed, choices.shownSinceBoot(3)))
        assertFalse(CameraWidget.isPartial(WidgetContent.Ready(jpeg, 0), shown = true))

        // After a restart the launcher has lost the widget's views.
        Settings.Global.putInt(context.contentResolver, Settings.Global.BOOT_COUNT, 5)
        assertFalse(choices.shownSinceBoot(3))
        choices.markShown(3)
        choices.forget(intArrayOf(3))
        assertFalse(choices.shownSinceBoot(3))
    }

    @Test
    fun setupListsTheCamerasToPickFrom() {
        var picked: Camera? = null
        val yard = Camera("yard", "Yard", 0, true, emptyMap(), 0, 0)
        compose.setContent { WidgetSetupScreen(Remote.Ready(listOf(yard)), onRetry = {}, onClose = {}) { picked = it } }
        compose.onNodeWithText("Yard").performClick()
        assertEquals(yard, picked)
    }

    @Test
    fun setupAsksToSignInFirst() {
        compose.setContent { WidgetSetupScreen(null, onRetry = {}, onClose = {}, onPick = {}) }
        compose.onNodeWithText("Not signed in").assertExists()
    }
}
