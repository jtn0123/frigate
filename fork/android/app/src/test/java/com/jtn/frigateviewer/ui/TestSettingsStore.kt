package com.jtn.frigateviewer.ui

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TokenCipher
import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers

/**
 * A settings store in [file], encrypting with a plain AES key since tests have no Android Keystore.
 * Reads run on [io]; pass the test's dispatcher to keep the store on virtual time.
 */
fun testSettingsStore(file: File, scope: CoroutineScope, io: CoroutineDispatcher = Dispatchers.IO): SettingsStore {
    val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    return SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { file }, TokenCipher { key }, io)
}
