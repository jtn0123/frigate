package com.jtn.frigateviewer.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import com.jtn.frigateviewer.ui.testSettingsStore
import java.io.File
import java.io.IOException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The saved settings survive a damaged file, and signing out sticks. */
class SettingsStoreTest {
    @get:Rule val temp = TemporaryFolder()

    private val file: File get() = File(temp.root, "server.preferences_pb")

    private fun TestScope.store() = testSettingsStore(file, backgroundScope, StandardTestDispatcher(testScheduler))

    /** A store over [data], as when the file cannot be read at all. */
    private fun failing(data: Flow<Preferences>): SettingsStore {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val dataStore = object : DataStore<Preferences> {
            override val data = data

            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences =
                throw IOException("Not writable")
        }
        return SettingsStore(dataStore, TokenCipher { key })
    }

    @Test
    fun aDamagedFileStartsOverSignedOutRatherThanCrashing() = runTest {
        file.writeBytes(byteArrayOf(0x7f, 0x00, 0x13, 0x37, 0x42))
        val store = store()

        assertEquals(ServerSettings(), store.settings.first())
        assertNull(store.tunnel.first())

        // And it can be used again.
        store.save(ServerSettings(baseUrl = "http://nvr:5000/"))
        assertEquals("http://nvr:5000/", store.settings.first().baseUrl)
    }

    @Test
    fun anUnreadableFileReadsAsNoSettings() = runTest {
        val store = failing(flow { throw IOException("Read failed") })

        assertEquals(ServerSettings(), store.settings.first())
        assertNull(store.tunnel.first())
    }

    @Test
    fun aBugIsNotMistakenForAnUnreadableFile() = runTest {
        val store = failing(flow { throw IllegalStateException("A bug") })

        val failure = runCatching { store.settings.first() }.exceptionOrNull()

        assertTrue("Expected the bug, got $failure", failure is IllegalStateException)
    }

    @Test
    fun signingOutOfAServerWithNoLoginIsNotUndoneOnTheNextLaunch() = runTest {
        val store = store()
        val noLogin = ServerSettings(baseUrl = "http://192.168.1.20:5000/")
        store.save(noLogin)
        assertTrue(store.settings.first().canResume)

        store.clearSession()

        val signedOut = store.settings.first()
        assertTrue(signedOut.signedOut)
        assertFalse("Not resumed", signedOut.canResume)
        assertEquals("The address is kept for signing in again", noLogin.baseUrl, signedOut.baseUrl)

        // A preference saved meanwhile does not sign back in.
        store.update { it.copy(gridColumns = 2) }
        assertFalse(store.settings.first().canResume)

        // Signing in again clears it.
        store.save(signedOut.copy(signedOut = false))
        assertTrue(store.settings.first().canResume)
    }
}
