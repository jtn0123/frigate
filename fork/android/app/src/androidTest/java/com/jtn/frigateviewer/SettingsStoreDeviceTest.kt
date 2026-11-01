package com.jtn.frigateviewer

import android.content.Context
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.TokenCipher
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The settings store on a device: the token saved encrypted with the Keystore
 * key and read back. Its own file, so the app's settings, and the launch test,
 * are left alone.
 */
@RunWith(AndroidJUnit4::class)
class SettingsStoreDeviceTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val file: File = context.preferencesDataStoreFile("smoke-test")

    @After
    fun tearDown() {
        scope.cancel()
        file.delete()
    }

    @Test
    fun aTokenIsSavedEncryptedAndReadBack() = runBlocking {
        val store = SettingsStore(PreferenceDataStoreFactory.create(scope = scope) { file }, TokenCipher.androidKeystore())
        val token = "a session token saved by the smoke test"
        store.save(ServerSettings(baseUrl = "https://frigate.example.com:8971/", username = "viewer", token = token))

        val read = store.settings.first()
        assertEquals(token, read.token)
        assertEquals("https://frigate.example.com:8971/", read.baseUrl)
        assertFalse("The token is not on disk in plain text", token in file.readBytes().decodeToString())
    }
}
