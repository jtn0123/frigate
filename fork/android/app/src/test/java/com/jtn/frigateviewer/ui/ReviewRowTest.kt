package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionContains
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import coil3.ImageLoader
import com.jtn.frigateviewer.data.ReviewData
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.Session
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A review row reads as one button that says what, where and whether it was reviewed. */
@RunWith(RobolectricTestRunner::class)
class ReviewRowTest {
    @get:Rule val compose = createComposeRule()

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

    private fun show(item: ReviewItem, trackReviews: Boolean = true, onClick: () -> Unit = {}) = compose.setContent {
        ReviewRow(item, "Driveway", session, imageLoader, trackReviews = trackReviews, onClick = onClick)
    }

    @Test
    fun describesTheItemAndOpensIt() {
        var opened = 0
        show(item) { opened++ }

        compose.onNodeWithContentDescription("Person alert", substring = true)
            .assertContentDescriptionContains("Driveway · front yard", substring = true)
            .assertContentDescriptionContains("0:42 long", substring = true)
            .assertContentDescriptionContains("not reviewed", substring = true)
            .assertHasClickAction()
            .performClick()

        assertEquals(1, opened)
    }

    @Test
    fun saysNothingAboutReviewingWhenNotTracking() {
        show(item.copy(reviewed = true), trackReviews = false)

        compose.onNodeWithContentDescription("Person alert", substring = true)
            .assert(
                SemanticsMatcher("no review state") { node ->
                    node.config[SemanticsProperties.ContentDescription].none { "reviewed" in it }
                },
            )
    }
}
