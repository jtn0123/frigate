package com.jtn.frigateviewer

import android.app.Activity
import androidx.test.core.app.ApplicationProvider
import com.jtn.frigateviewer.ui.testSettingsStore
import java.io.File
import kotlinx.coroutines.CoroutineScope

/**
 * Gives the app under test a container with its settings in [folder], no
 * tunnel and no media files, and [unlock] in place of the system's prompt.
 */
fun installTestContainer(
    folder: File,
    scope: CoroutineScope,
    unlock: Activity.((Boolean, String?) -> Unit) -> Unit = {},
): AppContainer {
    val container = AppContainer(testSettingsStore(File(folder, "server.preferences_pb"), scope), null, { null }, unlock)
    ApplicationProvider.getApplicationContext<FrigateApp>().container = container
    return container
}
