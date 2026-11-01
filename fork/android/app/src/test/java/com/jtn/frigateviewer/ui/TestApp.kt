package com.jtn.frigateviewer.ui

import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.WindowInfo
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import com.jtn.frigateviewer.data.MediaFiles
import com.jtn.frigateviewer.data.ServerSettings
import java.io.File
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.robolectric.Shadows.shadowOf

/** A JSON reply from the fake server. */
fun json(body: String, code: Int = 200): MockResponse = MockResponse.Builder().code(code).body(body).build()

/**
 * Shows the whole app, with its settings in [folder], signed in to [server], which answers with [routes] and
 * otherwise with an empty config, an empty review list or `{}`. [content] wraps the app, to provide what a test needs.
 */
fun ComposeContentTestRule.showApp(
    server: MockWebServer,
    folder: File,
    scope: CoroutineScope,
    saved: SavedStateHandle = SavedStateHandle(),
    settings: (ServerSettings) -> ServerSettings = { it },
    media: MediaFiles? = null,
    snapshots: Snapshots = Snapshots(),
    content: @Composable (AppViewModel) -> Unit = { App(it) },
    routes: (RecordedRequest) -> MockResponse? = { null },
): AppViewModel {
    server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = routes(request) ?: when (request.url.encodedPath) {
            "/api/config" -> json("""{"cameras": {}}""")
            "/api/review" -> json("[]")
            "/api/version" -> json("0.17.0")
            else -> json("{}")
        }
    }
    val settingsStore = testSettingsStore(File(folder, "server.preferences_pb"), scope)
    runBlocking { settingsStore.save(settings(ServerSettings(baseUrl = server.url("/").toString()))) }
    val vm = AppViewModel(saved, settingsStore, media = media, snapshots = snapshots)
    setContent { content(vm) }
    awaitMain { vm.cameras !is Remote.Loading && vm.reviews !is Remote.Loading }
    return vm
}

/**
 * Waits for [condition], running the main looper, where the view model's work
 * resumes after each request. The looper's clock moves on with real time, so
 * `delay` on the main thread finishes too. Composition effects run on the
 * rule's test dispatcher, which moves on a frame at a time with it.
 */
fun ComposeContentTestRule.awaitMain(timeoutMs: Long = 5_000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        check(System.currentTimeMillis() < deadline) { "Timed out" }
        Thread.sleep(10)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
        mainClock.advanceTimeByFrame()
    }
    waitForIdle()
}

/** Waits until a node with [text] shows. */
fun ComposeContentTestRule.awaitText(text: String, substring: Boolean = false) = awaitMain {
    onAllNodes(androidx.compose.ui.test.hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty()
}

/** [content] in a phone's window, held sideways when [landscape], or upright. */
@Composable
fun Phone(landscape: Boolean, content: @Composable () -> Unit) {
    val (width, height) = if (landscape) PHONE_LONG to PHONE_SHORT else PHONE_SHORT to PHONE_LONG
    Window(DpSize(width, height), content)
}

/** [content] in a window of [size]. */
@Composable
fun Window(size: DpSize, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val window = object : WindowInfo {
        override val isWindowFocused = true
        override val containerDpSize = size
        override val containerSize = with(density) { IntSize(size.width.roundToPx(), size.height.roundToPx()) }
    }
    CompositionLocalProvider(LocalWindowInfo provides window, content = content)
}

private val PHONE_SHORT = 400.dp
private val PHONE_LONG = 860.dp
