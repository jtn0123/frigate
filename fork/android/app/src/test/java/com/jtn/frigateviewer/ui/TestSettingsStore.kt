package com.jtn.frigateviewer.ui

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TokenCipher
import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope

/** A settings store in [file], encrypting with a plain AES key since tests have no Android Keystore. */
fun testSettingsStore(file: File, scope: CoroutineScope): SettingsStore {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    return SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { file }, TokenCipher { key })
}
