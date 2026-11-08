package com.jtn.frigateviewer.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A token an earlier version of the app saved in plain text is encrypted where it lies, and still signs in. */
class LegacyTokenTest {
    @get:Rule val temp = TemporaryFolder()

    private val file: File get() = File(temp.root, "server.preferences_pb")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val cipher = TokenCipher { key }

    /** The token as stored, under the key every version of the app has used. */
    private val tokenKey = stringPreferencesKey("token")

    private fun TestScope.dataStore() = PreferenceDataStoreFactory.create(scope = backgroundScope) { file }

    @Test
    fun aPlainTokenIsEncryptedAndStillReadsBack() = runTest {
        val dataStore = dataStore()
        dataStore.edit {
            it[stringPreferencesKey("base_url")] = "http://nvr:5000/"
            it[tokenKey] = "jwt-from-an-old-version"
        }
        val store = SettingsStore(dataStore, cipher)

        store.encryptLegacyToken()

        val stored = dataStore.data.first()[tokenKey].orEmpty()
        assertTrue("Encrypted: $stored", cipher.isEncrypted(stored))
        assertFalse("jwt-from-an-old-version" in stored)
        assertFalse("Not on disk in plain text", "jwt-from-an-old-version" in file.readBytes().decodeToString())
        val settings = store.settings.first()
        assertEquals("jwt-from-an-old-version", settings.token)
        assertEquals("http://nvr:5000/", settings.baseUrl)
    }

    @Test
    fun anEncryptedTokenIsLeftAsItIs() = runTest {
        val dataStore = dataStore()
        val store = SettingsStore(dataStore, cipher)
        store.save(ServerSettings(baseUrl = "http://nvr:5000/", username = "viewer", token = "jwt1"))
        val before = dataStore.data.first()[tokenKey]

        store.encryptLegacyToken()

        // Encrypting again would give new bytes for the same token.
        assertEquals(before, dataStore.data.first()[tokenKey])
        assertEquals("jwt1", store.settings.first().token)
    }

    @Test
    fun noTokenStaysNoToken() = runTest {
        val dataStore = dataStore()
        dataStore.edit { it[stringPreferencesKey("base_url")] = "http://nvr:5000/" }
        val store = SettingsStore(dataStore, cipher)

        store.encryptLegacyToken()

        assertNull(dataStore.data.first()[tokenKey])
        assertEquals("", store.settings.first().token)
    }
}
