package com.jtn.frigateviewer.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Login
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.VideocamOff
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.jtn.frigateviewer.data.Camera
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.ui.AppTheme
import com.jtn.frigateviewer.ui.EmptyState
import com.jtn.frigateviewer.ui.FrigateTheme
import com.jtn.frigateviewer.ui.RemoteContent
import com.jtn.frigateviewer.ui.ScreenHeader
import com.jtn.frigateviewer.ui.TabSheet
import com.jtn.frigateviewer.ui.loadRemote
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Picks the camera for a new widget, or a different one for a placed widget. */
class WidgetSetupActivity : ComponentActivity() {
    private var cameras by mutableStateOf<Remote<List<Camera>>?>(Remote.Loading)
    private var theme by mutableStateOf(AppTheme.Default)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        // Backing out leaves no widget behind.
        setResult(RESULT_CANCELED, result(id))
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        enableEdgeToEdge()
        load()
        setContent {
            FrigateTheme(theme) {
                // The surface gives text the theme's color, as in the app.
                Surface(Modifier.fillMaxSize()) {
                    WidgetSetupScreen(cameras, onRetry = ::load, onClose = ::finish) { camera ->
                        WidgetChoices(this).set(id, WidgetChoice(camera.name, camera.label))
                        CameraWidget.requestUpdate(applicationContext, intArrayOf(id))
                        setResult(RESULT_OK, result(id))
                        finish()
                    }
                }
            }
        }
    }

    private fun load() {
        cameras = Remote.Loading
        lifecycleScope.launch {
            val store = SettingsStore.create(applicationContext)
            val settings = store.settings.first()
            theme = AppTheme.byId(settings.theme)
            cameras = if (settings.isConfigured && (settings.token.isNotEmpty() || settings.username.isEmpty())) {
                val session = Session.saving(settings) { change -> lifecycleScope.launch { store.save(change(store.settings.first())) } }
                loadRemote(onSessionLost = {}) { session.api.config().cameras.filter { it.enabled }.sortedBy { it.order } }
            } else {
                null
            }
        }
    }

    private fun result(id: Int) = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
}

/** The cameras to choose from; null [cameras] means nobody is signed in. */
@Composable
fun WidgetSetupScreen(
    cameras: Remote<List<Camera>>?,
    onRetry: () -> Unit,
    onClose: () -> Unit,
    onPick: (Camera) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        ScreenHeader(title = "Widget camera", subtitle = "Its latest picture and the alerts to review") {
            IconButton(onClick = onClose) { Icon(Icons.Outlined.Close, contentDescription = "Cancel") }
        }
        TabSheet {
            if (cameras == null) {
                EmptyState(
                    Icons.AutoMirrored.Outlined.Login,
                    "Not signed in",
                    detail = "Open Frigate and sign in, then add the widget again.",
                )
                return@TabSheet
            }
            RemoteContent(cameras, onRetry = onRetry) { list ->
                if (list.isEmpty()) {
                    EmptyState(Icons.Outlined.VideocamOff, "No cameras")
                    return@RemoteContent
                }
                Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding()) {
                    list.forEach { camera ->
                        Text(
                            camera.label,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(role = Role.Button) { onPick(camera) }
                                .padding(horizontal = 20.dp, vertical = 16.dp),
                        )
                        HorizontalDivider()
                    }
                }
            }
        }
    }
}
