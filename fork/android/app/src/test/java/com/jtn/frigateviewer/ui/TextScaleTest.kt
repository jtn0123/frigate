package com.jtn.frigateviewer.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import coil3.ImageLoader
import com.jtn.frigateviewer.data.ReviewData
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** With the phone's text made larger, figures and rows make room for it rather than cutting it off. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w360dp-h800dp-xxhdpi")
class TextScaleTest {
    @get:Rule val compose = createComposeRule()

    /** [content] themed as in the app, with text at [fontScale] times its size. */
    private fun show(fontScale: Float, content: @Composable () -> Unit) = compose.setContent {
        CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
            FrigateTheme { content() }
        }
    }

    /** A camera's three figures, as its screen shows them. */
    private fun showStats(fontScale: Float) = show(fontScale) {
        StatRow(Modifier.fillMaxWidth()) {
            Stat("Alerts", "12", Color.Red) {}
            Stat("Detections", "140", Color.Yellow) {}
            Stat("Last activity", "None", Color.White)
        }
    }

    private fun layout(text: String): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }

    /**
     * Whether all of [text] shows: no line runs past the width it is given, and none
     * falls below its height. A text that wraps its content is laid out at the width
     * it may take and then measured to its longest line, so `hasVisualOverflow` does
     * not tell.
     */
    private fun fits(text: String): Boolean {
        val layout = layout(text)
        return !layout.didOverflowHeight && (0 until layout.lineCount).all { layout.getLineRight(it) <= layout.size.width }
    }

    /** Where [text] starts down the screen. */
    private fun top(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).getUnclippedBoundsInRoot().top

    @Test
    fun figuresSitSideBySideAtTheUsualSize() {
        showStats(fontScale = 1f)

        assertEquals("One row", 1, listOf("Alerts", "Detections", "Last activity").map(::top).distinct().size)
        listOf("Alerts", "Detections", "Last activity", "None").forEach { assertTrue("$it is cut off", fits(it)) }
        // Each as tall as the others, whatever its label.
        val alerts = compose.onNode(clickLabel("Show Alerts")).getUnclippedBoundsInRoot()
        val detections = compose.onNode(clickLabel("Show Detections")).getUnclippedBoundsInRoot()
        assertEquals(alerts.bottom - alerts.top, detections.bottom - detections.top)
        assertEquals(alerts.right - alerts.left, detections.right - detections.left)
    }

    @Test
    fun figuresStackWhenTwiceTheSizeWouldCutThemOff() {
        showStats(fontScale = 2f)

        listOf("Alerts", "Detections", "Last activity", "12", "140", "None").forEach { text ->
            assertTrue("$text is cut off", fits(text))
            assertEquals("$text breaks no word", 1, layout(text).lineCount)
        }
        val tops = listOf("Alerts", "Detections", "Last activity").map(::top)
        assertTrue("One above another: $tops", tops.zipWithNext().all { (above, below) -> below > above })
    }

    private fun clickLabel(label: String) = SemanticsMatcher("clicks to $label") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == label
    }

    private val session = Session(ServerSettings(baseUrl = "http://nvr.lan:5000/"), onTokenRenewed = {})
    private val imageLoader = ImageLoader(ApplicationProvider.getApplicationContext())

    private val item = ReviewItem(
        id = "1",
        camera = "driveway",
        startTime = 1_700_000_000.0,
        endTime = 1_700_000_042.0,
        severity = "alert",
        thumbPath = "/media/frigate/clips/review/thumb-driveway-1.webp",
        data = ReviewData(objects = listOf("person"), zones = listOf("front_yard")),
    )

    private fun showRow(fontScale: Float) = show(fontScale) {
        ReviewRow(item, "Driveway", session, imageLoader, onClick = {})
    }

    private val row = SemanticsMatcher("the review row") { SemanticsActions.OnClick in it.config }

    @Test
    fun aReviewRowKeepsItsHeightAtTheUsualSize() {
        showRow(fontScale = 1f)
        // The 68dp picture and 8dp of padding above and below.
        compose.onNode(row).assertHeightIsEqualTo(84.dp)
    }

    @Test
    fun aReviewRowGrowsWithLargeText() {
        var needed = 0.dp
        show(fontScale = 2f) {
            // Its two lines of text as tall as they are drawn, the 4dp between them and the padding.
            val measurer = rememberTextMeasurer()
            val typography = MaterialTheme.typography
            val title = measurer.measure("Person", typography.bodyLarge).size.height
            val where = measurer.measure("Driveway", typography.bodyMedium).size.height
            val lines = title + where
            needed = with(LocalDensity.current) { lines.toDp() } + 4.dp + 16.dp
            ReviewRow(item, "Driveway", session, imageLoader, onClick = {})
        }

        assertTrue("Taller than the picture: $needed", needed > 84.dp)
        compose.onNode(row).assertHeightIsAtLeast(needed)
        compose.onNodeWithContentDescription("Person alert", substring = true).assertExists()
    }

    @Test
    fun aNarrowRowOfFiguresStillStacks() {
        show(fontScale = 1f) {
            StatRow(Modifier.width(150.dp)) {
                Stat("Alerts", "12", Color.Red)
                Stat("Detections", "140", Color.Yellow)
            }
        }
        assertTrue(top("Detections") > top("Alerts"))
    }
}
