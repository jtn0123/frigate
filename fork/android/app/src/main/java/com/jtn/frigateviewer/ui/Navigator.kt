package com.jtn.frigateviewer.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle

enum class Tab { CAMERAS, REVIEW, SETTINGS }

/**
 * The selected tab and the screens pushed over it. Both are saved, so the user
 * returns to the same screen after Android stops the app in the background.
 */
class Navigator(private val saved: SavedStateHandle) {
    private var tabState by mutableStateOf(
        saved.get<String>(TAB_KEY)?.let { name -> Tab.entries.firstOrNull { it.name == name } } ?: Tab.CAMERAS,
    )
    var tab: Tab
        get() = tabState
        set(value) {
            tabState = value
            saved[TAB_KEY] = value.name
        }

    private val stack = mutableStateListOf<Overlay>().apply { addAll(decodeOverlays(saved[OVERLAYS_KEY])) }
    val overlays: List<Overlay> get() = stack

    fun push(overlay: Overlay) = update { add(overlay) }

    /** Replaces the topmost screen of [overlay]'s kind, or pushes it when there is none. */
    fun replace(overlay: Overlay) = update {
        val index = indexOfLast { it::class == overlay::class }
        if (index >= 0) set(index, overlay) else add(overlay)
    }

    /** Closes the top screen; false when only the tabs are left. */
    fun back(): Boolean {
        if (stack.isEmpty()) return false
        update { removeAt(lastIndex) }
        return true
    }

    /** Closes every pushed screen, keeping the tab. */
    fun clear() = update { clear() }

    fun openCamera(camera: String) = push(Overlay.CameraDetail(camera))

    fun openRecording(camera: String, minutes: Int) =
        push(Overlay.Recording(camera, minutes, System.currentTimeMillis() / MILLIS_PER_SECOND))

    private fun update(change: MutableList<Overlay>.() -> Unit) {
        stack.change()
        saved[OVERLAYS_KEY] = encodeOverlays(stack)
    }

    private companion object {
        const val TAB_KEY = "tab"
        const val OVERLAYS_KEY = "overlays"
        const val MILLIS_PER_SECOND = 1000
    }
}
