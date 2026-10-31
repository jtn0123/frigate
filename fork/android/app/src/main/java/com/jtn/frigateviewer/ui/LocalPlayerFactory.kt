package com.jtn.frigateviewer.ui

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.media3.exoplayer.ExoPlayer

/** Builds every video player the screens make; tests provide one that keeps hold of what it built. */
internal val LocalPlayerFactory = staticCompositionLocalOf<(ExoPlayer.Builder) -> ExoPlayer> { { it.build() } }
