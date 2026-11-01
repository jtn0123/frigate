package com.jtn.frigateviewer

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The app as installed fresh: it opens to the sign-in screen. */
@RunWith(AndroidJUnit4::class)
class LaunchDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun aFreshInstallOpensToSignIn() {
        compose.waitUntil(LAUNCH_MS) { compose.onAllNodes(hasText("Server address")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Connect").assertExists()
    }

    private companion object {
        /** An emulator on CI can take a while for the first frame. */
        const val LAUNCH_MS = 15_000L
    }
}
