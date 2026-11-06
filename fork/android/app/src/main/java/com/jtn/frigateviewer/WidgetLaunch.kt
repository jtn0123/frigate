package com.jtn.frigateviewer

import android.content.Context
import android.content.Intent
import android.util.Base64
import androidx.core.content.edit
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Proves an intent came from the app's own home screen widget. [MainActivity]
 * is exported, so any app could start it naming a camera; only the widget's
 * PendingIntent carries this install's random token, kept in the app's private
 * storage, and an intent without it is opened as an ordinary launch.
 */
object WidgetLaunch {
    /** The extra carrying the token. */
    const val EXTRA_TOKEN = "com.jtn.frigateviewer.widget_token"

    private const val PREFS = "widget_launch"
    private const val KEY = "token"
    private const val TOKEN_BYTES = 32

    /** This install's token, made the first time it is asked for. */
    @Synchronized
    fun token(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.let { return it }
        val bytes = ByteArray(TOKEN_BYTES).also(SecureRandom()::nextBytes)
        val token = Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE)
        prefs.edit { putString(KEY, token) }
        return token
    }

    /** Whether [intent] carries this install's token, compared in constant time. */
    fun isFromWidget(context: Context, intent: Intent): Boolean {
        val given = intent.getStringExtra(EXTRA_TOKEN) ?: return false
        return MessageDigest.isEqual(given.toByteArray(), token(context).toByteArray())
    }
}
