package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The Review tab with one alert: its counts read right for one, and its day header is big enough to tap. */
@RunWith(RobolectricTestRunner::class)
class ReviewTabTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val alert = """[{"id": "r1", "camera": "cam1", "start_time": ${System.currentTimeMillis() / 1000 - 60}, "end_time": null,
        "has_been_reviewed": false, "severity": "alert", "thumb_path": "/media/frigate/clips/review/r1.webp"}]"""

    private fun show() {
        val vm = compose.showApp(serverRule.server, temp.root, scope) { request ->
            when (request.url.encodedPath) {
                "/api/config" -> json("""{"cameras": {"cam1": {}}}""")
                "/api/review" -> json(alert)
                else -> null
            }
        }
        compose.runOnIdle { vm.nav.tab = Tab.REVIEW }
    }

    @Test
    fun oneAlertIsCountedInTheSingular() {
        show()

        compose.onNodeWithText("1 to review · last 24 hours").assertExists()
        compose.onNodeWithText("Alerts 1").assertExists()
        compose.onNodeWithText("Detections 0").assertExists()
        compose.onNodeWithContentDescription("Mark all as reviewed").performClick()
        compose.onNodeWithText("Mark 1 item as reviewed?").assertExists()
    }

    @Test
    fun aDayHeaderIsTallEnoughToTap() {
        show()

        compose.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded")).assertHeightIsAtLeast(48.dp)
    }
}
