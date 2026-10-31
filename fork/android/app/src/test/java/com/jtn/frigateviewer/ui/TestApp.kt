package com.jtn.frigateviewer.ui

import android.content.res.Configuration
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.ComposeContentTestRule
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
    val vm = AppViewModel(saved, settingsStore, media = media)
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

/** [base] turned to landscape on a phone, or to portrait. */
internal fun rotated(base: Configuration, landscape: Boolean): Configuration = Configuration(base).apply {
    orientation = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
    screenWidthDp = if (landscape) PHONE_LONG_DP else PHONE_SHORT_DP
    screenHeightDp = if (landscape) PHONE_SHORT_DP else PHONE_LONG_DP
}

private const val PHONE_SHORT_DP = 400
private const val PHONE_LONG_DP = 860
