package com.jtn.frigateviewer.ui

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.jtn.frigateviewer.data.Camera
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import mockwebserver3.junit4.MockWebServerRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LiveGridTest {
    @get:Rule val compose = createComposeRule()

    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val names = listOf("a", "b", "c", "d", "e")

    private val config = names.joinToString(prefix = """{"cameras": {""", postfix = "}}") {
        """"$it": {"friendly_name": "Cam ${it.uppercase()}"}"""
    }

    private fun show(): AppViewModel = compose.showApp(serverRule.server, temp.root, scope) { request ->
        if (request.url.encodedPath == "/api/config") json(config) else null
    }

    private fun hasClickLabel(label: String) =
        SemanticsMatcher("click label $label") { it.config.getOrNull(SemanticsActions.OnClick)?.label == label }

    private fun choice(label: String) = hasText(label) and isToggleable()

    @Test
    fun theCamerasTabOpensTheFirstFourLive() {
        val vm = show()

        compose.onNodeWithContentDescription("Watch several live").performClick()

        compose.runOnIdle { assertEquals(Overlay.LiveGrid(), vm.nav.overlays.last()) }
        listOf("A", "B", "C", "D").forEach { compose.onNode(hasClickLabel("Open Cam $it")).assertExists() }
        compose.onNode(hasClickLabel("Open Cam E")).assertDoesNotExist()
    }

    @Test
    fun choosingCamerasAllowsFourAndShowsThem() {
        val vm = show()
        compose.runOnIdle { vm.nav.push(Overlay.LiveGrid()) }

        compose.onNodeWithContentDescription("Choose cameras").performClick()
        compose.onNode(choice("Cam E")).assertIsNotEnabled()
        compose.onNode(choice("Cam A")).performClick()
        compose.onNode(choice("Cam E")).performClick()
        compose.onNodeWithText("Show").performClick()

        compose.runOnIdle { assertEquals(Overlay.LiveGrid(listOf("b", "c", "d", "e")), vm.nav.overlays.single()) }
        compose.onNode(hasClickLabel("Open Cam E")).performClick()
        compose.runOnIdle { assertEquals(Overlay.CameraDetail("e"), vm.nav.overlays.last()) }
    }

    @Test
    fun goneCamerasFallBackToTheFirstFour() {
        val all = names.map { Camera(it, it, 0, true, emptyMap(), 0, 0) }

        assertEquals(listOf("e"), liveGridCameras(all, listOf("gone", "e")).map { it.name })
        assertEquals(listOf("a", "b", "c", "d"), liveGridCameras(all, listOf("gone")).map { it.name })
    }
}
