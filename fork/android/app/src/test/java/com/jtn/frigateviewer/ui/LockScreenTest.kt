package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LockScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun itAsksOnceOnItsOwnAndAgainOnUnlock() {
        var asked = 0
        compose.setContent { LockScreen(reason = null) { asked++ } }

        compose.onNodeWithText("Frigate is locked").assertExists()
        compose.runOnIdle { assertEquals(1, asked) }

        compose.onNodeWithText("Unlock").performClick()

        compose.runOnIdle { assertEquals(2, asked) }
    }

    @Test
    fun itSaysWhyUnlockingFailed() {
        compose.setContent { LockScreen(reason = "Too many attempts") {} }

        compose.onNodeWithText("Too many attempts").assertExists()
    }
}
