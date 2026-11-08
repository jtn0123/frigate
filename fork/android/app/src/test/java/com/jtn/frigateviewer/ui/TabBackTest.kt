package com.jtn.frigateviewer.ui

import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Back from the Review or Settings tab returns to Cameras; only Cameras, or the lock, lets the app go. */
@RunWith(RobolectricTestRunner::class)
class TabBackTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var locked by mutableStateOf(false)

    /** Backs the app did not take, which would leave it. */
    private var leaves = 0

    @Before
    fun setUp() {
        // Added before the app's own, so it hears only the Back the app lets through.
        compose.activity.onBackPressedDispatcher.addCallback(
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    leaves++
                }
            },
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): AppViewModel = compose.showApp(
        serverRule.server,
        temp.root,
        scope,
        content = { vm -> LockGate(isLocked = { locked }, lock = { Text("Locked") }) { App(vm) } },
    )

    private fun back() = compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }

    @Test
    fun backOnAnotherTabReturnsToCameras() {
        val vm = show()

        listOf(Tab.REVIEW, Tab.SETTINGS).forEach { tab ->
            compose.runOnIdle { vm.nav.tab = tab }
            back()
            compose.runOnIdle { assertEquals(Tab.CAMERAS, vm.nav.tab) }
        }
        assertEquals("The app stays", 0, leaves)
    }

    @Test
    fun backOnCamerasLeavesTheApp() {
        val vm = show()

        back()

        assertEquals(1, leaves)
        compose.runOnIdle { assertEquals(Tab.CAMERAS, vm.nav.tab) }
    }

    @Test
    fun backClosesAPushedScreenBeforeLeavingItsTab() {
        val vm = show()
        compose.runOnIdle {
            vm.nav.tab = Tab.REVIEW
            vm.nav.push(Overlay.Health)
        }

        back()
        compose.runOnIdle {
            assertTrue(vm.nav.overlays.isEmpty())
            assertEquals(Tab.REVIEW, vm.nav.tab)
        }

        back()
        compose.runOnIdle { assertEquals(Tab.CAMERAS, vm.nav.tab) }
        assertEquals(0, leaves)
    }

    @Test
    fun backBehindTheLockLeavesTheAppAndTheTabAlone() {
        val vm = show()
        compose.runOnIdle {
            vm.nav.tab = Tab.REVIEW
            locked = true
        }

        back()

        assertEquals(1, leaves)
        compose.runOnIdle { assertEquals("Unlocking returns to the same tab", Tab.REVIEW, vm.nav.tab) }
    }
}
