package com.jtn.frigateviewer

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.jtn.frigateviewer.ui.App
import com.jtn.frigateviewer.ui.AppViewModel
import com.jtn.frigateviewer.ui.FrigateTheme
import com.jtn.frigateviewer.ui.LocalPip
import com.jtn.frigateviewer.ui.LockGate
import com.jtn.frigateviewer.ui.LockScreen
import com.jtn.frigateviewer.ui.PipController
import com.jtn.frigateviewer.ui.Tab
import com.jtn.frigateviewer.ui.hideFromRecents
import com.jtn.frigateviewer.widget.CameraWidget

class MainActivity : ComponentActivity() {
    private val pip by lazy { PipController(this) }
    private val remoteAccess by lazy { container.remoteAccess }

    private val vm: AppViewModel by viewModels {
        viewModelFactory {
            initializer {
                AppViewModel(
                    createSavedStateHandle(),
                    container.settingsStore,
                    media = container.mediaFiles,
                    remoteAccess = remoteAccess,
                )
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Every theme is dark, so the bars' icons stay light whatever the system's own mode.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        // Once only: a recreated activity has already opened it.
        if (savedInstanceState == null) openFromWidget(intent)
        setContent {
            FrigateTheme(vm.theme) {
                LaunchedEffect(vm.appLock) { hideFromRecents(vm.appLock) }
                var reason by remember { mutableStateOf<String?>(null) }
                // The app stays beneath the lock, so unlocking returns to every screen as it was.
                LockGate(
                    isLocked = { vm.loaded && vm.appLock && vm.lock.locked },
                    lock = {
                        LockScreen(reason) {
                            container.unlock(this@MainActivity) { success, why ->
                                reason = why
                                if (success) vm.lock.unlocked()
                            }
                        }
                    },
                ) { locked ->
                    // Leaving the app from the lock screen must not float a video window.
                    CompositionLocalProvider(LocalPip provides pip.takeUnless { locked }) { App(vm) }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openFromWidget(intent)
    }

    /** A tapped widget opens its camera over the camera list; another app's intent naming one is ignored. */
    private fun openFromWidget(intent: Intent) {
        val camera = intent.getStringExtra(CameraWidget.EXTRA_CAMERA) ?: return
        if (!WidgetLaunch.isFromWidget(this, intent)) return
        vm.nav.clear()
        vm.nav.tab = Tab.CAMERAS
        vm.nav.openCamera(camera)
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pip.inPip = isInPictureInPictureMode
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        pip.onUserLeaveHint()
    }

    override fun onStart() {
        // Before super, which tells the screens they started: a lock due now holds them paused.
        vm.lock.onForeground()
        super.onStart()
        remoteAccess?.foreground()
    }

    override fun onStop() {
        super.onStop()
        vm.lock.onBackground()
        remoteAccess?.background()
        // Reviews may have been marked, so the widget's count is refreshed.
        CameraWidget.requestUpdate(applicationContext)
    }
}
