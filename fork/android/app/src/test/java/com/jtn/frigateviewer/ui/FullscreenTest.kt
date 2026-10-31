package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Which devices held sideways show video alone, and which keep their controls. */
@RunWith(RobolectricTestRunner::class)
class FullscreenTest {
    @get:Rule val compose = createComposeRule()

    private var size by mutableStateOf(DpSize(400.dp, 860.dp))
    private var landscape = false
    private lateinit var setFullscreen: (Boolean) -> Unit

    private fun show() = compose.setContent {
        Window(size) {
            setFullscreen = rememberFullscreenToggle()
            landscape = isLandscape()
        }
    }

    @Test
    fun aPhoneSidewaysGoesFullscreenAndUprightDoesNot() {
        show()
        assertFalse(compose.runOnIdle { landscape })

        compose.runOnIdle { size = DpSize(860.dp, 400.dp) }
        assertTrue(compose.runOnIdle { landscape })
    }

    @Test
    fun aTabletSidewaysKeepsItsControlsUntilFullscreenIsAskedFor() {
        show()
        compose.runOnIdle { size = DpSize(1280.dp, 800.dp) }
        assertFalse(compose.runOnIdle { landscape })

        compose.runOnIdle { setFullscreen(true) }
        assertTrue(compose.runOnIdle { landscape })

        compose.runOnIdle { setFullscreen(false) }
        assertFalse(compose.runOnIdle { landscape })
    }
}
