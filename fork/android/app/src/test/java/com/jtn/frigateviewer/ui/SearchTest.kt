package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import com.jtn.frigateviewer.data.SearchFilter
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SearchTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val requests = CopyOnWriteArrayList<RecordedRequest>()

    @After
    fun tearDown() {
        scope.cancel()
    }

    // Noon UTC on 2026-10-30.
    private val now = Instant.ofEpochSecond(1_793_361_600)
    private val midnight = 1_793_318_400L

    @Test
    fun rangesCoverWholeDaysInTheLocalZone() {
        fun filter(inputs: SearchInputs): SearchFilter = inputs.filter(now, ZoneOffset.UTC)
        assertEquals(midnight to now.epochSecond, filter(SearchInputs(range = SearchRange.TODAY)).let { it.after to it.before })
        assertEquals(midnight - 86_400 to midnight, filter(SearchInputs(range = SearchRange.YESTERDAY)).let { it.after to it.before })
        assertEquals(now.epochSecond - 7 * 86_400, filter(SearchInputs()).after)
        val custom = filter(SearchInputs(range = SearchRange.CUSTOM, from = LocalDate.of(2026, 10, 1), to = LocalDate.of(2026, 10, 2)))
        assertEquals(LocalDate.of(2026, 10, 1).atStartOfDay(ZoneOffset.UTC).toEpochSecond(), custom.after)
        assertEquals(LocalDate.of(2026, 10, 3).atStartOfDay(ZoneOffset.UTC).toEpochSecond(), custom.before)
        assertEquals("van", filter(SearchInputs(query = "  van ")).query)
    }

    @Test
    fun theDatePickerOffersEveryDayUpToTodayHereWhateverTheZone() {
        // The picker's days are midnight UTC; today is 2026-10-31 here, whatever the time is in UTC.
        val today = LocalDate.of(2026, 10, 31)
        fun pickerDay(date: LocalDate) = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

        assertTrue(isPickableDay(pickerDay(today), today))
        assertTrue(isPickableDay(pickerDay(today.minusDays(30)), today))
        assertFalse(isPickableDay(pickerDay(today.plusDays(1)), today))
    }

    private val oldReview =
        """{"id": "r1", "camera": "front", "start_time": 1790000000, "end_time": 1790000030, "severity": "alert", "thumb_path": "t.webp", "data": {"objects": ["person"]}}"""

    private val foundVan =
        """{"id": "o1", "camera": "yard", "label": "car", "start_time": 1790000000, "data": {"description": "A white van parks"}}"""

    private fun show(semantic: Boolean = false): AppViewModel = compose.showApp(serverRule.server, temp.root, scope) { request ->
        requests += request
        when (request.url.encodedPath) {
            "/api/config" -> json(
                """{"cameras": {"front": {"friendly_name": "Front"}, "yard": {}}, "semantic_search": {"enabled": $semantic}}""",
            )
            "/api/labels" -> json("""["person", "car"]""")
            "/api/review" -> if (request.url.queryParameter("after") == null) null else json("[$oldReview]")
            "/api/events/search" -> json("[$foundVan]")
            "/api/review/event/o1" -> json(oldReview)
            else -> null
        }
    }

    private val isChip = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)

    private fun chip(label: String) = hasText(label) and isChip

    /** A result row, whose text review rows give as one description; label chips can share it. */
    private fun row(text: String) = (hasText(text) or hasContentDescription(text, substring = true)) and hasClickAction() and !isChip

    private fun awaitRow(text: String) = compose.awaitMain { compose.onAllNodes(row(text)).fetchSemanticsNodes().isNotEmpty() }

    private fun searches(path: String) = requests.filter { it.url.encodedPath == path && it.url.queryParameter("before") != null }

    /** Waits for a search with [param] set to [value]; recomposing runs it. */
    private fun awaitSearch(param: String, value: String) = compose.awaitMain {
        compose.waitForIdle()
        searches("/api/review").any { it.url.queryParameter(param) == value }
    }

    @Test
    fun theReviewTabSearchesOlderItemsByCameraAndLabel() {
        val vm = show()
        compose.runOnIdle { vm.nav.tab = Tab.REVIEW }

        compose.onNodeWithContentDescription("Search older").performClick()
        awaitRow("Person")
        compose.onNode(chip("Front")).performClick()
        awaitSearch("cameras", "front")
        compose.awaitMain { compose.onAllNodes(chip("Car")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(chip("Car")).performClick()
        awaitSearch("labels", "car")
        awaitRow("Person")

        compose.onNode(row("Person")).performClick()
        compose.runOnIdle { assertEquals(Overlay.Event("r1"), vm.nav.overlays.last()) }
    }

    @Test
    fun describingWhatToFindNeedsSemanticSearch() {
        val vm = show(semantic = false)
        compose.runOnIdle { vm.nav.push(Overlay.Search) }
        awaitRow("Person")
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
    }

    @Test
    fun aDescriptionFindsObjectsThatOpenTheirReview() {
        val vm = show(semantic = true)
        compose.runOnIdle { vm.nav.push(Overlay.Search) }
        awaitRow("Person")

        compose.onNode(hasSetTextAction()).performTextInput("white van")
        compose.onNode(hasSetTextAction()).performImeAction()
        compose.awaitText("A white van parks")
        assertTrue(searches("/api/events/search").any { it.url.queryParameter("query") == "white van" })

        compose.onNode(row("A white van parks")).performClick()
        compose.awaitMain { vm.nav.overlays.last() == Overlay.Event("r1") }
    }
}
