package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The sign-in form: its switch is one control, and an error goes away once the input changes. */
@RunWith(RobolectricTestRunner::class)
class LoginScreenTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val temp = TemporaryFolder()

    private val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        storeScope.cancel()
    }

    private fun viewModel() = AppViewModel(SavedStateHandle(), testSettingsStore(File(temp.root, "server.preferences_pb"), storeScope))

    private fun show(): AppViewModel {
        val vm = viewModel()
        compose.setContent { LoginScreen(vm) }
        return vm
    }

    private fun typed(label: String): Int =
        compose.onNodeWithText(label).fetchSemanticsNode().config[SemanticsProperties.EditableText].text.length

    @Test
    fun thePasswordIsNotKeptInSavedStateButTheRestIs() {
        val vm = viewModel()
        val restoration = StateRestorationTester(compose)
        restoration.setContent { LoginScreen(vm) }
        compose.onNodeWithText("Username (optional)").performTextReplacement("admin")
        compose.onNodeWithText("Password").performTextReplacement("secret")
        assertEquals(6, typed("Password"))

        restoration.emulateSavedInstanceStateRestore()

        compose.onNodeWithText("admin").assertExists()
        assertEquals("Saved state is written outside the encrypted settings", 0, typed("Password"))
    }

    @Test
    fun plainHttpToATailscaleAddressAsksFirst() {
        show()
        compose.onNodeWithText("Server address").performTextReplacement("http://100.101.102.103:5000")
        compose.onNodeWithText("Username (optional)").performTextReplacement("admin")
        compose.onNodeWithText("Password").performTextReplacement("secret")
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitUntil { compose.onAllNodes(hasTextContaining("used by Tailscale")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasTextContaining("100.101.102.103 is a shared address")).assertExists()

        compose.onNodeWithText("Cancel").performClick()

        compose.onNode(hasTextContaining("used by Tailscale")).assertDoesNotExist()
    }

    private val switch = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

    @Test
    fun theSelfSignedSwitchIsOneControlNamedByItsLabel() {
        show()

        val toggle = compose.onNode(switch and hasTextContaining("Self-signed certificate"))
        toggle.assertIsOff()
        toggle.performClick()
        toggle.assertIsOn()
    }

    @Test
    fun anErrorClearsWhenTheAddressIsEdited() {
        show()
        compose.onNodeWithText("Server address").performTextReplacement("http://example.com:5000")
        compose.onNodeWithText("Username (optional)").performTextReplacement("admin")
        compose.onNodeWithText("Password").performTextReplacement("secret")
        compose.onNodeWithText("Connect").performScrollTo().performClick()
        compose.waitUntil { compose.onAllNodes(hasTextContaining("not a local address")).fetchSemanticsNodes().isNotEmpty() }

        compose.onNodeWithText("Server address").performTextReplacement("http://nvr.lan:5000")

        compose.onNode(hasTextContaining("not a local address")).assertDoesNotExist()
    }

    private fun hasTextContaining(text: String) = androidx.compose.ui.test.hasText(text, substring = true)
}
