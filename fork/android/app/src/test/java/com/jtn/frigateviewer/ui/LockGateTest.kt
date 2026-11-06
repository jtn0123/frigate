package com.jtn.frigateviewer.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The app lock covers the screens without closing them, and holds them paused meanwhile. */
@RunWith(RobolectricTestRunner::class)
class LockGateTest {
    @get:Rule val compose = createComposeRule()

    private var locked by mutableStateOf(true)
    private var taps = 0
    private var lifecycle: Lifecycle? = null

    /** A screen with state of its own, a full-size button, and the lifecycle it is given. */
    private fun show() {
        compose.setContent {
            LockGate(isLocked = { locked }, lock = { Text("Locked") }) {
                lifecycle = LocalLifecycleOwner.current.lifecycle
                var count by remember { mutableIntStateOf(0) }
                Box(Modifier.fillMaxSize()) {
                    Button(
                        onClick = {
                            taps++
                            count++
                        },
                        Modifier.fillMaxSize(),
                    ) { Text("Count $count") }
                }
            }
        }
    }

    @Test
    fun whileLockedTheScreensBeneathCannotBeReadOrTouched() {
        show()

        compose.onNodeWithText("Locked").assertExists()
        compose.onNodeWithText("Count 0").assertDoesNotExist()
        compose.onRoot().performTouchInput { click(center) }
        compose.runOnIdle { assertEquals(0, taps) }
    }

    @Test
    fun whileLockedTheScreensAreHeldStoppedAndResumeOnUnlock() {
        show()
        compose.runOnIdle { assertEquals(Lifecycle.State.CREATED, lifecycle?.currentState) }

        locked = false

        compose.runOnIdle { assertEquals(Lifecycle.State.RESUMED, lifecycle?.currentState) }
        compose.onNodeWithText("Locked").assertDoesNotExist()
    }

    @Test
    fun unlockingKeepsWhatTheScreensHeld() {
        locked = false
        show()
        compose.onNodeWithText("Count 0").performClick()
        compose.onNodeWithText("Count 1").assertExists()

        locked = true
        compose.onNodeWithText("Count 1").assertDoesNotExist()
        compose.runOnIdle { assertEquals(Lifecycle.State.CREATED, lifecycle?.currentState) }
        locked = false

        compose.onNodeWithText("Count 1").assertExists()
        compose.runOnIdle { assertEquals(Lifecycle.State.RESUMED, lifecycle?.currentState) }
    }
}
