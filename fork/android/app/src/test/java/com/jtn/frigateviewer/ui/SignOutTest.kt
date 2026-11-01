package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Signing out asks first, since it is one tap at the bottom of Settings. */
@RunWith(RobolectricTestRunner::class)
class SignOutTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun show(): AppViewModel {
        val vm = compose.showApp(serverRule.server, temp.root, scope, settings = { it.copy(username = "admin", token = "jwt1") })
        compose.runOnIdle { vm.nav.tab = Tab.SETTINGS }
        return vm
    }

    @Test
    fun cancelKeepsTheSession() {
        val vm = show()

        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.onNodeWithText("Sign out?").assertExists()
        compose.onNodeWithText("Cancel").performClick()

        compose.onNodeWithText("Sign out?").assertDoesNotExist()
        compose.runOnIdle { assertNotNull(vm.session) }
    }

    @Test
    fun confirmingSignsOut() {
        val vm = show()

        compose.onNodeWithText("Sign out").performScrollTo().performClick()
        compose.runOnIdle { assertNotNull("Not on the first tap", vm.session) }
        // The dialog's button, not the row behind it.
        compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()

        compose.awaitMain { vm.session == null }
    }
}
