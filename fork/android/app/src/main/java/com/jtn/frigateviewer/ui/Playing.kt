package com.jtn.frigateviewer.ui

import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import com.jtn.frigateviewer.data.AuthException
import java.net.HttpURLConnection.HTTP_UNAUTHORIZED

/**
 * Ends the signed-in session when its server turns away live video, a picture
 * or a recording as unauthorized, so an expired login goes back to sign-in
 * rather than failing quietly. Does nothing outside a session.
 */
internal val LocalSessionLost = staticCompositionLocalOf<() -> Unit> { {} }

/** How every player's sound is described to Android, so it takes and gives up audio focus like other video apps. */
internal val VideoAudio: AudioAttributes = AudioAttributes.Builder()
    .setUsage(C.USAGE_MEDIA)
    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
    .build()

/**
 * Whether [error], from a player or a request, means the server no longer
 * accepts this login: a 401. A 403 is not one: the account may not see that
 * camera, and signing in again would not change it.
 */
@OptIn(UnstableApi::class)
internal fun refusesSession(error: Throwable): Boolean = generateSequence(error) { it.cause }.take(MAX_CAUSES).any {
    it is AuthException || (it as? HttpDataSource.InvalidResponseCodeException)?.responseCode == HTTP_UNAUTHORIZED
}

/** Whether [player] is playing at this moment, following it as it starts, pauses, stalls and fails. */
@Composable
internal fun rememberIsPlaying(player: Player): Boolean {
    var playing by remember(player) { mutableStateOf(player.isPlaying) }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }
        }
        player.addListener(listener)
        playing = player.isPlaying
        onDispose { player.removeListener(listener) }
    }
    return playing
}

/** Enough of a cause chain to reach the response, without following a loop forever. */
private const val MAX_CAUSES = 8
