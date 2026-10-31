package com.jtn.frigateviewer.ui

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.NightsStay
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class EmptyStateTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun itShowsInsideAScrollingList() {
        compose.setContent {
            LazyColumn { item { EmptyState(Icons.Outlined.NightsStay, "All quiet", detail = "Nothing happened.") } }
        }

        compose.onNodeWithText("All quiet").assertExists()
    }

    @Test
    fun itsActionRuns() {
        var retried = 0
        compose.setContent {
            EmptyState(Icons.Outlined.NightsStay, "Couldn't load this", action = EmptyAction("Retry") { retried++ })
        }

        compose.onNodeWithText("Retry").performClick()

        assertEquals(1, retried)
    }
}
